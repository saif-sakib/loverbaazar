package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"regexp"
	"sort"
	"strings"
	"sync/atomic"
	"time"
	"unicode"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"
)

var phoneRe = regexp.MustCompile(`^01[3-9]\d{8}$`)

const maxQty = 20

// outStatuses are the order statuses that have given their stock back.
const outStatuses = `('cancelled','returned')`

// normPhone accepts how people really type numbers: Bangla digits, spaces, dashes and +88 or 88.
func normPhone(p string) string {
	var b strings.Builder
	for _, c := range p {
		switch {
		case c >= '০' && c <= '৯':
			b.WriteRune('0' + (c - '০'))
		case unicode.IsDigit(c):
			b.WriteRune(c)
		}
	}
	s := b.String()
	if len(s) == 13 && strings.HasPrefix(s, "88") {
		s = s[2:]
	}
	return s
}

// Zone, Pay and Live are the settings the server itself must obey. They take effect at once.
type Zone struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Fee   int64  `json:"fee"`
	Days  string `json:"days"`
}

// Pay is a payment option. One with a Number is manual: the customer sends money and gives a transaction ID.
type Pay struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Number  string `json:"number"`
	Enabled bool   `json:"enabled"`
}

type Live struct {
	OrdersOpen bool   `json:"ordersOpen"`
	ClosedNote string `json:"closedNote"`
	Notice     string `json:"notice"`
	Delivery   []Zone `json:"delivery"`
	Payments   []Pay  `json:"payments"`
	FreeOver   int64  `json:"freeOver"`
	MinOrder   int64  `json:"minOrder"`
	LowStock   int    `json:"lowStock"`
	ShowLeft   bool   `json:"showLeft"`
	MaxPending int    `json:"maxPending"`
}

// loadSettings overlays what the admin saved on defaults.json, so a new setting works without a migration.
func loadSettings(ctx context.Context) (Live, map[string]any, error) {
	var d struct {
		Live Live           `json:"live"`
		Site map[string]any `json:"site"`
	}
	if err := json.Unmarshal(defaultsJSON, &d); err != nil {
		return d.Live, nil, err
	}
	words, _ := d.Site["copy"].(map[string]any)
	rows, err := db.Query(ctx, `SELECT key,data::text FROM settings`)
	if err != nil {
		return d.Live, nil, err
	}
	var key, data string
	_, err = pgx.ForEachRow(rows, []any{&key, &data}, func() error {
		if key == "live" {
			return json.Unmarshal([]byte(data), &d.Live)
		}
		return json.Unmarshal([]byte(data), &d.Site)
	})
	// Saved words replace the defaults as a whole, so a phrase added later would otherwise be blank.
	if saved, isMap := d.Site["copy"].(map[string]any); isMap && err == nil {
		for k, v := range words {
			if _, has := saved[k]; !has {
				saved[k] = v
			}
		}
	}
	return d.Live, d.Site, err
}

// refresh rebuilds the snapshots after a write. It takes no request context: a customer closing
// the page must not leave the shop showing old stock.
func refresh() {
	catalogSnap.Store(nil)
	storefrontSnap.Store(nil)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := publishStock(ctx); err != nil {
		log.Print("stock snapshot: ", err)
	}
}

// publishStock refreshes what browsers read: {products:{id:[price,regular,stock]},settings:{...}}.
// Stock is capped at 99 so the shop's real quantities stay private.
func publishStock(ctx context.Context) error {
	snapMu.Lock() // one at a time, so an older snapshot can never replace a newer one
	defer snapMu.Unlock()
	var products []byte
	if err := db.QueryRow(ctx, `SELECT coalesce(jsonb_object_agg(id,jsonb_build_array(price,regular,LEAST(stock,99))),'{}')::text FROM products WHERE active`).Scan(&products); err != nil {
		return err
	}
	live, _, err := loadSettings(ctx)
	if err != nil {
		return err
	}
	b, err := json.Marshal(map[string]any{"products": json.RawMessage(products), "settings": live})
	if err == nil {
		stockSnap.Store(&b)
	}
	return err
}

func stockFile(w http.ResponseWriter, r *http.Request) {
	if stockSnap.Load() == nil {
		if err := publishStock(r.Context()); err != nil {
			oops(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Write(*stockSnap.Load())
}

// serveSnap answers from memory, so nobody can wake the database by reloading a public URL.
func serveSnap(w http.ResponseWriter, r *http.Request, snap *atomic.Pointer[[]byte], load func(context.Context) ([]byte, error)) {
	b := snap.Load()
	if b == nil {
		fresh, err := load(r.Context())
		if err != nil {
			oops(w, err)
			return
		}
		snap.Store(&fresh)
		b = &fresh
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(*b)
}

func catalog(w http.ResponseWriter, r *http.Request) {
	serveSnap(w, r, &catalogSnap, func(ctx context.Context) ([]byte, error) {
		list, err := jsonRows(ctx, `SELECT p.data||jsonb_build_object('price',p.price,'regular',p.regular,'inStock',p.stock>0,
			'reviews',coalesce((SELECT jsonb_agg(jsonb_build_object('name',r.name,'rating',r.rating,'body',r.body,'date',r.created_at::date) ORDER BY r.id DESC)
				FROM reviews r WHERE r.product_id=p.id AND r.approved),'[]'::jsonb))
			FROM products p WHERE p.active ORDER BY p.id DESC`)
		if err != nil {
			return nil, err
		}
		return json.Marshal(list)
	})
}

// storefront is everything else the static build needs: site settings, categories, pages and posts.
func storefront(w http.ResponseWriter, r *http.Request) {
	serveSnap(w, r, &storefrontSnap, func(ctx context.Context) ([]byte, error) {
		live, site, err := loadSettings(ctx)
		if err != nil {
			return nil, err
		}
		out := map[string]any{"site": site, "live": live}
		for key, kind := range map[string]string{"cats": "cat", "tags": "tag", "pages": "page", "posts": "post"} {
			if out[key], err = jsonRows(ctx, `SELECT data FROM content WHERE kind=$1 AND coalesce(data->>'draft','')<>'true' ORDER BY coalesce(data->>'date','') DESC,slug`, kind); err != nil {
				return nil, err
			}
		}
		return json.Marshal(out)
	})
}

type item struct {
	ID  int64 `json:"id"`
	Qty int   `json:"qty"`
}

// mergeItems joins repeated lines and sorts by id. Every order then locks products in the same
// sequence, so two orders sharing products can never deadlock.
func mergeItems(in []item) ([]item, error) {
	qty := map[int64]int{}
	for _, it := range in {
		if it.Qty < 1 {
			return nil, userErr{400, "please check the quantities in your cart"}
		}
		qty[it.ID] += it.Qty
	}
	out := make([]item, 0, len(qty))
	for id, q := range qty {
		if q > maxQty {
			return nil, userErr{400, fmt.Sprintf("you can order up to %d of one item online. Please call us for more", maxQty)}
		}
		out = append(out, item{id, q})
	}
	sort.Slice(out, func(a, b int) bool { return out[a].ID < out[b].ID })
	return out, nil
}

func discountOf(kind string, value, sub int64) int64 {
	d := value
	if kind == "percent" {
		d = sub * value / 100
	}
	return min(d, sub)
}

// deliveryFee is what the customer pays for a zone once any discount is taken off.
func deliveryFee(z Zone, live Live, goods int64) int64 {
	if live.FreeOver > 0 && goods >= live.FreeOver {
		return 0
	}
	return z.Fee
}

// useCoupon claims one use with a relative update, so a limited coupon can never be over-used.
func useCoupon(ctx context.Context, tx pgx.Tx, code string, sub int64) (int64, error) {
	var kind string
	var value int64
	err := tx.QueryRow(ctx, `UPDATE coupons SET used=used+1 WHERE code=$1 AND active AND (expires_at IS NULL OR expires_at>now())
		AND (max_uses=0 OR used<max_uses) AND min_order<=$2 RETURNING kind,value`, code, sub).Scan(&kind, &value)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, userErr{400, "that coupon is not valid for this order"}
	}
	return discountOf(kind, value, sub), err
}

func couponPreview(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code  string `json:"code"`
		Items []item `json:"items"`
	}
	if !read(w, r, &in) {
		return
	}
	items, err := mergeItems(in.Items)
	if err != nil {
		oops(w, err)
		return
	}
	if len(items) > 50 {
		fail(w, 400, "your cart is too large")
		return
	}
	ctx := r.Context()
	var sub int64
	for _, it := range items {
		var price int64
		if err := db.QueryRow(ctx, `SELECT price FROM products WHERE id=$1 AND active`, it.ID).Scan(&price); err == nil {
			sub += price * int64(it.Qty)
		}
	}
	var kind string
	var value int64
	if err = db.QueryRow(ctx, `SELECT kind,value FROM coupons WHERE code=$1 AND active AND (expires_at IS NULL OR expires_at>now())
		AND (max_uses=0 OR used<max_uses) AND min_order<=$2`, strings.ToUpper(clip(in.Code, 40)), sub).Scan(&kind, &value); err != nil {
		fail(w, 400, "that coupon is not valid for this order")
		return
	}
	ok(w, map[string]any{"discount": discountOf(kind, value, sub)})
}

func checkout(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Items                                            []item `json:"items"`
		Name, Phone, Address, Area, Payment, TxnID, Note string
		Coupon, Key                                      string
		Expected                                         int64
		Turnstile                                        string `json:"turnstile"`
	}
	if !read(w, r, &in) {
		return
	}
	in.Phone, in.Name, in.Address = normPhone(in.Phone), clip(in.Name, 100), clip(in.Address, 500)
	in.TxnID, in.Note, in.Coupon, in.Key = clip(in.TxnID, 60), clip(in.Note, 500), strings.ToUpper(clip(in.Coupon, 40)), clip(in.Key, 64)
	switch {
	case len(in.Items) == 0 || len(in.Items) > 50:
		fail(w, 400, "your cart is empty")
		return
	case in.Name == "" || len([]rune(in.Address)) < 5:
		fail(w, 400, "please enter your name and full address")
		return
	case !phoneRe.MatchString(in.Phone):
		fail(w, 400, "please enter a valid Bangladeshi mobile number")
		return
	}
	items, err := mergeItems(in.Items)
	if err != nil {
		oops(w, err)
		return
	}
	ctx := r.Context()
	// A retry after a lost connection gets the first order back, not a second one.
	if in.Key != "" {
		var number string
		var total int64
		if db.QueryRow(ctx, `SELECT number,total FROM orders WHERE idem=$1`, in.Key).Scan(&number, &total) == nil {
			ok(w, map[string]any{"number": number, "total": total})
			return
		}
	}
	live, _, err := loadSettings(ctx)
	if err != nil {
		oops(w, err)
		return
	}
	if !live.OrdersOpen {
		fail(w, 503, live.ClosedNote)
		return
	}
	var zone *Zone
	for i := range live.Delivery {
		if live.Delivery[i].ID == in.Area {
			zone = &live.Delivery[i]
		}
	}
	var pay *Pay
	for i := range live.Payments {
		if live.Payments[i].ID == in.Payment && live.Payments[i].Enabled {
			pay = &live.Payments[i]
		}
	}
	switch {
	case zone == nil:
		fail(w, 400, "please choose a delivery area")
		return
	case pay == nil:
		fail(w, 400, "please choose a payment method")
		return
	case pay.Number != "" && len(in.TxnID) < 6:
		fail(w, 400, "please enter your transaction ID")
		return
	}
	if err = fraudCheck(ctx, live, in.Phone, pay.Number != "", in.TxnID); err != nil {
		oops(w, err)
		return
	}
	if !human(r, in.Turnstile) {
		fail(w, 403, "bot check failed, please try again")
		return
	}
	// Before the transaction: the pool is small, and a query needing a second connection while
	// holding the first can leave busy checkouts waiting on each other for ever.
	var uid *int64
	if id := userID(r); id != 0 {
		uid = &id
	}
	var idem *string
	if in.Key != "" {
		idem = &in.Key
	}
	number := "LB-" + token(4)
	var total int64
	repeat := false
	err = pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		var oid int64
		err := tx.QueryRow(ctx, `INSERT INTO orders(number,user_id,name,phone,address,area,payment,txn_id,note,subtotal,shipping,total,idem)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,0,$10) ON CONFLICT(idem) DO NOTHING RETURNING id`,
			number, uid, in.Name, in.Phone, in.Address, zone.Label, pay.Label, in.TxnID, in.Note, idem).Scan(&oid)
		if errors.Is(err, pgx.ErrNoRows) { // the same order arrived twice at once
			repeat = true
			return tx.QueryRow(ctx, `SELECT number,total FROM orders WHERE idem=$1`, in.Key).Scan(&number, &total)
		} else if err != nil {
			return err
		}
		var sub, discount int64
		for _, it := range items {
			var price int64
			var name string
			// A relative update under a row lock: two buyers can never both take the last unit.
			err := tx.QueryRow(ctx, `UPDATE products SET stock=stock-$1 WHERE id=$2 AND active AND stock>=$1 RETURNING price,data->>'name'`, it.Qty, it.ID).Scan(&price, &name)
			if errors.Is(err, pgx.ErrNoRows) {
				return soldOut(ctx, tx, it.ID)
			} else if err != nil {
				return err
			}
			sub += price * int64(it.Qty)
			if _, err = tx.Exec(ctx, `INSERT INTO order_items VALUES($1,$2,$3,$4,$5)`, oid, it.ID, name, price, it.Qty); err != nil {
				return err
			}
		}
		if sub < live.MinOrder {
			return userErr{400, fmt.Sprintf("the minimum online order is ৳%d", live.MinOrder)}
		}
		if in.Coupon != "" {
			if discount, err = useCoupon(ctx, tx, in.Coupon, sub); err != nil {
				return err
			}
		}
		fee := deliveryFee(*zone, live, sub-discount)
		total = sub - discount + fee
		if in.Expected != 0 && in.Expected != total {
			return userErr{409, fmt.Sprintf("the total changed to ৳%d. Please check your order and try again", total)}
		}
		if _, err = tx.Exec(ctx, `INSERT INTO order_events(order_id,status) VALUES($1,'pending')`, oid); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE orders SET subtotal=$1,discount=$2,coupon=$3,shipping=$4,total=$5 WHERE id=$6`, sub, discount, in.Coupon, fee, total, oid)
		return err
	})
	if err != nil {
		oops(w, err)
		return
	}
	if repeat {
		ok(w, map[string]any{"number": number, "total": total})
		return
	}
	refresh()
	go notify(fmt.Sprintf("New order %s: ৳%d", number, total), fmt.Sprintf("%s, %s, %s (%s, %s)", in.Name, in.Phone, in.Address, zone.Label, pay.Label))
	ok(w, map[string]any{"number": number, "total": total})
}

// fraudCheck covers what guest checkout leaves open. Anyone can type any number, so one number can
// only hold a few unconfirmed orders, which stops fake orders tying up the stock. A mobile payment
// is only a typed-in ID until the admin checks it, so one ID can't pay for two orders.
func fraudCheck(ctx context.Context, live Live, phone string, manual bool, txn string) error {
	if live.MaxPending > 0 {
		var n int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM orders WHERE phone=$1 AND status='pending'`, phone).Scan(&n); err != nil {
			return err
		}
		if n >= live.MaxPending {
			return userErr{429, "this number already has orders waiting for confirmation. Please call us to order more"}
		}
	}
	if manual {
		var used bool
		err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM orders WHERE upper(txn_id)=upper($1) AND status NOT IN `+outStatuses+`)`, txn).Scan(&used)
		if err != nil {
			return err
		}
		if used {
			return userErr{409, "that transaction ID is already on another order. Please check it"}
		}
	}
	return nil
}

// soldOut names the product, so the customer knows which one to take out of the cart.
func soldOut(ctx context.Context, tx pgx.Tx, id int64) error {
	var name string
	var left int
	if tx.QueryRow(ctx, `SELECT data->>'name',stock FROM products WHERE id=$1 AND active`, id).Scan(&name, &left) != nil {
		return userErr{409, "an item in your cart is no longer available"}
	}
	if left == 0 {
		return userErr{409, name + " just sold out"}
	}
	return userErr{409, fmt.Sprintf("only %d left of %s", left, name)}
}

func human(r *http.Request, tok string) bool {
	secret := os.Getenv("TURNSTILE_SECRET")
	if secret == "" {
		return true
	}
	body, _ := json.Marshal(map[string]string{"secret": secret, "response": tok, "remoteip": clientIP(r)})
	res, err := httpClient.Post("https://challenges.cloudflare.com/turnstile/v0/siteverify", "application/json", bytes.NewReader(body))
	if err != nil {
		log.Print("turnstile: ", err)
		return false
	}
	defer res.Body.Close()
	var out struct{ Success bool }
	json.NewDecoder(res.Body).Decode(&out)
	return out.Success
}

// notify emails the shop through Brevo. Call it with `go`: a slow or failed email must never hold up an order.
func notify(subject, text string) {
	key, to := os.Getenv("BREVO_KEY"), os.Getenv("SHOP_EMAIL")
	if key == "" || to == "" {
		return
	}
	b, _ := json.Marshal(map[string]any{"sender": map[string]string{"email": to, "name": "LoverBaazar"}, "to": []map[string]string{{"email": to}}, "subject": subject, "textContent": text})
	req, _ := http.NewRequest("POST", "https://api.brevo.com/v3/smtp/email", bytes.NewReader(b))
	req.Header.Set("api-key", key)
	req.Header.Set("Content-Type", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		log.Print("brevo: ", err)
		return
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		log.Print("brevo: status ", res.StatusCode)
	}
}

// orderFields is what a customer may see. adminOrderFields adds the shop's private notes.
const orderFields = `jsonb_build_object('number',o.number,'name',o.name,'phone',o.phone,'address',o.address,'area',o.area,'payment',o.payment,'txn_id',o.txn_id,'note',o.note,
 'subtotal',o.subtotal,'discount',o.discount,'coupon',o.coupon,'shipping',o.shipping,'total',o.total,'status',o.status,'courier',o.courier,'tracking',o.tracking,'created_at',o.created_at,
 'items',(SELECT jsonb_agg(jsonb_build_object('id',i.product_id,'name',i.name,'price',i.price,'qty',i.qty)) FROM order_items i WHERE i.order_id=o.id),
 'events',(SELECT jsonb_agg(jsonb_build_object('status',e.status,'at',e.at) ORDER BY e.at) FROM order_events e WHERE e.order_id=o.id))`

func orderJSON(ctx context.Context, where string, args ...any) ([]json.RawMessage, error) {
	return jsonRows(ctx, `SELECT `+orderFields+` FROM orders o WHERE `+where+` ORDER BY o.created_at DESC LIMIT 200`, args...)
}

func track(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	list, err := orderJSON(r.Context(), `o.number=$1 AND o.phone=$2`, strings.ToUpper(strings.TrimSpace(q.Get("order"))), normPhone(q.Get("phone")))
	if err != nil {
		oops(w, err)
		return
	}
	if len(list) == 0 {
		fail(w, 404, "no order matches that number and phone")
		return
	}
	ok(w, list[0])
}

func contact(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name, Contact, Body, Website string }
	if !read(w, r, &in) {
		return
	}
	if in.Website != "" { // a field people cannot see, so only bots fill it in
		done(w)
		return
	}
	in.Name, in.Contact, in.Body = clip(in.Name, 100), clip(in.Contact, 100), clip(in.Body, 2000)
	if in.Name == "" || in.Contact == "" || len([]rune(in.Body)) < 5 {
		fail(w, 400, "please fill in every field")
		return
	}
	if _, err := db.Exec(r.Context(), `INSERT INTO messages(name,contact,body) VALUES($1,$2,$3)`, in.Name, in.Contact, in.Body); err != nil {
		oops(w, err)
		return
	}
	go notify("Website message from "+in.Name, in.Contact+"\n\n"+in.Body)
	done(w)
}

// review waits for the admin to approve it, then appears on the product page at the next Publish.
func review(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Product             int64
		Rating              int
		Name, Body, Website string
	}
	if !read(w, r, &in) {
		return
	}
	if in.Website != "" {
		done(w)
		return
	}
	in.Name, in.Body = clip(in.Name, 60), clip(in.Body, 1000)
	if in.Name == "" || len([]rune(in.Body)) < 5 || in.Rating < 1 || in.Rating > 5 {
		fail(w, 400, "please add your name, a rating and a few words")
		return
	}
	tag, err := db.Exec(r.Context(), `INSERT INTO reviews(product_id,name,rating,body) SELECT id,$2,$3,$4 FROM products WHERE id=$1 AND active`, in.Product, in.Name, in.Rating, in.Body)
	if err != nil {
		oops(w, err)
		return
	}
	if tag.RowsAffected() == 0 {
		fail(w, 404, "that product is no longer available")
		return
	}
	done(w)
}

func register(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name, Phone, Password string }
	if !read(w, r, &in) {
		return
	}
	in.Phone, in.Name = normPhone(in.Phone), clip(in.Name, 100)
	if in.Name == "" || !phoneRe.MatchString(in.Phone) || len(in.Password) < 8 || len(in.Password) > 72 {
		fail(w, 400, "enter your name, a valid mobile number and a password of 8+ characters")
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), 10)
	if err != nil {
		oops(w, err)
		return
	}
	var id int64
	err = db.QueryRow(r.Context(), `INSERT INTO users(name,phone,password_hash) VALUES($1,$2,$3) ON CONFLICT(phone) DO NOTHING RETURNING id`, in.Name, in.Phone, string(hash)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 409, "that number already has an account")
		return
	} else if err != nil {
		oops(w, err)
		return
	}
	startSession(w, r, id)
}

func login(w http.ResponseWriter, r *http.Request) {
	var in struct{ Phone, Password string }
	if !read(w, r, &in) {
		return
	}
	var id int64
	var hash string
	err := db.QueryRow(r.Context(), `SELECT id,password_hash FROM users WHERE phone=$1`, normPhone(in.Phone)).Scan(&id, &hash)
	if err != nil || bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Password)) != nil {
		fail(w, 401, "wrong mobile number or password")
		return
	}
	startSession(w, r, id)
}

func changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct{ Old, New string }
	if !read(w, r, &in) {
		return
	}
	id := userID(r)
	if id == 0 {
		fail(w, 401, "please log in again")
		return
	}
	if len(in.New) < 8 || len(in.New) > 72 {
		fail(w, 400, "the new password needs 8+ characters")
		return
	}
	var hash string
	if err := db.QueryRow(r.Context(), `SELECT password_hash FROM users WHERE id=$1`, id).Scan(&hash); err != nil {
		oops(w, err)
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(in.Old)) != nil {
		fail(w, 401, "your current password is wrong")
		return
	}
	if err := setPassword(r.Context(), id, in.New); err != nil {
		oops(w, err)
		return
	}
	startSession(w, r, id)
}

// setPassword also ends every session, so a stolen phone or an old login stops working.
func setPassword(ctx context.Context, id int64, password string) error {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), 10)
	if err != nil {
		return err
	}
	if _, err = db.Exec(ctx, `UPDATE users SET password_hash=$1 WHERE id=$2`, string(hash), id); err != nil {
		return err
	}
	_, err = db.Exec(ctx, `DELETE FROM sessions WHERE user_id=$1`, id)
	return err
}

func hashTok(t string) string { s := sha256.Sum256([]byte(t)); return hex.EncodeToString(s[:]) }

func startSession(w http.ResponseWriter, r *http.Request, id int64) {
	t := token(32)
	exp := time.Now().Add(30 * 24 * time.Hour)
	ctx := r.Context()
	db.Exec(ctx, `DELETE FROM sessions WHERE expires_at<now()`)
	if _, err := db.Exec(ctx, `INSERT INTO sessions VALUES($1,$2,$3)`, hashTok(t), id, exp); err != nil {
		oops(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "sid", Value: t, Path: "/api", Expires: exp, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: !dev})
	done(w)
}

func userID(r *http.Request) int64 {
	c, err := r.Cookie("sid")
	if err != nil {
		return 0
	}
	var id int64
	db.QueryRow(r.Context(), `SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>now()`, hashTok(c.Value)).Scan(&id)
	return id
}

func logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie("sid"); err == nil {
		db.Exec(r.Context(), `DELETE FROM sessions WHERE token_hash=$1`, hashTok(c.Value))
	}
	http.SetCookie(w, &http.Cookie{Name: "sid", Path: "/api", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: !dev})
	done(w)
}

func me(w http.ResponseWriter, r *http.Request) {
	id := userID(r)
	if id == 0 {
		fail(w, 401, "not logged in")
		return
	}
	var name, phone string
	if err := db.QueryRow(r.Context(), `SELECT name,phone FROM users WHERE id=$1`, id).Scan(&name, &phone); err != nil {
		oops(w, err)
		return
	}
	orders, err := orderJSON(r.Context(), `o.user_id=$1`, id)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]any{"name": name, "phone": phone, "orders": orders})
}
