package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"maps"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

var (
	// Bangla vowel signs are marks, not letters. WordPress slugs can also be percent-encoded.
	slugRe     = regexp.MustCompile(`^[\p{L}\p{M}\p{N}%_-]+$`)
	pathRe     = regexp.MustCompile(`^[\p{L}\p{M}\p{N}%_-]+(/[\p{L}\p{M}\p{N}%_-]+)*$`)
	idRe       = regexp.MustCompile(`^[a-z0-9-]+$`)
	colorRe    = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)
	imageRefRe = regexp.MustCompile(`https?://[^\s"'<>\\]+|/uploads/[a-zA-Z0-9._-]+`)
	// Top-level addresses the shop already uses. A page with one of these names would break the build.
	reservedSlugs = []string{"admin", "api", "blog", "cart", "checkout", "contact-us", "feed.xml", "my-account", "offers", "product", "product-category", "product-tag", "search", "shop", "track", "wishlist", "wp-content", "uploads", "404", "_astro", "feed", "page"}
	statuses      = []string{"pending", "confirmed", "shipped", "delivered", "cancelled", "returned"}
)

func isOut(status string) bool { return status == "cancelled" || status == "returned" }

// duplicate reports a unique constraint failure, which means the slug is taken.
func duplicate(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && pg.Code == "23505"
}

func adminDashboard(w http.ResponseWriter, r *http.Request) {
	live, _, err := loadSettings(r.Context())
	if err != nil {
		oops(w, err)
		return
	}
	list, err := jsonRows(r.Context(), `WITH o AS (
		SELECT *,(created_at AT TIME ZONE 'Asia/Dhaka')::date AS day, status NOT IN `+outStatuses+` AS counts FROM orders WHERE created_at>now()-interval '40 days'),
		t AS (SELECT (now() AT TIME ZONE 'Asia/Dhaka')::date AS d)
	SELECT jsonb_build_object(
		'todayOrders',(SELECT count(*) FROM o,t WHERE day=d),
		'todaySales',(SELECT coalesce(sum(total),0) FROM o,t WHERE day=d AND counts),
		'monthOrders',(SELECT count(*) FROM o,t WHERE day>d-30),
		'monthSales',(SELECT coalesce(sum(total),0) FROM o,t WHERE day>d-30 AND counts),
		'pending',(SELECT count(*) FROM orders WHERE status='pending'),
		'toShip',(SELECT count(*) FROM orders WHERE status='confirmed'),
		'unread',(SELECT count(*) FROM messages WHERE NOT read),
		'reviews',(SELECT count(*) FROM reviews WHERE NOT approved),
		'series',(SELECT jsonb_agg(jsonb_build_object('day',g::date,'sales',coalesce(s.sales,0),'orders',coalesce(s.n,0)) ORDER BY g)
			FROM generate_series((SELECT d-13 FROM t)::timestamp,(SELECT d FROM t)::timestamp,interval '1 day') g
			LEFT JOIN (SELECT day,sum(total) sales,count(*) n FROM o WHERE counts GROUP BY day) s ON s.day=g::date),
		'top',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT i.name,sum(i.qty) qty,sum(i.qty*i.price) sales FROM order_items i JOIN o ON o.id=i.order_id, t
			WHERE o.counts AND o.day>t.d-30 GROUP BY i.name ORDER BY 2 DESC LIMIT 5) x),
		'low',(SELECT coalesce(jsonb_agg(x),'[]'::jsonb) FROM (SELECT id,data->>'name' AS name,stock FROM products WHERE active AND stock<=$1 ORDER BY stock,id LIMIT 20) x))`, live.LowStock)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list[0])
}

// orderFilter turns the admin's search box, status and dates into SQL. Dates are Bangladesh dates.
func orderFilter(r *http.Request) (string, []any) {
	q := r.URL.Query()
	where, args := "TRUE", []any{}
	add := func(cond string, v any) {
		args = append(args, v)
		where += " AND " + strings.ReplaceAll(cond, "$?", "$"+strconv.Itoa(len(args)))
	}
	if s := strings.TrimSpace(q.Get("q")); s != "" {
		add(`(o.number ILIKE $? OR o.phone ILIKE $? OR o.name ILIKE $? OR o.address ILIKE $?)`, "%"+s+"%")
	}
	if s := q.Get("status"); slices.Contains(statuses, s) {
		add(`o.status=$?`, s)
	}
	const day = `(o.created_at AT TIME ZONE 'Asia/Dhaka')::date`
	if _, err := time.Parse("2006-01-02", q.Get("from")); err == nil {
		add(day+`>=$?::date`, q.Get("from"))
	}
	if _, err := time.Parse("2006-01-02", q.Get("to")); err == nil {
		add(day+`<=$?::date`, q.Get("to"))
	}
	return where, args
}

func adminOrders(w http.ResponseWriter, r *http.Request) {
	where, args := orderFilter(r)
	ctx := r.Context()
	var total, sales int64
	if err := db.QueryRow(ctx, `SELECT count(*),coalesce(sum(o.total) FILTER (WHERE o.status NOT IN `+outStatuses+`),0) FROM orders o WHERE `+where, args...).Scan(&total, &sales); err != nil {
		oops(w, err)
		return
	}
	const size = 50
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	list, err := jsonRows(ctx, `SELECT `+orderFields+`||jsonb_build_object('admin_note',o.admin_note,'email',o.email,'same_phone',(SELECT count(*) FROM orders x WHERE x.phone=o.phone),'bad_phone',(SELECT count(*) FROM orders x WHERE x.phone=o.phone AND x.status IN `+outStatuses+`))
		FROM orders o WHERE `+where+fmt.Sprintf(` ORDER BY o.created_at DESC LIMIT %d OFFSET %d`, size, size*max(page, 0)), args...)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]any{"orders": list, "total": total, "sales": sales, "size": size})
}

// csvSafe stops a customer's text being run as a formula when the file is opened in Excel.
func csvSafe(s string) string {
	if s != "" && strings.ContainsRune("=+-@\t\r", rune(s[0])) {
		return "'" + s
	}
	return s
}

func adminOrdersCSV(w http.ResponseWriter, r *http.Request) {
	where, args := orderFilter(r)
	rows, err := db.Query(r.Context(), `SELECT o.number,to_char(o.created_at AT TIME ZONE 'Asia/Dhaka','YYYY-MM-DD HH24:MI'),o.status,o.name,o.phone,o.address,o.area,o.payment,o.txn_id,
		(SELECT string_agg(i.name||' x'||i.qty,'; ') FROM order_items i WHERE i.order_id=o.id),o.subtotal::text,o.discount::text,o.shipping::text,o.total::text,o.coupon,o.courier,o.tracking,o.note,o.admin_note
		FROM orders o WHERE `+where+` ORDER BY o.created_at DESC LIMIT 5000`, args...)
	if err != nil {
		oops(w, err)
		return
	}
	lines, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) ([]string, error) {
		vals, err := row.Values()
		out := make([]string, len(vals))
		for i, v := range vals {
			if v != nil {
				out[i] = csvSafe(fmt.Sprint(v))
			}
		}
		return out, err
	})
	if err != nil {
		oops(w, err)
		return
	}
	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Disposition", `attachment; filename="orders.csv"`)
	w.Write([]byte("\xEF\xBB\xBF")) // lets Excel show Bangla correctly
	c := csv.NewWriter(w)
	c.Write([]string{"Order", "Date", "Status", "Name", "Phone", "Address", "Area", "Payment", "Transaction ID", "Items", "Subtotal", "Discount", "Delivery", "Total", "Coupon", "Courier", "Tracking", "Customer note", "Admin note"})
	c.WriteAll(lines)
}

// adminUpdateOrder sends only what changed. Leaving cancelled or returned gives the stock back once only.
func adminUpdateOrder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Status, Courier, Tracking, AdminNote *string
	}
	if !read(w, r, &in) {
		return
	}
	if in.Status != nil && !slices.Contains(statuses, *in.Status) {
		fail(w, 400, "unknown status")
		return
	}
	ctx := r.Context()
	num := chi.URLParam(r, "number")
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		var id int64
		var prev, coupon string
		err := tx.QueryRow(ctx, `SELECT id,status,coupon FROM orders WHERE number=$1 FOR UPDATE`, num).Scan(&id, &prev, &coupon)
		if errors.Is(err, pgx.ErrNoRows) {
			return userErr{404, "order not found"}
		} else if err != nil {
			return err
		}
		if in.Status != nil && *in.Status != prev {
			switch {
			case isOut(prev) && !isOut(*in.Status):
				return userErr{409, "a cancelled or returned order cannot be reopened. Please place a new one"}
			case !isOut(prev) && isOut(*in.Status):
				if _, err = tx.Exec(ctx, `UPDATE products p SET stock=p.stock+i.qty FROM order_items i WHERE i.order_id=$1 AND i.product_id=p.id`, id); err != nil {
					return err
				}
				if coupon != "" {
					if _, err = tx.Exec(ctx, `UPDATE coupons SET used=GREATEST(used-1,0) WHERE code=$1`, coupon); err != nil {
						return err
					}
				}
			}
			if _, err = tx.Exec(ctx, `INSERT INTO order_events(order_id,status) VALUES($1,$2)`, id, *in.Status); err != nil {
				return err
			}
		}
		_, err = tx.Exec(ctx, `UPDATE orders SET status=coalesce($2,status),courier=coalesce($3,courier),tracking=coalesce($4,tracking),admin_note=coalesce($5,admin_note) WHERE id=$1`,
			id, in.Status, in.Courier, in.Tracking, in.AdminNote)
		return err
	})
	if err != nil {
		oops(w, err)
		return
	}
	refresh()
	done(w)
}

func adminCustomers(w http.ResponseWriter, r *http.Request) {
	writeList(w, r, `SELECT jsonb_build_object('phone',o.phone,'name',(array_agg(o.name ORDER BY o.id DESC))[1],'orders',count(*),
		'cancelled',count(*) FILTER (WHERE o.status IN `+outStatuses+`),'spent',coalesce(sum(o.total) FILTER (WHERE o.status NOT IN `+outStatuses+`),0),'last',max(o.created_at))
		FROM orders o WHERE o.phone ILIKE $1 OR o.name ILIKE $1 GROUP BY o.phone ORDER BY max(o.created_at) DESC LIMIT 200`, "%"+strings.TrimSpace(r.URL.Query().Get("q"))+"%")
}

// adminResetPassword is how a customer gets back in: SMS and email cost money or need a verified
// address, so they call the shop and the admin reads a new password to them.
func adminResetPassword(w http.ResponseWriter, r *http.Request) {
	var in struct{ Phone string }
	if !read(w, r, &in) {
		return
	}
	var id int64
	err := db.QueryRow(r.Context(), `SELECT id FROM users WHERE phone=$1`, normPhone(in.Phone)).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "no account uses that number")
		return
	} else if err != nil {
		oops(w, err)
		return
	}
	password := strings.ToLower(token(5))
	if err = setPassword(r.Context(), id, password); err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]string{"password": password})
}

func adminProducts(w http.ResponseWriter, r *http.Request) {
	serveSnap(w, r, &adminProductsSnap, func(ctx context.Context) ([]byte, error) {
		list, err := jsonRows(ctx, `SELECT data||jsonb_build_object('price',price,'regular',regular,'stock',stock,'active',active) FROM products ORDER BY id DESC`)
		if err != nil {
			return nil, err
		}
		return json.Marshal(list)
	})
}

func wholeNumber(v any) (int64, bool) {
	f, isNum := v.(float64)
	return int64(f), isNum && f >= 0 && f == float64(int64(f))
}

// adminSaveProduct creates (POST) or replaces (PUT) a product. Stock is never written as a number:
// orders may have sold units since the form opened, so a PUT carries stockDelta, the change the admin made.
func adminSaveProduct(w http.ResponseWriter, r *http.Request) {
	var p map[string]any
	if !read(w, r, &p) {
		return
	}
	id := paramID(r, "id")
	slug, _ := p["slug"].(string)
	name, _ := p["name"].(string)
	price, a := wholeNumber(p["price"])
	regular, b := wholeNumber(p["regular"])
	if !a || !b || strings.TrimSpace(name) == "" || !slugRe.MatchString(slug) {
		fail(w, 400, "name, a URL slug without spaces, and whole-taka prices are required")
		return
	}
	regular = max(regular, price)
	delta, _ := p["stockDelta"].(float64)
	stock, _ := wholeNumber(p["stock"])
	active, isSet := p["active"].(bool)
	if !isSet {
		active = true
	}
	delete(p, "stock")
	delete(p, "stockDelta")
	delete(p, "active")
	for _, k := range []string{"cats", "tags", "images", "attrs"} { // the static build relies on these lists
		if _, isList := p[k].([]any); !isList {
			p[k] = []any{}
		}
	}
	ctx := r.Context()
	var err error
	var oldImages []any
	if r.Method == http.MethodPost {
		if err = db.QueryRow(ctx, `SELECT nextval('product_ids')`).Scan(&id); err == nil {
			p["id"] = id
			j, _ := json.Marshal(p)
			_, err = db.Exec(ctx, `INSERT INTO products(id,slug,price,regular,stock,active,data) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, id, slug, price, regular, stock, active, string(j))
		}
	} else {
		p["id"] = id
		j, _ := json.Marshal(p)
		var tag pgconn.CommandTag
		db.QueryRow(ctx, `SELECT data->'images' FROM products WHERE id=$1`, id).Scan(&oldImages)
		tag, err = db.Exec(ctx, `UPDATE products SET slug=$2,price=$3,regular=$4,stock=GREATEST(stock+$5,0),active=$6,data=$7::jsonb WHERE id=$1`, id, slug, price, regular, int64(delta), active, string(j))
		if err == nil && tag.RowsAffected() == 0 {
			fail(w, 404, "product not found")
			return
		}
	}
	if duplicate(err) {
		fail(w, 409, "another product already uses that URL slug")
		return
	} else if err != nil {
		oops(w, err)
		return
	}
	refresh()
	go dropImages(oldImages, p["images"].([]any))
	ok(w, map[string]any{"ok": true, "id": id})
}

// adminQuickEdit changes price, stock or visibility from the product list.
func adminQuickEdit(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Price, Regular *int64
		StockDelta     int64
		Active         *bool
	}
	if !read(w, r, &in) {
		return
	}
	if (in.Price != nil && *in.Price < 0) || (in.Regular != nil && *in.Regular < 0) {
		fail(w, 400, "prices cannot be negative")
		return
	}
	var stock int
	err := db.QueryRow(r.Context(), `UPDATE products SET price=coalesce($2,price),regular=GREATEST(coalesce($3,regular),coalesce($2,price)),stock=GREATEST(stock+$4,0),active=coalesce($5,active)
		WHERE id=$1 RETURNING stock`, paramID(r, "id"), in.Price, in.Regular, in.StockDelta, in.Active).Scan(&stock)
	if errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "product not found")
		return
	} else if err != nil {
		oops(w, err)
		return
	}
	refresh()
	ok(w, map[string]any{"stock": stock})
}

// adminDeleteProduct removes a product for good. One that has been ordered is only hidden, because
// old orders still refer to it.
func adminDeleteProduct(w http.ResponseWriter, r *http.Request) {
	id, ctx := paramID(r, "id"), r.Context()
	var images []any
	if err := db.QueryRow(ctx, `SELECT data->'images' FROM products WHERE id=$1`, id).Scan(&images); errors.Is(err, pgx.ErrNoRows) {
		fail(w, 404, "product not found")
		return
	} else if err != nil {
		oops(w, err)
		return
	}
	tag, err := db.Exec(ctx, `DELETE FROM products p WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM order_items i WHERE i.product_id=p.id)`, id)
	if err == nil && tag.RowsAffected() == 0 {
		_, err = db.Exec(ctx, `UPDATE products SET active=FALSE WHERE id=$1`, id)
	}
	if err != nil {
		oops(w, err)
		return
	}
	refresh()
	deleted := tag.RowsAffected() > 0
	if deleted {
		go dropImages(images, nil)
	}
	ok(w, map[string]any{"deleted": deleted})
}

func contentKind(w http.ResponseWriter, r *http.Request) (string, bool) {
	kind := chi.URLParam(r, "kind")
	if !slices.Contains([]string{"cat", "tag", "page", "post"}, kind) {
		fail(w, 404, "unknown content type")
		return "", false
	}
	return kind, true
}

func adminContent(w http.ResponseWriter, r *http.Request) {
	if kind, valid := contentKind(w, r); valid {
		writeList(w, r, `SELECT data FROM content WHERE kind=$1 ORDER BY coalesce(data->>'date','') DESC,coalesce(data->>'name',data->>'title')`, kind)
	}
}

func adminSaveContent(w http.ResponseWriter, r *http.Request) {
	kind, valid := contentKind(w, r)
	if !valid {
		return
	}
	var d map[string]any
	if !read(w, r, &d) {
		return
	}
	slug := chi.URLParam(r, "slug")
	if !slugRe.MatchString(slug) {
		fail(w, 400, "the URL slug can only use letters, numbers and dashes")
		return
	}
	d["slug"] = slug
	label, field := "title", "title"
	if kind == "cat" || kind == "tag" {
		label, field = "name", "name"
	}
	if s, _ := d[field].(string); strings.TrimSpace(s) == "" {
		fail(w, 400, "please enter a "+label)
		return
	}
	ctx := r.Context()
	switch kind {
	case "cat":
		path, _ := d["path"].(string)
		if path == "" {
			path = slug
			d["path"] = path
		}
		if !pathRe.MatchString(path) || (path != slug && !strings.HasSuffix(path, "/"+slug)) {
			fail(w, 400, "that category path is not valid")
			return
		}
	case "page", "post":
		if slices.Contains(reservedSlugs, slug) {
			fail(w, 400, "the shop already uses /"+slug+"/. Please choose another URL")
			return
		}
		// Pages and posts share the top-level address space.
		var taken bool
		if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content WHERE kind IN('page','post') AND kind<>$1 AND slug=$2)`, kind, slug).Scan(&taken); err != nil {
			oops(w, err)
			return
		}
		if taken {
			fail(w, 409, "a page or post already uses /"+slug+"/")
			return
		}
		if s, _ := d["date"].(string); kind == "post" && s == "" {
			d["date"] = time.Now().Format("2006-01-02")
		}
	}
	var oldData string
	_ = db.QueryRow(ctx, `SELECT data::text FROM content WHERE kind=$1 AND slug=$2`, kind, slug).Scan(&oldData)
	j, _ := json.Marshal(d)
	if _, err := db.Exec(ctx, `INSERT INTO content(kind,slug,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(kind,slug) DO UPDATE SET data=$3::jsonb`, kind, slug, string(j)); err != nil {
		oops(w, err)
		return
	}
	refresh()
	if oldURLs := extractImageRefs(oldData); len(oldURLs) > 0 {
		go dropOldURLs(oldURLs)
	}
	done(w)
}

func adminDeleteContent(w http.ResponseWriter, r *http.Request) {
	kind, valid := contentKind(w, r)
	if !valid {
		return
	}
	ctx := r.Context()
	slug := chi.URLParam(r, "slug")
	if kind == "cat" || kind == "tag" {
		field := map[string]string{"cat": "cats", "tag": "tags"}[kind]
		var n int
		if err := db.QueryRow(ctx, `SELECT count(*) FROM products WHERE active AND data->$1 @> to_jsonb($2::text)`, field, slug).Scan(&n); err != nil {
			oops(w, err)
			return
		}
		if n > 0 {
			fail(w, 409, fmt.Sprintf("Products still use this (%d). Move them first", n))
			return
		}
	}
	var oldData string
	_ = db.QueryRow(ctx, `SELECT data::text FROM content WHERE kind=$1 AND slug=$2`, kind, slug).Scan(&oldData)
	if _, err := db.Exec(ctx, `DELETE FROM content WHERE kind=$1 AND slug=$2`, kind, slug); err != nil {
		oops(w, err)
		return
	}
	refresh()
	if oldURLs := extractImageRefs(oldData); len(oldURLs) > 0 {
		go dropOldURLs(oldURLs)
	}
	done(w)
}

func adminCoupons(w http.ResponseWriter, r *http.Request) {
	writeList(w, r, `SELECT to_jsonb(c) FROM coupons c ORDER BY active DESC,code`)
}

func adminSaveCoupon(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kind                     string
		Value, MinOrder, MaxUses int64
		Expires                  string
		Active                   bool
	}
	if !read(w, r, &in) {
		return
	}
	code := strings.ToUpper(strings.TrimSpace(chi.URLParam(r, "code")))
	if !regexp.MustCompile(`^[A-Z0-9_-]{2,40}$`).MatchString(code) {
		fail(w, 400, "use 2 to 40 letters and numbers for the code")
		return
	}
	if (in.Kind != "percent" && in.Kind != "amount") || in.Value < 1 || (in.Kind == "percent" && in.Value > 100) || in.MinOrder < 0 || in.MaxUses < 0 {
		fail(w, 400, "please check the discount: a percent must be 1 to 100")
		return
	}
	var expires *string
	if in.Expires != "" {
		if _, err := time.Parse("2006-01-02", in.Expires); err != nil {
			fail(w, 400, "please check the end date")
			return
		}
		e := in.Expires + " 23:59:59+06" // the end of that day in Bangladesh
		expires = &e
	}
	if _, err := db.Exec(r.Context(), `INSERT INTO coupons(code,kind,value,min_order,max_uses,expires_at,active) VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7)
		ON CONFLICT(code) DO UPDATE SET kind=$2,value=$3,min_order=$4,max_uses=$5,expires_at=$6::timestamptz,active=$7`, code, in.Kind, in.Value, in.MinOrder, in.MaxUses, expires, in.Active); err != nil {
		oops(w, err)
		return
	}
	done(w)
}

func adminDeleteCoupon(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec(r.Context(), `DELETE FROM coupons WHERE code=$1`, chi.URLParam(r, "code")); err != nil {
		oops(w, err)
		return
	}
	done(w)
}

func adminReviews(w http.ResponseWriter, r *http.Request) {
	writeList(w, r, `SELECT jsonb_build_object('id',r.id,'name',r.name,'rating',r.rating,'body',r.body,'approved',r.approved,'created_at',r.created_at,'product',p.data->>'name','slug',p.slug)
		FROM reviews r JOIN products p ON p.id=r.product_id ORDER BY r.approved,r.id DESC LIMIT 200`)
}

func adminApproveReview(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec(r.Context(), `UPDATE reviews SET approved=TRUE WHERE id=$1`, paramID(r, "id")); err != nil {
		oops(w, err)
		return
	}
	refresh()
	done(w)
}

func adminDeleteReview(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec(r.Context(), `DELETE FROM reviews WHERE id=$1`, paramID(r, "id")); err != nil {
		oops(w, err)
		return
	}
	refresh()
	done(w)
}

func adminMessages(w http.ResponseWriter, r *http.Request) {
	writeList(w, r, `SELECT jsonb_build_object('id',id,'name',name,'contact',contact,'body',body,'read',read,'created_at',created_at) FROM messages ORDER BY read,id DESC LIMIT 200`)
}

func adminReadMessage(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec(r.Context(), `UPDATE messages SET read=TRUE WHERE id=$1`, paramID(r, "id")); err != nil {
		oops(w, err)
		return
	}
	done(w)
}

func adminDeleteMessage(w http.ResponseWriter, r *http.Request) {
	if _, err := db.Exec(r.Context(), `DELETE FROM messages WHERE id=$1`, paramID(r, "id")); err != nil {
		oops(w, err)
		return
	}
	done(w)
}

func adminSettings(w http.ResponseWriter, r *http.Request) {
	live, site, err := loadSettings(r.Context())
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]any{"live": live, "site": site})
}

func validLive(l Live) error {
	if len(l.Delivery) == 0 {
		return userErr{400, "add at least one delivery area"}
	}
	seen := map[string]bool{}
	for _, z := range l.Delivery {
		if !idRe.MatchString(z.ID) || z.Label == "" || z.Fee < 0 || seen[z.ID] {
			return userErr{400, "each delivery area needs its own name and a charge of 0 or more"}
		}
		seen[z.ID] = true
	}
	open := false
	seen = map[string]bool{}
	for _, p := range l.Payments {
		if !idRe.MatchString(p.ID) || p.Label == "" || seen[p.ID] {
			return userErr{400, "each payment method needs its own name"}
		}
		seen[p.ID] = true
		open = open || p.Enabled
	}
	if !open {
		return userErr{400, "keep at least one payment method turned on"}
	}
	if l.FreeOver < 0 || l.MinOrder < 0 || l.LowStock < 0 || l.MaxPending < 0 {
		return userErr{400, "amounts cannot be negative"}
	}
	return nil
}

func adminSaveSettings(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Live Live           `json:"live"`
		Site map[string]any `json:"site"`
	}
	if !read(w, r, &in) {
		return
	}
	if err := validLive(in.Live); err != nil {
		oops(w, err)
		return
	}
	if s, _ := in.Site["name"].(string); strings.TrimSpace(s) == "" {
		fail(w, 400, "shop name is required")
		return
	}
	if s, _ := in.Site["phone"].(string); strings.TrimSpace(s) == "" {
		fail(w, 400, "shop phone number is required")
		return
	}
	for _, k := range []string{"brandColor", "brandDark"} {
		if c, ok := in.Site[k].(string); ok && c != "" && !colorRe.MatchString(c) {
			fail(w, 400, "please choose valid colours")
			return
		}
	}
	live, _ := json.Marshal(in.Live)
	site, _ := json.Marshal(in.Site)
	ctx := r.Context()
	var oldURLs []string
	if rows, err := db.Query(ctx, `SELECT data::text FROM settings WHERE key IN ('site','live')`); err == nil {
		var buf strings.Builder
		for rows.Next() {
			var raw string
			if rows.Scan(&raw) == nil {
				buf.WriteString(raw)
				buf.WriteByte('\n')
			}
		}
		rows.Close()
		oldURLs = extractImageRefs(buf.String())
	}
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		for key, data := range map[string][]byte{"live": live, "site": site} {
			if _, err := tx.Exec(ctx, `INSERT INTO settings(key,data) VALUES($1,$2::jsonb) ON CONFLICT(key) DO UPDATE SET data=$2::jsonb`, key, string(data)); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		oops(w, err)
		return
	}
	refresh()
	if len(oldURLs) > 0 {
		go dropOldURLs(oldURLs)
	}
	done(w)
}

func adminImage(w http.ResponseWriter, r *http.Request) {
	b, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 5<<20))
	if err != nil {
		fail(w, 413, "image must be under 5 MB")
		return
	}
	ct := http.DetectContentType(b)
	ext, valid := map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}[ct]
	if !valid {
		fail(w, 400, "please upload a JPG, PNG, WebP or GIF image")
		return
	}
	var url string
	if dir := os.Getenv("LOCAL_UPLOADS"); dir != "" {
		name := token(8) + "." + ext
		os.MkdirAll(dir, 0o755)
		err = os.WriteFile(filepath.Join(dir, name), b, 0o644)
		url = "/uploads/" + name
	} else {
		q := r.URL.Query()
		url, err = cloudinary(r.Context(), b, q.Get("folder"), q.Get("name"))
	}
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]string{"url": url})
}

func adminCleanupImages(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URLs []string `json:"urls"`
	}
	if !read(w, r, &in) {
		return
	}
	if len(in.URLs) > 100 {
		in.URLs = in.URLs[:100]
	}
	ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
	defer cancel()
	dropURLs(ctx, in.URLs)
	done(w)
}

// uploadFolder holds every shop image, in readable places such as
// loverbaazar/products/rice-cooker/kiam-rice-cooker-1. scripts/images_to_cloudinary.py follows the same plan.
const uploadFolder = "loverbaazar"

var (
	folderRe = regexp.MustCompile(`^[a-z0-9-]+(/[a-z0-9-]+)*$`)
	nameRe   = regexp.MustCompile(`^[a-z0-9-]+$`)
)

// uploadPlace falls back to a dated name, so a missing hint can't overwrite another image.
func uploadPlace(folder, name string) (dir, publicID string) {
	if !folderRe.MatchString(folder) {
		folder = "uploads"
	}
	if !nameRe.MatchString(name) {
		name = "image-" + time.Now().Format("2006-01-02-150405")
	}
	dir = uploadFolder + "/" + folder
	return dir, dir + "/" + name
}

// safeUploadPlace avoids overwriting an image already saved in the database when a fixed name
// (such as "logo" or "banner") is uploaded before the admin clicks Save.
func safeUploadPlace(ctx context.Context, folder, name string) (dir, id string) {
	dir, id = uploadPlace(folder, name)
	if !isImageRefUsed(ctx, id) {
		return dir, id
	}
	base := id + "-" + time.Now().Format("150405")
	id = base
	for i := 2; isImageRefUsed(ctx, id); i++ {
		id = base + "-" + strconv.Itoa(i)
	}
	return dir, id
}

// signUpload is Cloudinary's rule: sorted name=value pairs, then the secret, hashed with SHA-1.
func signUpload(params map[string]string, secret string) string {
	keys := slices.Sorted(maps.Keys(params))
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = k + "=" + params[k]
	}
	sum := sha1.Sum([]byte(strings.Join(parts, "&") + secret))
	return hex.EncodeToString(sum[:])
}

// cloudinary stores an upload on the free plan, which needs no card.
func cloudinary(ctx context.Context, file []byte, folder, name string) (string, error) {
	cloud, key, secret := os.Getenv("CLOUDINARY_CLOUD"), os.Getenv("CLOUDINARY_KEY"), os.Getenv("CLOUDINARY_SECRET")
	if cloud == "" {
		return "", userErr{501, "image storage is not configured. Add the Cloudinary keys on Render"}
	}
	dir, id := safeUploadPlace(ctx, folder, name)
	params := map[string]string{
		"asset_folder": dir,
		"invalidate":   "true",
		"public_id":    id,
		"timestamp":    strconv.FormatInt(time.Now().Unix(), 10),
	}
	var body bytes.Buffer
	m := multipart.NewWriter(&body)
	m.WriteField("api_key", key)
	m.WriteField("signature", signUpload(params, secret))
	for k, v := range params {
		m.WriteField(k, v)
	}
	part, _ := m.CreateFormFile("file", "upload")
	part.Write(file)
	m.Close()
	client := &http.Client{Timeout: 30 * time.Second}
	res, err := client.Post("https://api.cloudinary.com/v1_1/"+cloud+"/image/upload", m.FormDataContentType(), &body)
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

// publicID finds an image's name inside its address. Only the shop's own folder counts, so nothing
// else in the Cloudinary account can ever be deleted from here.
func publicID(url string) string {
	i := strings.Index(url, "/"+uploadFolder+"/")
	if !strings.Contains(url, "res.cloudinary.com/") || i < 0 {
		return ""
	}
	id, _, _ := strings.Cut(url[i+1:], "?")
	if dot := strings.LastIndex(id, "."); dot > strings.LastIndex(id, "/") {
		id = id[:dot]
	}
	return id
}

func localUploadFile(u string) string {
	if !strings.HasPrefix(u, "/uploads/") {
		return ""
	}
	name := strings.TrimPrefix(u, "/uploads/")
	if name == "" || strings.ContainsAny(name, `/\`) || name == "." || name == ".." {
		return ""
	}
	return name
}

func extractImageRefs(raw string) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range imageRefRe.FindAllString(raw, -1) {
		if (publicID(m) != "" || localUploadFile(m) != "") && !seen[m] {
			seen[m] = true
			out = append(out, m)
		}
	}
	return out
}

func isImageRefUsed(ctx context.Context, needle string) bool {
	if needle == "" {
		return false
	}
	var used bool
	err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM products WHERE position($1 in data::text)>0)
		OR EXISTS(SELECT 1 FROM content WHERE position($1 in data::text)>0)
		OR EXISTS(SELECT 1 FROM settings WHERE position($1 in data::text)>0)`, needle).Scan(&used)
	return err == nil && used
}

func imageURLs(list []any) []string {
	var urls []string
	for _, x := range list {
		if m, isMap := x.(map[string]any); isMap {
			if src, _ := m["src"].(string); src != "" {
				urls = append(urls, src)
			}
		}
	}
	return urls
}

func imageIDs(list []any) []string {
	var ids []string
	for _, u := range imageURLs(list) {
		if id := publicID(u); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

// unusedImages lists photos that were removed and that nothing else still shows. A product copy can
// share a photo, and pages and settings can link to one, so all of them are checked first.
func unusedImages(ctx context.Context, before, after []any) []string {
	keep := imageIDs(after)
	var out []string
	for _, id := range imageIDs(before) {
		if slices.Contains(keep, id) {
			continue
		}
		if !isImageRefUsed(ctx, id) {
			out = append(out, id)
		}
	}
	return out
}

func unusedURLs(ctx context.Context, urls []string) (cloudIDs []string, localFiles []string) {
	seenCloud := map[string]bool{}
	seenLocal := map[string]bool{}
	for _, u := range urls {
		if id := publicID(u); id != "" && !seenCloud[id] {
			seenCloud[id] = true
			if !isImageRefUsed(ctx, id) {
				cloudIDs = append(cloudIDs, id)
			}
		} else if f := localUploadFile(u); f != "" && !seenLocal[f] {
			seenLocal[f] = true
			if !isImageRefUsed(ctx, "/uploads/"+f) {
				localFiles = append(localFiles, f)
			}
		}
	}
	return cloudIDs, localFiles
}

func dropURLs(ctx context.Context, urls []string) {
	cloudIDs, localFiles := unusedURLs(ctx, urls)
	for _, id := range cloudIDs {
		if err := cloudinaryDelete(id); err != nil {
			log.Print("cloudinary delete: ", err)
		}
	}
	if dir := os.Getenv("LOCAL_UPLOADS"); dir != "" {
		for _, f := range localFiles {
			if err := os.Remove(filepath.Join(dir, f)); err != nil && !errors.Is(err, os.ErrNotExist) {
				log.Print("local upload delete: ", err)
			}
		}
	}
}

func dropOldURLs(urls []string) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	dropURLs(ctx, urls)
}

// dropImages frees Cloudinary (and local dev) space. Call it with `go`: a failure here must never hold up a save.
func dropImages(before, after []any) {
	keep := map[string]bool{}
	for _, u := range imageURLs(after) {
		keep[u] = true
	}
	var removed []string
	for _, u := range imageURLs(before) {
		if !keep[u] {
			removed = append(removed, u)
		}
	}
	if len(removed) > 0 {
		dropOldURLs(removed)
	}
}

func cloudinaryDelete(id string) error {
	cloud, key, secret := os.Getenv("CLOUDINARY_CLOUD"), os.Getenv("CLOUDINARY_KEY"), os.Getenv("CLOUDINARY_SECRET")
	if cloud == "" {
		return nil
	}
	params := map[string]string{"invalidate": "true", "public_id": id, "timestamp": strconv.FormatInt(time.Now().Unix(), 10)}
	form := url.Values{"api_key": {key}, "signature": {signUpload(params, secret)}}
	for k, v := range params {
		form.Set(k, v)
	}
	res, err := httpClient.PostForm("https://api.cloudinary.com/v1_1/"+cloud+"/image/destroy", form)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	var out struct{ Result string }
	json.NewDecoder(res.Body).Decode(&out)
	if out.Result != "ok" && out.Result != "not found" {
		return fmt.Errorf("%s: status %d, %q", id, res.StatusCode, out.Result)
	}
	return nil
}

// adminPublish rebuilds the static storefront from the database.
func adminPublish(w http.ResponseWriter, r *http.Request) {
	if dir := os.Getenv("DEV_BUILD_DIR"); dir != "" {
		go func() { // the rebuild restarts the local dev server, so it cannot finish inside this request
			cmd := exec.Command("npx", "astro", "build")
			cmd.Dir = dir
			cmd.Env = append(os.Environ(), "CATALOG_URL=http://127.0.0.1:"+os.Getenv("PORT")+"/api/catalog")
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
	res, err := httpClient.Do(req)
	if err != nil {
		oops(w, err)
		return
	}
	res.Body.Close()
	if res.StatusCode >= 300 {
		log.Print("github dispatch: status ", res.StatusCode)
		fail(w, 502, "GitHub refused the publish request. Check GITHUB_TOKEN on Render")
		return
	}
	ok(w, map[string]string{"message": "Rebuild started. The shop updates in about 3 minutes."})
}
