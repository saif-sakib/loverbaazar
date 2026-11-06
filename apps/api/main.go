// LoverBaazar API. A single stateless HTTP server: runs on Render, a VPS or AWS unchanged.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
)

//go:embed schema.sql
var schema string

var (
	db      *pgxpool.Pool
	stock   atomic.Pointer[[]byte] // price and stock snapshot, so browsing never wakes the database
	errGone = errors.New("out of stock")
	phoneRe = regexp.MustCompile(`^01[3-9]\d{8}$`)
)

func main() {
	ctx := context.Background()
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		log.Fatal(err)
	}
	cfg.MinConns, cfg.MaxConns, cfg.MaxConnIdleTime = 0, 2, 2*time.Minute // lets Neon sleep
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec           // PgBouncer transaction mode
	if db, err = pgxpool.NewWithConfig(ctx, cfg); err != nil {
		log.Fatal(err)
	}
	if len(os.Args) == 3 && os.Args[1] == "seed" {
		must(seed(ctx, os.Args[2]))
		return
	}
	h := router()
	addr := "127.0.0.1:8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	log.Fatal(http.ListenAndServe(addr, h))
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func seed(ctx context.Context, file string) error {
	if _, err := db.Exec(ctx, schema); err != nil {
		return err
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return err
	}
	var list []map[string]any
	if err = json.Unmarshal(b, &list); err != nil {
		return err
	}
	for _, p := range list {
		stock := 0
		if p["inStock"] == true {
			stock = 100 // WooCommerce's public API hides quantities: set the real ones in admin
		}
		j, _ := json.Marshal(p)
		if _, err = db.Exec(ctx, `INSERT INTO products(id,slug,price,regular,stock,data) VALUES($1,$2,$3,$4,$5,$6::jsonb)
			ON CONFLICT(id) DO NOTHING`, int64(p["id"].(float64)), p["slug"], int64(p["price"].(float64)), int64(p["regular"].(float64)), stock, string(j)); err != nil {
			return err
		}
	}
	return nil
}

func router() http.Handler {
	r := chi.NewRouter()
	r.Use(originGuard)
	r.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	r.Get("/api/catalog", catalog)
	r.Get("/api/stock", stockFile)
	r.Post("/api/checkout", checkout)
	r.Get("/api/track", track)
	r.Post("/api/contact", contact)
	r.Post("/api/register", register)
	r.Post("/api/login", login)
	r.Post("/api/logout", logout)
	r.Get("/api/me", me)
	r.Route("/api/admin", func(a chi.Router) {
		a.Use(adminOnly)
		a.Get("/orders", adminOrders)
		a.Put("/orders/{number}", adminOrderStatus)
		a.Get("/products", adminProducts)
		a.Put("/products/{id}", adminSaveProduct)
		a.Post("/products/{id}", adminSaveProduct)
		a.Delete("/products/{id}", adminDeleteProduct)
		a.Get("/messages", adminMessages)
		a.Post("/image", adminImage)
		a.Post("/publish", adminPublish)
	})
	return r
}

// originGuard rejects requests that did not come through the Cloudflare Worker.
func originGuard(next http.Handler) http.Handler {
	want := os.Getenv("ORIGIN_SECRET")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if want != "" && !same(r.Header.Get("X-Origin-Secret"), want) {
			fail(w, 403, "forbidden")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func adminOnly(next http.Handler) http.Handler {
	want := os.Getenv("ADMIN_TOKEN")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if len(want) < 32 || !same(r.Header.Get("X-Admin-Token"), want) {
			fail(w, 401, "admin token required")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }
func ok(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}
func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}
func read(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		fail(w, 400, "invalid request")
		return false
	}
	return true
}
func oops(w http.ResponseWriter, err error) {
	log.Print(err)
	fail(w, 500, "something went wrong, please call us")
}
func token(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}
func normPhone(p string) string {
	p = strings.NewReplacer(" ", "", "-", "", "+88", "").Replace(strings.TrimSpace(p))
	return p
}
func shipping(area string) int64 {
	env := map[string]string{"dhaka": "SHIP_DHAKA", "outside": "SHIP_OUTSIDE"}[area]
	n, err := strconv.ParseInt(os.Getenv(env), 10, 64)
	if err != nil {
		return map[string]int64{"dhaka": 60, "outside": 120}[area] // placeholders until the shop confirms its rates
	}
	return n
}

func catalog(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(r.Context(), `SELECT data||jsonb_build_object('price',price,'regular',regular,'inStock',stock>0) FROM products WHERE active ORDER BY id DESC`)
	if err != nil {
		oops(w, err)
		return
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list)
}

type item struct {
	ID  int64 `json:"id"`
	Qty int   `json:"qty"`
}

func checkout(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Items                                            []item `json:"items"`
		Name, Phone, Address, Area, Payment, TxnID, Note string
		Turnstile                                        string `json:"turnstile"`
	}
	if !read(w, r, &in) {
		return
	}
	in.Phone, in.Name, in.Address = normPhone(in.Phone), strings.TrimSpace(in.Name), strings.TrimSpace(in.Address)
	switch {
	case len(in.Items) == 0 || len(in.Items) > 50:
		fail(w, 400, "your cart is empty")
		return
	case in.Name == "" || len(in.Address) < 5:
		fail(w, 400, "please enter your name and full address")
		return
	case !phoneRe.MatchString(in.Phone):
		fail(w, 400, "please enter a valid Bangladeshi mobile number")
		return
	case in.Area != "dhaka" && in.Area != "outside":
		fail(w, 400, "please choose a delivery area")
		return
	case in.Payment != "cod" && in.Payment != "bkash" && in.Payment != "nagad" && in.Payment != "rocket":
		fail(w, 400, "please choose a payment method")
		return
	case in.Payment != "cod" && len(strings.TrimSpace(in.TxnID)) < 6:
		fail(w, 400, "please enter your transaction ID")
		return
	}
	if !human(r, in.Turnstile) {
		fail(w, 403, "bot check failed, please try again")
		return
	}
	ctx := r.Context()
	number := "LB-" + token(4)
	var total int64
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		var uid *int64
		if id := userID(r); id != 0 {
			uid = &id
		}
		fee := shipping(in.Area)
		var oid int64
		if err := tx.QueryRow(ctx, `INSERT INTO orders(number,user_id,name,phone,address,area,payment,txn_id,note,subtotal,shipping,total)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,0) RETURNING id`, number, uid, in.Name, in.Phone, in.Address, in.Area, in.Payment, strings.TrimSpace(in.TxnID), in.Note, fee).Scan(&oid); err != nil {
			return err
		}
		var sub int64
		for _, it := range in.Items {
			if it.Qty < 1 || it.Qty > 20 {
				return errGone
			}
			var price int64
			var name string
			// A relative update under a row lock: two buyers can never both take the last unit.
			err := tx.QueryRow(ctx, `UPDATE products SET stock=stock-$1 WHERE id=$2 AND active AND stock>=$1 RETURNING price,data->>'name'`, it.Qty, it.ID).Scan(&price, &name)
			if errors.Is(err, pgx.ErrNoRows) {
				return errGone
			} else if err != nil {
				return err
			}
			sub += price * int64(it.Qty)
			if _, err = tx.Exec(ctx, `INSERT INTO order_items VALUES($1,$2,$3,$4,$5)`, oid, it.ID, name, price, it.Qty); err != nil {
				return err
			}
		}
		total = sub + fee
		_, err := tx.Exec(ctx, `UPDATE orders SET subtotal=$1,total=$2 WHERE id=$3`, sub, total, oid)
		return err
	})
	if errors.Is(err, errGone) {
		fail(w, 409, "an item in your cart just sold out or the quantity is too high")
		return
	}
	if err != nil {
		oops(w, err)
		return
	}
	if err = publishStock(ctx); err != nil {
		log.Print("stock file: ", err)
	}
	notify(fmt.Sprintf("New order %s: ৳%d", number, total), fmt.Sprintf("%s, %s, %s (%s)", in.Name, in.Phone, in.Address, in.Payment))
	ok(w, map[string]any{"number": number, "total": total})
}

func human(r *http.Request, tok string) bool {
	secret := os.Getenv("TURNSTILE_SECRET")
	if secret == "" {
		return true
	}
	body, _ := json.Marshal(map[string]string{"secret": secret, "response": tok, "remoteip": r.Header.Get("CF-Connecting-IP")})
	res, err := http.Post("https://challenges.cloudflare.com/turnstile/v0/siteverify", "application/json", bytes.NewReader(body))
	if err != nil {
		return false
	}
	defer res.Body.Close()
	var out struct{ Success bool }
	json.NewDecoder(res.Body).Decode(&out)
	return out.Success
}

// notify emails the shop through Brevo. A failed email must never fail an order.
func notify(subject, text string) {
	key, to := os.Getenv("BREVO_KEY"), os.Getenv("SHOP_EMAIL")
	if key == "" || to == "" {
		return
	}
	b, _ := json.Marshal(map[string]any{"sender": map[string]string{"email": to, "name": "LoverBaazar"}, "to": []map[string]string{{"email": to}}, "subject": subject, "textContent": text})
	req, _ := http.NewRequest("POST", "https://api.brevo.com/v3/smtp/email", bytes.NewReader(b))
	req.Header.Set("api-key", key)
	req.Header.Set("Content-Type", "application/json")
	if res, err := (&http.Client{Timeout: 4 * time.Second}).Do(req); err != nil {
		log.Print("brevo: ", err)
	} else {
		res.Body.Close()
	}
}

// publishStock refreshes the snapshot browsers read. Only writes call it, so browsing stays away from Neon.
func publishStock(ctx context.Context) error {
	var b []byte
	err := db.QueryRow(ctx, `SELECT coalesce(jsonb_object_agg(id,jsonb_build_array(price,regular,CASE WHEN stock>0 THEN 1 ELSE 0 END)),'{}')::text FROM products WHERE active`).Scan(&b)
	if err == nil {
		stock.Store(&b)
	}
	return err
}

func stockFile(w http.ResponseWriter, r *http.Request) {
	if stock.Load() == nil {
		if err := publishStock(r.Context()); err != nil {
			oops(w, err)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Write(*stock.Load())
}

func track(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	row, err := orderJSON(r.Context(), `o.number=$1 AND o.phone=$2`, strings.ToUpper(strings.TrimSpace(q.Get("order"))), normPhone(q.Get("phone")))
	if err != nil || len(row) == 0 {
		fail(w, 404, "no order matches that number and phone")
		return
	}
	ok(w, row[0])
}

const orderSQL = `SELECT jsonb_build_object('number',o.number,'name',o.name,'phone',o.phone,'address',o.address,'area',o.area,'payment',o.payment,'txn_id',o.txn_id,'note',o.note,
 'subtotal',o.subtotal,'shipping',o.shipping,'total',o.total,'status',o.status,'created_at',o.created_at,
 'items',(SELECT jsonb_agg(jsonb_build_object('name',i.name,'price',i.price,'qty',i.qty)) FROM order_items i WHERE i.order_id=o.id)) FROM orders o WHERE `

func orderJSON(ctx context.Context, where string, args ...any) ([]json.RawMessage, error) {
	rows, err := db.Query(ctx, orderSQL+where+` ORDER BY o.created_at DESC LIMIT 200`, args...)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
}

func contact(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name, Contact, Body string }
	if !read(w, r, &in) {
		return
	}
	if in.Name == "" || in.Contact == "" || len(in.Body) < 5 {
		fail(w, 400, "please fill in every field")
		return
	}
	if _, err := db.Exec(r.Context(), `INSERT INTO messages(name,contact,body) VALUES($1,$2,$3)`, in.Name, in.Contact, in.Body); err != nil {
		oops(w, err)
		return
	}
	notify("Website message from "+in.Name, in.Contact+"\n\n"+in.Body)
	ok(w, map[string]bool{"ok": true})
}

func register(w http.ResponseWriter, r *http.Request) {
	var in struct{ Name, Phone, Password string }
	if !read(w, r, &in) {
		return
	}
	in.Phone = normPhone(in.Phone)
	if strings.TrimSpace(in.Name) == "" || !phoneRe.MatchString(in.Phone) || len(in.Password) < 8 || len(in.Password) > 72 {
		fail(w, 400, "enter your name, a valid mobile number and a password of 8+ characters")
		return
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(in.Password), 10)
	var id int64
	err := db.QueryRow(r.Context(), `INSERT INTO users(name,phone,password_hash) VALUES($1,$2,$3) ON CONFLICT(phone) DO NOTHING RETURNING id`, in.Name, in.Phone, string(hash)).Scan(&id)
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

func hashTok(t string) string { s := sha256.Sum256([]byte(t)); return hex.EncodeToString(s[:]) }

func startSession(w http.ResponseWriter, r *http.Request, id int64) {
	t := token(32)
	exp := time.Now().Add(30 * 24 * time.Hour)
	if _, err := db.Exec(r.Context(), `INSERT INTO sessions VALUES($1,$2,$3)`, hashTok(t), id, exp); err != nil {
		oops(w, err)
		return
	}
	http.SetCookie(w, &http.Cookie{Name: "sid", Value: t, Path: "/api", Expires: exp, HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: os.Getenv("DEV") == ""})
	ok(w, map[string]bool{"ok": true})
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
	http.SetCookie(w, &http.Cookie{Name: "sid", Path: "/api", MaxAge: -1})
	ok(w, map[string]bool{"ok": true})
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

func adminOrders(w http.ResponseWriter, r *http.Request) {
	list, err := orderJSON(r.Context(), `TRUE`)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list)
}

func adminOrderStatus(w http.ResponseWriter, r *http.Request) {
	var in struct{ Status string }
	if !read(w, r, &in) {
		return
	}
	valid := map[string]bool{"pending": true, "confirmed": true, "shipped": true, "delivered": true, "cancelled": true}
	if !valid[in.Status] {
		fail(w, 400, "unknown status")
		return
	}
	ctx := r.Context()
	num := chi.URLParam(r, "number")
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		var prev string
		if err := tx.QueryRow(ctx, `SELECT status FROM orders WHERE number=$1 FOR UPDATE`, num).Scan(&prev); err != nil {
			return err
		}
		if in.Status == "cancelled" && prev != "cancelled" { // cancelling returns the stock exactly once
			if _, err := tx.Exec(ctx, `UPDATE products p SET stock=p.stock+i.qty FROM order_items i JOIN orders o ON o.id=i.order_id WHERE o.number=$1 AND i.product_id=p.id`, num); err != nil {
				return err
			}
		} else if prev == "cancelled" && in.Status != "cancelled" {
			return errors.New("a cancelled order cannot be reopened")
		}
		_, err := tx.Exec(ctx, `UPDATE orders SET status=$1 WHERE number=$2`, in.Status, num)
		return err
	})
	if err != nil {
		fail(w, 400, err.Error())
		return
	}
	publishStock(ctx)
	ok(w, map[string]bool{"ok": true})
}

func adminProducts(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(r.Context(), `SELECT data||jsonb_build_object('price',price,'regular',regular,'stock',stock,'active',active) FROM products ORDER BY id DESC`)
	if err != nil {
		oops(w, err)
		return
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list)
}

func adminSaveProduct(w http.ResponseWriter, r *http.Request) {
	var p map[string]any
	if !read(w, r, &p) {
		return
	}
	id, _ := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	slug, _ := p["slug"].(string)
	price, a := p["price"].(float64)
	regular, b := p["regular"].(float64)
	stock, c := p["stock"].(float64)
	name, _ := p["name"].(string)
	if id <= 0 || slug == "" || name == "" || !a || !b || !c || price < 0 || stock < 0 {
		fail(w, 400, "name, slug, price, regular price and stock are required")
		return
	}
	active, isSet := p["active"].(bool)
	if !isSet {
		active = true
	}
	for _, k := range []string{"stock", "active"} {
		delete(p, k)
	}
	j, _ := json.Marshal(p)
	if _, err := db.Exec(r.Context(), `INSERT INTO products(id,slug,price,regular,stock,active,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
		ON CONFLICT(id) DO UPDATE SET slug=$2,price=$3,regular=$4,stock=$5,active=$6,data=$7::jsonb`, id, slug, int64(price), int64(regular), int(stock), active, string(j)); err != nil {
		fail(w, 400, "could not save: is the slug already used?")
		return
	}
	publishStock(r.Context())
	ok(w, map[string]bool{"ok": true})
}

// adminDeleteProduct hides a product: old orders still refer to it.
func adminDeleteProduct(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec(r.Context(), `UPDATE products SET active=FALSE WHERE id=$1`, chi.URLParam(r, "id")); err != nil {
		oops(w, err)
		return
	}
	publishStock(r.Context())
	ok(w, map[string]bool{"ok": true})
}

func adminMessages(w http.ResponseWriter, r *http.Request) {
	rows, err := db.Query(r.Context(), `SELECT jsonb_build_object('name',name,'contact',contact,'body',body,'created_at',created_at) FROM messages ORDER BY id DESC LIMIT 100`)
	if err != nil {
		oops(w, err)
		return
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list)
}

func adminImage(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5<<20))
	if err != nil {
		fail(w, 413, "image must be under 5 MB")
		return
	}
	ct := http.DetectContentType(b)
	if !strings.HasPrefix(ct, "image/") {
		fail(w, 400, "not an image")
		return
	}
	var url string
	if dir := os.Getenv("LOCAL_UPLOADS"); dir != "" {
		name := token(8) + "." + strings.TrimPrefix(ct, "image/")
		os.MkdirAll(dir, 0o755)
		err = os.WriteFile(filepath.Join(dir, name), b, 0o644)
		url = "/uploads/" + name
	} else {
		url, err = cloudinary(b)
	}
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]string{"url": url})
}

// cloudinary stores an upload on the free plan, which needs no card.
func cloudinary(file []byte) (string, error) {
	cloud, key, secret := os.Getenv("CLOUDINARY_CLOUD"), os.Getenv("CLOUDINARY_KEY"), os.Getenv("CLOUDINARY_SECRET")
	if cloud == "" {
		return "", errors.New("image storage is not configured")
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	sig := sha1.Sum([]byte("timestamp=" + ts + secret))
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	m.WriteField("api_key", key)
	m.WriteField("timestamp", ts)
	m.WriteField("signature", hex.EncodeToString(sig[:]))
	part, _ := m.CreateFormFile("file", "upload")
	part.Write(file)
	m.Close()
	res, err := http.Post("https://api.cloudinary.com/v1_1/"+cloud+"/image/upload", m.FormDataContentType(), &body)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		URL string `json:"secure_url"`
	}
	if err = json.NewDecoder(res.Body).Decode(&out); err != nil || out.URL == "" {
		return "", fmt.Errorf("cloudinary upload failed: %d", res.StatusCode)
	}
	return strings.Replace(out.URL, "/upload/", "/upload/f_auto,q_auto/", 1), nil
}

// adminPublish rebuilds the static storefront from the database.
func adminPublish(w http.ResponseWriter, r *http.Request) {
	if dir := os.Getenv("DEV_BUILD_DIR"); dir != "" {
		go func() { // the rebuild restarts the local dev server, so it cannot finish inside this request
			cmd := exec.Command("npx", "astro", "build")
			cmd.Dir, cmd.Env = dir, append(os.Environ(), "CATALOG_URL=http://127.0.0.1:8080/api/catalog")
			if out, err := cmd.CombinedOutput(); err != nil {
				log.Printf("build: %s", out)
			}
		}()
		ok(w, map[string]string{"message": "Rebuilding the storefront. Refresh the shop in about 20 seconds."})
		return
	}
	repo, tok := os.Getenv("GITHUB_REPO"), os.Getenv("GITHUB_TOKEN")
	if repo == "" || tok == "" {
		fail(w, 501, "publishing is not configured")
		return
	}
	req, _ := http.NewRequestWithContext(r.Context(), "POST", "https://api.github.com/repos/"+repo+"/dispatches", strings.NewReader(`{"event_type":"publish"}`))
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		oops(w, err)
		return
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		fail(w, 502, "GitHub refused the publish request")
		return
	}
	ok(w, map[string]string{"message": "Rebuild started. The shop updates in about 3 minutes."})
}
