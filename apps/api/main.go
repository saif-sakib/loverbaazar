// LoverBaazar API. A single stateless HTTP server: runs on Render, a VPS or AWS unchanged.
//
//	main.go   start-up, routing, middleware, shared helpers
//	shop.go   everything customers use
//	admin.go  everything behind the admin token
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

//go:embed schema.sql
var schema string

//go:embed defaults.json
var defaultsJSON []byte

//go:embed content-updates.json
var contentUpdates []byte

const localAdminToken = "local-admin-token-for-this-computer-only"

var (
	db  *pgxpool.Pool
	dev = os.Getenv("DEV") != ""

	// Snapshots rebuilt only after a write, so browsing and builds never wake the database.
	stockSnap, catalogSnap, storefrontSnap atomic.Pointer[[]byte]
	snapMu                                 sync.Mutex

	httpClient = &http.Client{Timeout: 8 * time.Second}
)

func main() {
	ctx := context.Background()
	if err := connect(ctx); err != nil {
		log.Fatal(err)
	}
	if len(os.Args) >= 3 && os.Args[1] == "seed" {
		content := ""
		if len(os.Args) > 3 {
			content = os.Args[3]
		}
		if err := seed(ctx, os.Args[2], content); err != nil {
			log.Fatal(err)
		}
		return
	}
	if !dev {
		if err := checkConfig(os.Getenv("DATABASE_URL"), os.Getenv("ADMIN_TOKEN"), os.Getenv("ORIGIN_SECRET")); err != nil {
			log.Fatal("STARTUP STOPPED: ", err, ". Fix it in Render, under Environment, then redeploy")
		}
	}
	go func() { // in the background, so /api/health answers even while the database wakes up
		c, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		if _, err := db.Exec(c, schema); err != nil {
			log.Print("schema: ", err)
			return
		}
		if err := applyContentUpdates(c); err != nil {
			log.Print("content updates: ", err)
		}
	}()
	addr := "127.0.0.1:8080"
	if p := os.Getenv("PORT"); p != "" {
		addr = ":" + p
	}
	srv := &http.Server{Addr: addr, Handler: router(), ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 90 * time.Second, WriteTimeout: 120 * time.Second, IdleTimeout: 2 * time.Minute}
	go func() { // Render sends SIGTERM on deploys: let orders in progress finish
		stop, cancel := signal.NotifyContext(ctx, syscall.SIGTERM, os.Interrupt)
		defer cancel()
		<-stop.Done()
		c, done := context.WithTimeout(ctx, 20*time.Second)
		defer done()
		srv.Shutdown(c)
	}()
	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// checkConfig stops a live shop starting with missing settings or weak secrets. The local admin
// token is public (it's in the README) and long enough to pass a length check, so it is refused by name.
func checkConfig(database, admin, origin string) error {
	switch {
	case !strings.HasPrefix(database, "postgres"):
		return errors.New("DATABASE_URL must be the Neon connection string, starting with postgres, with no quotes")
	case admin == localAdminToken:
		return errors.New("ADMIN_TOKEN is the public local token. Generate your own with: openssl rand -hex 32")
	case len(admin) < 32:
		return errors.New("ADMIN_TOKEN is missing or under 32 characters. Generate one with: openssl rand -hex 32")
	case len(origin) < 32:
		return errors.New("ORIGIN_SECRET is missing or under 32 characters. Generate one with: openssl rand -hex 32")
	}
	return nil
}

func connect(ctx context.Context) error {
	cfg, err := pgxpool.ParseConfig(os.Getenv("DATABASE_URL"))
	if err != nil {
		return err
	}
	cfg.MinConns, cfg.MaxConns, cfg.MaxConnIdleTime = 0, 4, 2*time.Minute // lets Neon sleep
	cfg.ConnConfig.DefaultQueryExecMode = pgx.QueryExecModeExec           // PgBouncer transaction mode
	db, err = pgxpool.NewWithConfig(ctx, cfg)
	return err
}

// seed loads the imported catalogue. It is safe to re-run: existing products are left alone, and
// content of a kind the shop already has is skipped, so anything the admin deleted stays deleted.
func seed(ctx context.Context, productsFile, contentFile string) error {
	if _, err := db.Exec(ctx, schema); err != nil {
		return err
	}
	b, err := os.ReadFile(productsFile)
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
	if contentFile == "" {
		return nil
	}
	if b, err = os.ReadFile(contentFile); err != nil {
		return err
	}
	var content map[string][]map[string]any
	if err = json.Unmarshal(b, &content); err != nil {
		return err
	}
	for key, kind := range map[string]string{"cats": "cat", "tags": "tag", "pages": "page", "posts": "post"} {
		var has bool
		if err = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content WHERE kind=$1)`, kind).Scan(&has); err != nil {
			return err
		}
		if has {
			continue
		}
		for _, c := range content[key] {
			j, _ := json.Marshal(c)
			if _, err = db.Exec(ctx, `INSERT INTO content(kind,slug,data) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING`, kind, c["slug"], string(j)); err != nil {
				return err
			}
		}
	}
	return applyContentUpdates(ctx)
}

// applyContentUpdates reaches shops that are already seeded, which seed itself leaves alone. Each
// update runs once. A page only changes if it still holds the old text it "replaces", so the admin's
// own rewrite is kept. An empty database is skipped, so updates still run after seed on a new shop.
func applyContentUpdates(ctx context.Context) error {
	var list []struct {
		ID   string
		Docs []struct {
			Kind, Slug, Replaces string
			Data                 map[string]any
		}
		Names  []struct{ Kind, Slug, Name string }
		Remove []struct{ Kind, Slug string }
		Text   []struct{ Field, Find, To string } // product wording only, never a name or price
		SQL    []string
	}
	if err := json.Unmarshal(contentUpdates, &list); err != nil {
		return err
	}
	for _, u := range list {
		err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
			var seeded bool
			if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content)`).Scan(&seeded); err != nil || !seeded {
				return err
			}
			tag, err := tx.Exec(ctx, `INSERT INTO applied(name) VALUES($1) ON CONFLICT DO NOTHING`, u.ID)
			if err != nil || tag.RowsAffected() == 0 {
				return err
			}
			for _, d := range u.Docs {
				d.Data["slug"] = d.Slug
				j, _ := json.Marshal(d.Data)
				if _, err = tx.Exec(ctx, `UPDATE content SET data=$3::jsonb WHERE kind=$1 AND slug=$2 AND position($4 in data->>'html')>0`, d.Kind, d.Slug, string(j), d.Replaces); err != nil {
					return err
				}
			}
			for _, n := range u.Names {
				if _, err = tx.Exec(ctx, `UPDATE content SET data=jsonb_set(data,'{name}',to_jsonb($3::text)) WHERE kind=$1 AND slug=$2`, n.Kind, n.Slug, n.Name); err != nil {
					return err
				}
			}
			for _, r := range u.Remove { // a category a product uses is kept: only empty leftovers go
				if _, err = tx.Exec(ctx, `DELETE FROM content WHERE kind=$1 AND slug=$2 AND NOT EXISTS(SELECT 1 FROM products WHERE data->'cats' @> to_jsonb($2::text))`, r.Kind, r.Slug); err != nil {
					return err
				}
			}
			for _, t := range u.Text {
				if t.Field != "short" && t.Field != "desc" {
					return fmt.Errorf("content update %s: field %q is not product wording", u.ID, t.Field)
				}
				if _, err = tx.Exec(ctx, `UPDATE products SET data=jsonb_set(data,ARRAY[$1::text],to_jsonb(replace(data->>$1::text,$2::text,$3::text))) WHERE position($2::text in coalesce(data->>$1::text,''))>0`, t.Field, t.Find, t.To); err != nil {
					return err
				}
			}
			for _, q := range u.SQL {
				if _, err = tx.Exec(ctx, q); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			return err
		}
	}
	return nil
}

func router() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.Recoverer, middleware.Timeout(45*time.Second), originGuard)
	r.Get("/api/health", func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) })
	r.Get("/api/catalog", catalog)
	r.Get("/api/storefront", storefront)
	r.Get("/api/stock", stockFile)
	r.With(limit(30, 10*time.Minute)).Post("/api/checkout", checkout)
	r.With(limit(30, 10*time.Minute)).Post("/api/coupon", couponPreview)
	r.With(limit(30, 5*time.Minute)).Get("/api/track", track)
	r.With(limit(5, 10*time.Minute)).Post("/api/contact", contact)
	r.With(limit(5, 10*time.Minute)).Post("/api/reviews", review)
	r.With(limit(10, time.Hour)).Post("/api/register", register)
	r.With(limit(20, 5*time.Minute)).Post("/api/login", login)
	r.With(limit(10, 5*time.Minute)).Post("/api/password", changePassword)
	r.Post("/api/logout", logout)
	r.Get("/api/me", me)
	r.Route("/api/admin", func(a chi.Router) {
		a.Use(adminOnly)
		a.Get("/dashboard", adminDashboard)
		a.Get("/orders", adminOrders)
		a.Get("/orders.csv", adminOrdersCSV)
		a.Put("/orders/{number}", adminUpdateOrder)
		a.Get("/customers", adminCustomers)
		a.Post("/customers/password", adminResetPassword)
		a.Get("/products", adminProducts)
		a.Post("/products", adminSaveProduct)
		a.Put("/products/{id}", adminSaveProduct)
		a.Patch("/products/{id}", adminQuickEdit)
		a.Delete("/products/{id}", adminHideProduct)
		a.Get("/content/{kind}", adminContent)
		a.Put("/content/{kind}/{slug}", adminSaveContent)
		a.Delete("/content/{kind}/{slug}", adminDeleteContent)
		a.Get("/coupons", adminCoupons)
		a.Put("/coupons/{code}", adminSaveCoupon)
		a.Delete("/coupons/{code}", adminDeleteCoupon)
		a.Get("/reviews", adminReviews)
		a.Put("/reviews/{id}", adminApproveReview)
		a.Delete("/reviews/{id}", adminDeleteReview)
		a.Get("/messages", adminMessages)
		a.Put("/messages/{id}", adminReadMessage)
		a.Delete("/messages/{id}", adminDeleteMessage)
		a.Get("/settings", adminSettings)
		a.Put("/settings", adminSaveSettings)
		a.Post("/image", adminImage)
		a.Post("/publish", adminPublish)
	})
	return r
}

// originGuard rejects requests that did not come through the Cloudflare Worker. /api/health is
// open because Render's own health check can't send the secret, and it reveals nothing.
func originGuard(next http.Handler) http.Handler {
	want := os.Getenv("ORIGIN_SECRET")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if want != "" && r.URL.Path != "/api/health" && !same(r.Header.Get("X-Origin-Secret"), want) {
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

var (
	hitsMu sync.Mutex
	hits   = map[string][]time.Time{}
)

// allow is a sliding window kept in memory. It resets on restart, which is fine: it only has to
// stop one address guessing passwords or filling the database. Limits are generous because many
// Bangladeshi mobile customers share one address.
func allow(key string, max int, per time.Duration) bool {
	hitsMu.Lock()
	defer hitsMu.Unlock()
	if len(hits) > 20000 {
		clear(hits)
	}
	cut, now := time.Now().Add(-per), time.Now()
	kept := hits[key][:0]
	for _, t := range hits[key] {
		if t.After(cut) {
			kept = append(kept, t)
		}
	}
	if len(kept) >= max {
		hits[key] = kept
		return false
	}
	hits[key] = append(kept, now)
	return true
}

func limit(max int, per time.Duration) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !dev && !allow(r.URL.Path+"|"+clientIP(r), max, per) {
				fail(w, 429, "too many attempts, please wait a few minutes or call us")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// clientIP trusts X-Client-IP because originGuard proves the request came through the Worker.
func clientIP(r *http.Request) string {
	if ip := r.Header.Get("X-Client-IP"); ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// userErr is a problem the customer or admin can act on. Returning one from a transaction rolls it back.
type userErr struct {
	code int
	msg  string
}

func (e userErr) Error() string { return e.msg }

func same(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

func ok(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func done(w http.ResponseWriter) { ok(w, map[string]bool{"ok": true}) }

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
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
	var ue userErr
	if errors.As(err, &ue) {
		fail(w, ue.code, ue.msg)
		return
	}
	log.Print(err)
	fail(w, 500, "something went wrong, please call us")
}

// writeList answers with every JSON value a one-column query returns.
func writeList(w http.ResponseWriter, r *http.Request, sql string, args ...any) {
	list, err := jsonRows(r.Context(), sql, args...)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, list)
}

func jsonRows(ctx context.Context, sql string, args ...any) ([]json.RawMessage, error) {
	rows, err := db.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	list, err := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if list == nil {
		list = []json.RawMessage{}
	}
	return list, err
}

func token(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

// clip trims text and caps its length in characters, never splitting a Bangla letter.
func clip(s string, max int) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > max {
		return string(r[:max])
	}
	return s
}

func paramID(r *http.Request, name string) int64 {
	id, _ := strconv.ParseInt(chi.URLParam(r, name), 10, 64)
	return id
}
