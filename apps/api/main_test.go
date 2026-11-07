package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestNormPhone(t *testing.T) {
	for in, want := range map[string]string{
		"01710076076": "01710076076", "017-1007 6076": "01710076076", "+8801710076076": "01710076076",
		"8801710076076": "01710076076", "০১৭১০০৭৬০৭৬": "01710076076", "+৮৮০১৭১০০৭৬০৭৬": "01710076076",
	} {
		if got := normPhone(in); got != want {
			t.Errorf("normPhone(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestMergeItems(t *testing.T) {
	got, err := mergeItems([]item{{9, 1}, {2, 3}, {9, 4}})
	if err != nil || len(got) != 2 || got[0] != (item{2, 3}) || got[1] != (item{9, 5}) {
		t.Fatalf("got %v, %v", got, err)
	}
	if _, err := mergeItems([]item{{1, 15}, {1, 15}}); err == nil {
		t.Error("two lines adding up past the limit must fail")
	}
	if _, err := mergeItems([]item{{1, 0}}); err == nil {
		t.Error("zero quantity must fail")
	}
}

func TestDiscountOf(t *testing.T) {
	if d := discountOf("percent", 10, 1999); d != 199 {
		t.Errorf("percent: %d", d)
	}
	if d := discountOf("amount", 500, 300); d != 300 {
		t.Errorf("a discount can never exceed the goods: %d", d)
	}
}

func TestCSVSafe(t *testing.T) {
	if s := csvSafe(`=HYPERLINK("http://x")`); !strings.HasPrefix(s, "'") {
		t.Errorf("formula not neutralised: %s", s)
	}
	if s := csvSafe("01710076076"); s != "01710076076" {
		t.Errorf("phone changed: %s", s)
	}
}

func TestCheckConfig(t *testing.T) {
	good, db := strings.Repeat("a", 64), "postgresql://u:p@host/db?sslmode=require"
	if err := checkConfig(db, good, good); err != nil {
		t.Error(err)
	}
	for name, err := range map[string]error{
		"local token": checkConfig(db, localAdminToken, good),
		"short admin": checkConfig(db, "short", good),
		"no origin":   checkConfig(db, good, ""),
		"no database": checkConfig("", good, good),
		"quoted url":  checkConfig("'postgres://u:p@host/db'", good, good),
	} {
		if err == nil {
			t.Error(name + " must be refused")
		}
	}
}

func TestHealthPassesTheOriginGuard(t *testing.T) {
	t.Setenv("ORIGIN_SECRET", "a-secret-only-the-worker-knows")
	h := originGuard(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	for path, want := range map[string]int{"/api/health": 200, "/api/catalog": 403, "/api/admin/orders": 403} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != want {
			t.Errorf("%s: %d, want %d", path, rec.Code, want)
		}
	}
}

func TestUploadPlace(t *testing.T) {
	if dir, id := uploadPlace("products/rice-cooker", "kiam-1"); dir != "loverbaazar/products/rice-cooker" || id != dir+"/kiam-1" {
		t.Error(dir, id)
	}
	if dir, id := uploadPlace("../secret", "a/b"); dir != "loverbaazar/uploads" || !strings.Contains(id, "/image-") {
		t.Error(dir, id)
	}
}

func TestSignUpload(t *testing.T) {
	// The worked example in Cloudinary's signature documentation.
	got := signUpload(map[string]string{"eager": "w_400,h_300,c_pad|w_260,h_200,c_crop", "public_id": "sample_image", "timestamp": "1315060510"}, "abcd")
	if got != "bfd09f95f331f558cbd1320e67aa8d488770583e" {
		t.Error(got)
	}
}

func TestAllow(t *testing.T) {
	key := fmt.Sprint("t", time.Now().UnixNano())
	for i := 0; i < 3; i++ {
		if !allow(key, 3, time.Minute) {
			t.Fatal("blocked too early")
		}
	}
	if allow(key, 3, time.Minute) {
		t.Fatal("the fourth attempt must be blocked")
	}
}

// The tests below run against a real, throwaway database:
// TEST_DATABASE_URL=postgres://... go test .
// They erase every table, so never point this at a database you care about.
var (
	api *httptest.Server
	bg  = context.Background()
)

const adminKey = "test-admin-token-test-admin-token-1234"

func TestMain(m *testing.M) {
	url := os.Getenv("TEST_DATABASE_URL")
	if url != "" {
		if !strings.Contains(url, "127.0.0.1") && !strings.Contains(url, "localhost") {
			panic("TEST_DATABASE_URL must be a local database: these tests erase every table")
		}
		dev = true
		os.Setenv("DATABASE_URL", url)
		os.Setenv("ADMIN_TOKEN", adminKey)
		if err := connect(bg); err != nil {
			panic(err)
		}
		if _, err := db.Exec(bg, schema); err != nil {
			panic(err)
		}
		api = httptest.NewServer(router())
		defer api.Close()
	}
	os.Exit(m.Run())
}

func reset(t *testing.T) {
	t.Helper()
	if api == nil {
		t.Skip("needs TEST_DATABASE_URL")
	}
	if _, err := db.Exec(bg, `TRUNCATE applied,products,users,sessions,orders,order_items,order_events,messages,settings,content,coupons,reviews RESTART IDENTITY CASCADE`); err != nil {
		t.Fatal(err)
	}
	// Fixed charges here, so the tests don't depend on what the shop happens to charge today.
	if _, err := db.Exec(bg, `INSERT INTO settings VALUES('live','{"delivery":[{"id":"jashore","label":"Inside Jashore","fee":60},{"id":"outside","label":"Outside Jashore","fee":100}]}')`); err != nil {
		t.Fatal(err)
	}
	stockSnap.Store(nil)
	catalogSnap.Store(nil)
	storefrontSnap.Store(nil)
	product(t, 1, 1000, 50)
	product(t, 2, 500, 50)
}

func product(t *testing.T, id, price int64, stock int) {
	t.Helper()
	data := fmt.Sprintf(`{"id":%d,"slug":"p%d","name":"Product %d","cats":[],"tags":[],"images":[],"attrs":[]}`, id, id, id)
	if _, err := db.Exec(bg, `INSERT INTO products(id,slug,price,regular,stock,data) VALUES($1,$2,$3,$3,$4,$5::jsonb)`, id, fmt.Sprint("p", id), price, stock, data); err != nil {
		t.Fatal(err)
	}
}

func stockOf(t *testing.T, id int64) int {
	t.Helper()
	var n int
	if err := db.QueryRow(bg, `SELECT stock FROM products WHERE id=$1`, id).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

type M = map[string]any

func call(t *testing.T, c *http.Client, method, path string, body any, admin bool) (int, M) {
	t.Helper()
	var r *bytes.Reader = bytes.NewReader(nil)
	if body != nil {
		b, _ := json.Marshal(body)
		r = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, api.URL+path, r)
	if admin {
		req.Header.Set("X-Admin-Token", adminKey)
	}
	if c == nil {
		c = http.DefaultClient
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	out := M{}
	json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func order(extra M, items ...M) M {
	o := M{"items": items, "name": "Rahim", "phone": "01710076076", "address": "House 1, Jashore", "area": "jashore", "payment": "cod"}
	for k, v := range extra {
		o[k] = v
	}
	return o
}

func TestCheckoutUsesDatabasePrice(t *testing.T) {
	reset(t)
	code, out := call(t, nil, "POST", "/api/checkout", order(M{"price": 1, "total": 1}, M{"id": 1, "qty": 2, "price": 1}), false)
	if code != 200 || out["total"].(float64) != 2060 {
		t.Fatalf("%d %v", code, out)
	}
}

func TestDuplicateLinesAreMerged(t *testing.T) {
	reset(t)
	code, out := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}, M{"id": 1, "qty": 2}), false)
	if code != 200 || out["total"].(float64) != 3060 || stockOf(t, 1) != 47 {
		t.Fatalf("%d %v stock=%d", code, out, stockOf(t, 1))
	}
}

func TestLastUnitSellsOnce(t *testing.T) {
	reset(t)
	product(t, 3, 100, 1)
	var wg sync.WaitGroup
	var mu sync.Mutex
	codes := map[int]int{}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, _ := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 3, "qty": 1}), false)
			mu.Lock()
			codes[code]++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if codes[200] != 1 || codes[409] != 19 || stockOf(t, 3) != 0 {
		t.Fatalf("codes %v stock %d", codes, stockOf(t, 3))
	}
}

// Logged-in buyers used to look up their session inside the transaction and could hang for ever.
func TestLoggedInCheckoutsDoNotHang(t *testing.T) {
	reset(t)
	saveLive(t, func(l M) { l["maxPending"] = 0 }) // this test places many orders on one number
	jar, _ := cookiejar.New(nil)
	user := &http.Client{Jar: jar, Timeout: 20 * time.Second}
	if code, out := call(t, user, "POST", "/api/register", M{"name": "Rahim", "phone": "01710076076", "password": "password1"}, false); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if code, out := call(t, user, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}, M{"id": 2, "qty": 1}), false); code != 200 {
				t.Errorf("%d %v", code, out)
			}
		}()
	}
	wg.Wait()
	_, me := call(t, user, "GET", "/api/me", nil, false)
	if n := len(me["orders"].([]any)); n != 12 {
		t.Fatalf("orders on account: %d", n)
	}
}

func TestSameKeyMakesOneOrder(t *testing.T) {
	reset(t)
	var wg sync.WaitGroup
	numbers := sync.Map{}
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			code, out := call(t, nil, "POST", "/api/checkout", order(M{"key": "abc-123"}, M{"id": 1, "qty": 1}), false)
			if code != 200 {
				t.Errorf("%d %v", code, out)
				return
			}
			numbers.Store(out["number"], true)
		}()
	}
	wg.Wait()
	var n int
	db.QueryRow(bg, `SELECT count(*) FROM orders`).Scan(&n)
	if n != 1 || stockOf(t, 1) != 49 {
		t.Fatalf("orders %d stock %d", n, stockOf(t, 1))
	}
}

func TestDeliveryCharges(t *testing.T) {
	reset(t)
	if _, out := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false); out["total"].(float64) != 1060 {
		t.Fatalf("inside Jashore: %v", out)
	}
	if _, out := call(t, nil, "POST", "/api/checkout", order(M{"area": "outside"}, M{"id": 1, "qty": 1}), false); out["total"].(float64) != 1100 {
		t.Fatalf("outside Jashore: %v", out)
	}
}

func TestGuestNeedsNoAccount(t *testing.T) {
	reset(t)
	code, out := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false)
	if code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	var users int
	db.QueryRow(bg, `SELECT count(*) FROM users`).Scan(&users)
	if users != 0 {
		t.Fatalf("a guest order created %d accounts", users)
	}
	if code, _ := call(t, nil, "GET", "/api/track?order="+out["number"].(string)+"&phone=01710076076", nil, false); code != 200 {
		t.Fatalf("guest tracking: %d", code)
	}
}

func TestOneNumberCantHoldTheStock(t *testing.T) {
	reset(t)
	var first string
	for i := 0; i < 3; i++ {
		code, out := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false)
		if code != 200 {
			t.Fatalf("order %d: %d %v", i, code, out)
		}
		first, _ = out["number"].(string)
	}
	if code, _ := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false); code != 429 || stockOf(t, 1) != 47 {
		t.Fatalf("fourth waiting order: %d stock %d", code, stockOf(t, 1))
	}
	call(t, nil, "PUT", "/api/admin/orders/"+first, M{"status": "confirmed"}, true)
	if code, _ := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false); code != 200 {
		t.Fatalf("after one is confirmed: %d", code)
	}
}

func TestTransactionIDCantPayTwice(t *testing.T) {
	reset(t)
	paid := M{"payment": "bkash", "txnid": "ABC12345"}
	code, out := call(t, nil, "POST", "/api/checkout", order(paid, M{"id": 1, "qty": 1}), false)
	if code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	again := M{"payment": "nagad", "txnid": "abc12345", "phone": "01810000000"}
	if code, _ := call(t, nil, "POST", "/api/checkout", order(again, M{"id": 1, "qty": 1}), false); code != 409 {
		t.Fatalf("same ID on a second order: %d", code)
	}
	call(t, nil, "PUT", "/api/admin/orders/"+out["number"].(string), M{"status": "cancelled"}, true)
	if code, _ := call(t, nil, "POST", "/api/checkout", order(again, M{"id": 1, "qty": 1}), false); code != 200 {
		t.Fatalf("a cancelled order frees its ID: %d", code)
	}
}

func TestChangedTotalIsRefused(t *testing.T) {
	reset(t)
	code, _ := call(t, nil, "POST", "/api/checkout", order(M{"expected": 999}, M{"id": 1, "qty": 1}), false)
	if code != 409 || stockOf(t, 1) != 50 {
		t.Fatalf("%d stock %d", code, stockOf(t, 1))
	}
}

func TestCancelReturnsStockOnce(t *testing.T) {
	reset(t)
	_, out := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 3}), false)
	path := "/api/admin/orders/" + out["number"].(string)
	for i := 0; i < 2; i++ {
		if code, res := call(t, nil, "PUT", path, M{"status": "cancelled"}, true); code != 200 {
			t.Fatalf("%d %v", code, res)
		}
	}
	if stockOf(t, 1) != 50 {
		t.Fatalf("stock %d", stockOf(t, 1))
	}
	if code, _ := call(t, nil, "PUT", path, M{"status": "pending"}, true); code != 409 {
		t.Fatalf("reopening must be refused, got %d", code)
	}
	if code, _ := call(t, nil, "PUT", "/api/admin/orders/LB-NOPE", M{"status": "shipped"}, true); code != 404 {
		t.Fatalf("unknown order: %d", code)
	}
}

// A form opened before a sale must not put the sold units back when saved.
func TestAdminSaveKeepsConcurrentSales(t *testing.T) {
	reset(t)
	call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 4}), false) // 50 -> 46 while the form shows 50
	body := M{"name": "Renamed", "slug": "p1", "price": 1200, "regular": 1200, "stockDelta": 10}
	if code, out := call(t, nil, "PUT", "/api/admin/products/1", body, true); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	if stockOf(t, 1) != 56 {
		t.Fatalf("want 46+10, got %d", stockOf(t, 1))
	}
	if code, out := call(t, nil, "PATCH", "/api/admin/products/1", M{"stockDelta": -100}, true); code != 200 || out["stock"].(float64) != 0 {
		t.Fatalf("stock must stop at zero: %d %v", code, out)
	}
}

func TestNewProductAndSlugClash(t *testing.T) {
	reset(t)
	code, out := call(t, nil, "POST", "/api/admin/products", M{"name": "New", "slug": "new-one", "price": 10, "regular": 0, "stock": 7}, true)
	if code != 200 || stockOf(t, int64(out["id"].(float64))) != 7 {
		t.Fatalf("%d %v", code, out)
	}
	if code, _ := call(t, nil, "POST", "/api/admin/products", M{"name": "Clash", "slug": "new-one", "price": 10, "regular": 10}, true); code != 409 {
		t.Fatalf("slug clash: %d", code)
	}
	if code, _ := call(t, nil, "POST", "/api/admin/products", M{"name": "Bad", "slug": "a/b", "price": 10, "regular": 10}, true); code != 400 {
		t.Fatalf("bad slug: %d", code)
	}
	if code, _ := call(t, nil, "POST", "/api/admin/products", M{"name": "Bad", "slug": "bad", "price": 10.5, "regular": 11}, true); code != 400 {
		t.Fatalf("fractional taka: %d", code)
	}
}

func TestCouponLimitAndReturn(t *testing.T) {
	reset(t)
	coupon := M{"kind": "percent", "value": 10, "minOrder": 500, "maxUses": 1, "active": true}
	if code, out := call(t, nil, "PUT", "/api/admin/coupons/save10", coupon, true); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	if code, out := call(t, nil, "POST", "/api/coupon", M{"code": "save10", "items": []M{{"id": 1, "qty": 1}}}, false); code != 200 || out["discount"].(float64) != 100 {
		t.Fatalf("preview %d %v", code, out)
	}
	if code, _ := call(t, nil, "POST", "/api/coupon", M{"code": "SAVE10", "items": []M{{"id": 2, "qty": 0}}}, false); code != 400 {
		t.Fatalf("below minimum: %d", code)
	}
	code, out := call(t, nil, "POST", "/api/checkout", order(M{"coupon": "save10"}, M{"id": 1, "qty": 1}), false)
	if code != 200 || out["total"].(float64) != 960 {
		t.Fatalf("%d %v", code, out)
	}
	if code, _ := call(t, nil, "POST", "/api/checkout", order(M{"coupon": "SAVE10"}, M{"id": 1, "qty": 1}), false); code != 400 || stockOf(t, 1) != 49 {
		t.Fatalf("second use: %d stock %d", code, stockOf(t, 1))
	}
	call(t, nil, "PUT", "/api/admin/orders/"+out["number"].(string), M{"status": "cancelled"}, true)
	if code, _ := call(t, nil, "POST", "/api/checkout", order(M{"coupon": "SAVE10"}, M{"id": 1, "qty": 1}), false); code != 200 {
		t.Fatalf("cancelling must give the use back: %d", code)
	}
}

func saveLive(t *testing.T, change func(M)) {
	t.Helper()
	_, s := call(t, nil, "GET", "/api/admin/settings", nil, true)
	change(s["live"].(M))
	if code, out := call(t, nil, "PUT", "/api/admin/settings", s, true); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
}

func TestLiveSettings(t *testing.T) {
	reset(t)
	saveLive(t, func(l M) {
		l["delivery"] = []M{{"id": "ctg", "label": "Chattogram", "fee": 90}}
		l["freeOver"] = 2000
	})
	if code, _ := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false); code != 400 {
		t.Fatalf("a removed area must be refused: %d", code)
	}
	if _, out := call(t, nil, "POST", "/api/checkout", order(M{"area": "ctg"}, M{"id": 1, "qty": 1}), false); out["total"].(float64) != 1090 {
		t.Fatalf("%v", out)
	}
	if _, out := call(t, nil, "POST", "/api/checkout", order(M{"area": "ctg"}, M{"id": 1, "qty": 2}), false); out["total"].(float64) != 2000 {
		t.Fatalf("free delivery: %v", out)
	}
	saveLive(t, func(l M) { l["ordersOpen"] = false })
	if code, _ := call(t, nil, "POST", "/api/checkout", order(M{"area": "ctg"}, M{"id": 1, "qty": 1}), false); code != 503 {
		t.Fatalf("closed shop: %d", code)
	}
	_, snap := call(t, nil, "GET", "/api/stock", nil, false)
	if snap["settings"].(M)["ordersOpen"] != false || snap["products"].(M)["1"] == nil {
		t.Fatalf("snapshot: %v", snap)
	}
	if code, _ := call(t, nil, "PUT", "/api/admin/settings", M{"live": M{}, "site": M{}}, true); code != 400 {
		t.Fatalf("empty settings must be refused: %d", code)
	}
}

func TestPublicSnapshotsSkipTheDatabase(t *testing.T) {
	reset(t)
	for _, p := range []string{"/api/catalog", "/api/storefront", "/api/stock"} {
		call(t, nil, "GET", p, nil, false)
		before := db.Stat().AcquireCount()
		res, err := http.Get(api.URL + p)
		if err != nil || res.StatusCode != 200 {
			t.Fatal(p, err)
		}
		res.Body.Close()
		if after := db.Stat().AcquireCount(); after != before {
			t.Errorf("%s used the database", p)
		}
	}
}

func TestPrivacyAndAuth(t *testing.T) {
	reset(t)
	if code, _ := call(t, nil, "GET", "/api/admin/orders", nil, false); code != 401 {
		t.Fatalf("no token: %d", code)
	}
	_, out := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false)
	num := out["number"].(string)
	call(t, nil, "PUT", "/api/admin/orders/"+num, M{"adminNote": "fraud risk", "courier": "Steadfast", "tracking": "T1", "status": "shipped"}, true)
	if code, _ := call(t, nil, "GET", "/api/track?order="+num+"&phone=01999999999", nil, false); code != 404 {
		t.Fatalf("wrong phone: %d", code)
	}
	code, o := call(t, nil, "GET", "/api/track?order="+strings.ToLower(num)+"&phone=%2B8801710076076", nil, false)
	if code != 200 || o["admin_note"] != nil || o["courier"] != "Steadfast" || len(o["events"].([]any)) != 2 {
		t.Fatalf("%d %v", code, o)
	}
}

func TestReviewNeedsApproval(t *testing.T) {
	reset(t)
	if code, out := call(t, nil, "POST", "/api/reviews", M{"product": 1, "rating": 5, "name": "Karim", "body": "Works well"}, false); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	var count = func() int {
		res, err := http.Get(api.URL + "/api/catalog")
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		var list []M
		json.NewDecoder(res.Body).Decode(&list)
		for _, p := range list {
			if p["id"].(float64) == 1 {
				return len(p["reviews"].([]any))
			}
		}
		return -1
	}
	if n := count(); n != 0 {
		t.Fatalf("unapproved review is public: %d", n)
	}
	call(t, nil, "PUT", "/api/admin/reviews/1", M{}, true)
	if n := count(); n != 1 {
		t.Fatalf("approved review missing: %d", n)
	}
}

func TestContent(t *testing.T) {
	reset(t)
	if code, _ := call(t, nil, "PUT", "/api/admin/content/page/checkout", M{"title": "x", "html": "y"}, true); code != 400 {
		t.Fatalf("reserved slug: %d", code)
	}
	if code, out := call(t, nil, "PUT", "/api/admin/content/post/hello", M{"title": "Hello", "html": "<p>x</p>"}, true); code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	if code, _ := call(t, nil, "PUT", "/api/admin/content/page/hello", M{"title": "Clash", "html": "y"}, true); code != 409 {
		t.Fatalf("page and post on one address: %d", code)
	}
	if code, _ := call(t, nil, "PUT", "/api/admin/content/cat/sub", M{"name": "Sub", "path": "top/sub"}, true); code != 200 {
		t.Fatal(code)
	}
	if code, _ := call(t, nil, "PUT", "/api/admin/content/cat/bad", M{"name": "Bad", "path": "top/other"}, true); code != 400 {
		t.Fatal(code)
	}
	if _, err := db.Exec(bg, `UPDATE products SET data=data||'{"cats":["sub"]}' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, nil, "DELETE", "/api/admin/content/cat/sub", nil, true); code != 409 {
		t.Fatalf("category in use: %d", code)
	}
	if code, _ := call(t, nil, "PUT", "/api/admin/content/page/draft-page", M{"title": "Draft", "html": "y", "draft": true}, true); code != 200 {
		t.Fatal(code)
	}
	_, s := call(t, nil, "GET", "/api/storefront", nil, false)
	if len(s["pages"].([]any)) != 0 || len(s["posts"].([]any)) != 1 || s["site"].(M)["name"] != "LoverBaazar" {
		t.Fatalf("%v", s)
	}
}

func TestDashboardAndExports(t *testing.T) {
	reset(t)
	call(t, nil, "POST", "/api/checkout", order(M{"name": "=cmd()"}, M{"id": 1, "qty": 1}), false)
	code, d := call(t, nil, "GET", "/api/admin/dashboard", nil, true)
	if code != 200 || d["todayOrders"].(float64) != 1 || d["todaySales"].(float64) != 1060 || len(d["series"].([]any)) != 14 {
		t.Fatalf("%d %v", code, d)
	}
	code, o := call(t, nil, "GET", "/api/admin/orders?q=01710&status=pending", nil, true)
	if code != 200 || o["total"].(float64) != 1 {
		t.Fatalf("%d %v", code, o)
	}
	code, c := call(t, nil, "GET", "/api/admin/orders?status=shipped", nil, true)
	if code != 200 || c["total"].(float64) != 0 {
		t.Fatalf("%d %v", code, c)
	}
	req, _ := http.NewRequest("GET", api.URL+"/api/admin/orders.csv", nil)
	req.Header.Set("X-Admin-Token", adminKey)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var buf bytes.Buffer
	buf.ReadFrom(res.Body)
	if !strings.Contains(buf.String(), `'=cmd()`) || !strings.Contains(buf.String(), "Product 1 x1") {
		t.Fatal(buf.String())
	}
	if _, err := db.Exec(bg, `INSERT INTO users(name,phone,password_hash) VALUES('A','01810000000','x')`); err != nil {
		t.Fatal(err)
	}
	if code, out := call(t, nil, "POST", "/api/admin/customers/password", M{"phone": "01810000000"}, true); code != 200 || len(out["password"].(string)) != 10 {
		t.Fatalf("%d %v", code, out)
	}
}

func TestContentUpdatesRunOnceAndKeepOwnerEdits(t *testing.T) {
	reset(t)
	put := func(kind, slug, data string) {
		t.Helper()
		if _, err := db.Exec(bg, `INSERT INTO content(kind,slug,data) VALUES($1,$2,$3::jsonb)`, kind, slug, data); err != nil {
			t.Fatal(err)
		}
	}
	html := func(slug string) string {
		t.Helper()
		var s string
		if err := db.QueryRow(bg, `SELECT data->>'html' FROM content WHERE slug=$1`, slug).Scan(&s); err != nil {
			t.Fatal(err)
		}
		return s
	}
	if err := applyContentUpdates(bg); err != nil { // an empty shop must not use up the update
		t.Fatal(err)
	}
	put("page", "about-us", `{"slug":"about-us","title":"About","html":"Our App store is coming"}`)
	put("page", "privacy-policy", `{"slug":"privacy-policy","title":"Privacy","html":"The owner wrote this"}`)
	put("post", "admission-information", `{"slug":"admission-information","title":"x","html":"y"}`)
	put("cat", "brand-1", `{"slug":"brand-1","name":"Brand 1"}`)
	put("cat", "shoes", `{"slug":"shoes","name":"Shoes"}`)
	if _, err := db.Exec(bg, `UPDATE products SET data=data||'{"cats":["shoes"]}' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if err := applyContentUpdates(bg); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(html("about-us"), "App store") {
		t.Error("old page text was not replaced")
	}
	if html("privacy-policy") != "The owner wrote this" {
		t.Error("a page the owner rewrote must be kept")
	}
	var left int
	db.QueryRow(bg, `SELECT count(*) FROM content WHERE slug IN('admission-information','brand-1')`).Scan(&left)
	if left != 0 {
		t.Errorf("%d leftovers remain", left)
	}
	db.QueryRow(bg, `SELECT count(*) FROM content WHERE slug='shoes'`).Scan(&left)
	if left != 1 {
		t.Error("a category with products must not be removed")
	}
	db.Exec(bg, `UPDATE content SET data=jsonb_set(data,'{html}','"Our App store again"') WHERE slug='about-us'`)
	if err := applyContentUpdates(bg); err != nil {
		t.Fatal(err)
	}
	if html("about-us") != "Our App store again" {
		t.Error("the update must run only once")
	}
}

func TestCouponPreviewRejectsBadQuantities(t *testing.T) {
	reset(t)
	if code, _ := call(t, nil, "POST", "/api/coupon", M{"code": "X", "items": []M{{"id": 1, "qty": -5}}}, false); code != 400 {
		t.Errorf("negative quantity: %d", code)
	}
}

func TestOwnerAnswersKeepLaterChanges(t *testing.T) {
	reset(t)
	exec := func(q string) {
		t.Helper()
		if _, err := db.Exec(bg, q); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO content(kind,slug,data) VALUES('post','luxury-collection','{"title":"x","html":"y"}'),('post','pureit-water-filter','{"title":"x","html":"kept"}')`)
	exec(`INSERT INTO settings VALUES('site','{"whatsapp":"","address":"Own address"}')`)
	if err := applyContentUpdates(bg); err != nil {
		t.Fatal(err)
	}
	live, site, err := loadSettings(bg)
	if err != nil {
		t.Fatal(err)
	}
	if live.Delivery[0].Fee != 0 || live.Delivery[1].Fee != 100 || live.Delivery[0].ID != "jashore" {
		t.Errorf("delivery: %+v", live.Delivery)
	}
	if site["whatsapp"] != "01710-076076" || site["address"] != "Own address" {
		t.Errorf("site: %v %v", site["whatsapp"], site["address"])
	}
	var posts int
	db.QueryRow(bg, `SELECT count(*) FROM content WHERE kind='post'`).Scan(&posts)
	if posts != 1 {
		t.Errorf("%d posts left, want 1", posts)
	}
}

func TestSeedKeepsDeletedContentDeleted(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	products := dir + "/products.json"
	content := dir + "/content.json"
	os.WriteFile(products, []byte(`[]`), 0o644)
	os.WriteFile(content, []byte(`{"posts":[{"slug":"a","title":"A","html":""},{"slug":"b","title":"B","html":""}]}`), 0o644)
	if err := seed(bg, products, content); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(bg, `DELETE FROM content WHERE slug='a'`); err != nil {
		t.Fatal(err)
	}
	if err := seed(bg, products, content); err != nil {
		t.Fatal(err)
	}
	var n int
	db.QueryRow(bg, `SELECT count(*) FROM content WHERE slug='a'`).Scan(&n)
	if n != 0 {
		t.Error("seed brought a deleted post back")
	}
}
