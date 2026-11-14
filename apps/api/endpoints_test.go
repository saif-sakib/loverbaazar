package main

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"strings"
	"testing"
)

// raw is call without the JSON decoding, for answers that are lists or plain text.
func raw(t *testing.T, method, path, body string, admin bool) (int, string) {
	t.Helper()
	req, _ := http.NewRequest(method, api.URL+path, strings.NewReader(body))
	if admin {
		req.Header.Set("X-Admin-Token", adminKey)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

func expect(t *testing.T, name, method, path string, body any, admin bool, want int, contains ...string) string {
	t.Helper()
	s, isText := body.(string)
	if !isText && body != nil {
		b, _ := json.Marshal(body)
		s = string(b)
	}
	code, out := raw(t, method, path, s, admin)
	if code != want {
		t.Errorf("%s: %s %s = %d, want %d: %.160s", name, method, path, code, want, out)
	}
	for _, c := range contains {
		if !strings.Contains(out, c) {
			t.Errorf("%s: answer lacks %q: %.200s", name, c, out)
		}
	}
	return out
}

func clearLimits() {
	hitsMu.Lock()
	clear(hits)
	hitsMu.Unlock()
}

func TestEveryAdminRouteNeedsTheToken(t *testing.T) {
	reset(t)
	for _, r := range [][2]string{
		{"GET", "dashboard"}, {"GET", "orders"}, {"GET", "orders.csv"}, {"PUT", "orders/X"}, {"GET", "customers"}, {"POST", "customers/password"},
		{"GET", "products"}, {"POST", "products"}, {"PUT", "products/1"}, {"PATCH", "products/1"}, {"DELETE", "products/1"},
		{"GET", "content/page"}, {"PUT", "content/page/x"}, {"DELETE", "content/page/x"}, {"GET", "coupons"}, {"PUT", "coupons/X"}, {"DELETE", "coupons/X"},
		{"GET", "reviews"}, {"PUT", "reviews/1"}, {"DELETE", "reviews/1"}, {"GET", "messages"}, {"PUT", "messages/1"}, {"DELETE", "messages/1"},
		{"GET", "settings"}, {"PUT", "settings"}, {"POST", "image"}, {"POST", "publish"},
	} {
		expect(t, "no token", r[0], "/api/admin/"+r[1], "{}", false, 401)
	}
	code, _ := call(t, nil, "GET", "/api/admin/settings", nil, false)
	if code != 401 {
		t.Error("settings without a token")
	}
}

func TestPublicReadEndpoints(t *testing.T) {
	reset(t)
	expect(t, "health", "GET", "/api/health", nil, false, 200, "ok")
	expect(t, "stock", "GET", "/api/stock", nil, false, 200, `"products"`, `"settings"`, `"delivery"`)
	expect(t, "catalog", "GET", "/api/catalog", nil, false, 200, "Product 1")
	expect(t, "storefront", "GET", "/api/storefront", nil, false, 200, `"site"`, `"live"`, `"cats"`, `"posts"`)
	expect(t, "hide", "PATCH", "/api/admin/products/2", M{"active": false}, true, 200)
	out := expect(t, "catalog after hide", "GET", "/api/catalog", nil, false, 200)
	if strings.Contains(out, "Product 2") {
		t.Error("a hidden product is still in the catalogue")
	}
	if out := expect(t, "stock after hide", "GET", "/api/stock", nil, false, 200); strings.Contains(out, `"2":`) {
		t.Error("a hidden product is still in stock data")
	}
}

func TestCheckoutInputs(t *testing.T) {
	reset(t)
	clearLimits()
	good := func(change M) M {
		m := M{"items": []M{{"id": 1, "qty": 1}}, "name": "Rahim", "phone": "01711111111", "address": "12 Road, Jashore", "area": "jashore", "payment": "cod"}
		for k, v := range change {
			m[k] = v
		}
		return m
	}
	for name, c := range map[string]struct {
		change M
		want   int
	}{
		"empty cart":      {M{"items": []M{}}, 400},
		"no name":         {M{"name": " "}, 400},
		"short address":   {M{"address": "abc"}, 400},
		"bad phone":       {M{"phone": "12345"}, 400},
		"zero quantity":   {M{"items": []M{{"id": 1, "qty": 0}}}, 400},
		"negative":        {M{"items": []M{{"id": 1, "qty": -2}}}, 400},
		"too many":        {M{"items": []M{{"id": 1, "qty": 21}}}, 400},
		"unknown product": {M{"items": []M{{"id": 99999, "qty": 1}}}, 409},
		"more than stock": {M{"items": []M{{"id": 1, "qty": 20}, {"id": 2, "qty": 20}}, "phone": "01722222222"}, 200},
		"unknown area":    {M{"area": "mars"}, 400},
		"unknown payment": {M{"payment": "gold"}, 400},
		"needs txn id":    {M{"payment": "bkash"}, 400},
		"bad coupon":      {M{"coupon": "NOPE"}, 400},
	} {
		expect(t, name, "POST", "/api/checkout", good(c.change), false, c.want)
	}
	expect(t, "not json", "POST", "/api/checkout", "{oops", false, 400)
	expect(t, "wrong type", "POST", "/api/checkout", `{"items":"x"}`, false, 400)
	out := expect(t, "valid", "POST", "/api/checkout", good(nil), false, 200, `"number"`, `"total":1060`)
	var r struct{ Number string }
	json.Unmarshal([]byte(out), &r)
	tr := expect(t, "track", "GET", "/api/track?order="+strings.ToLower(r.Number)+"&phone=%2B8801711111111", nil, false, 200, r.Number, "Product 1", `"status":"pending"`)
	if strings.Contains(tr, "admin_note") {
		t.Error("a customer can see the private note field")
	}
	expect(t, "track wrong phone", "GET", "/api/track?order="+r.Number+"&phone=01799999999", nil, false, 404)
	expect(t, "track nothing", "GET", "/api/track", nil, false, 404)
}

func TestCustomerAccountInputs(t *testing.T) {
	reset(t)
	clearLimits()
	jar, _ := cookiejar.New(nil)
	c := &http.Client{Jar: jar}
	u := M{"name": "Rahim", "phone": "01733333333", "password": "password1"}
	if code, _ := call(t, c, "POST", "/api/register", M{"name": "", "phone": "1", "password": "x"}, false); code != 400 {
		t.Errorf("bad register: %d", code)
	}
	if code, _ := call(t, c, "POST", "/api/register", u, false); code != 200 {
		t.Fatalf("register: %d", code)
	}
	if code, _ := call(t, nil, "POST", "/api/register", u, false); code != 409 {
		t.Errorf("same number twice: %d", code)
	}
	if code, out := call(t, c, "GET", "/api/me", nil, false); code != 200 || out["phone"] != "01733333333" {
		t.Errorf("me: %d %v", code, out)
	}
	if code, _ := call(t, nil, "GET", "/api/me", nil, false); code != 401 {
		t.Errorf("me without login: %d", code)
	}
	if code, _ := call(t, c, "POST", "/api/password", M{"old": "wrong", "new": "password2"}, false); code != 401 {
		t.Errorf("wrong old password: %d", code)
	}
	if code, _ := call(t, c, "POST", "/api/password", M{"old": "password1", "new": "short"}, false); code != 400 {
		t.Errorf("short new password: %d", code)
	}
	if code, _ := call(t, c, "POST", "/api/password", M{"old": "password1", "new": "password2"}, false); code != 200 {
		t.Errorf("change password: %d", code)
	}
	if code, _ := call(t, nil, "POST", "/api/login", M{"phone": "01733333333", "password": "password1"}, false); code != 401 {
		t.Errorf("old password still works: %d", code)
	}
	if code, _ := call(t, c, "POST", "/api/logout", M{}, false); code != 200 {
		t.Errorf("logout: %d", code)
	}
	if code, _ := call(t, c, "GET", "/api/me", nil, false); code != 401 {
		t.Errorf("still logged in: %d", code)
	}
	if code, _ := call(t, c, "POST", "/api/login", M{"phone": "+880 1733-333333", "password": "password2"}, false); code != 200 {
		t.Errorf("login: %d", code)
	}
	expect(t, "reset unknown", "POST", "/api/admin/customers/password", M{"phone": "01700000000"}, true, 404)
	expect(t, "reset", "POST", "/api/admin/customers/password", M{"phone": "01733333333"}, true, 200, `"password"`)
	if code, _ := call(t, c, "GET", "/api/me", nil, false); code != 401 {
		t.Errorf("a reset must end old logins: %d", code)
	}
}

func TestContactAndReviewInputs(t *testing.T) {
	reset(t)
	clearLimits()
	expect(t, "empty message", "POST", "/api/contact", M{"name": "A"}, false, 400)
	expect(t, "bot", "POST", "/api/contact", M{"name": "A", "contact": "b", "body": "hello there", "website": "x"}, false, 200)
	if out := expect(t, "bot stored?", "GET", "/api/admin/messages", nil, true, 200); strings.Contains(out, "hello there") {
		t.Error("a bot's message was stored")
	}
	expect(t, "message", "POST", "/api/contact", M{"name": "A", "contact": "b", "body": "real message"}, false, 200)
	out := expect(t, "list", "GET", "/api/admin/messages", nil, true, 200, "real message", `"read":false`)
	var ms []struct{ ID float64 }
	json.Unmarshal([]byte(out), &ms)
	id := jsonID(ms[0].ID)
	expect(t, "read", "PUT", "/api/admin/messages/"+id, "{}", true, 200)
	expect(t, "list read", "GET", "/api/admin/messages", nil, true, 200, `"read":true`)
	expect(t, "delete", "DELETE", "/api/admin/messages/"+id, nil, true, 200)
	if out := expect(t, "gone", "GET", "/api/admin/messages", nil, true, 200); strings.Contains(out, "real message") {
		t.Error("message not deleted")
	}

	expect(t, "bad rating", "POST", "/api/reviews", M{"product": 1, "rating": 6, "name": "A", "body": "hello"}, false, 400)
	expect(t, "no product", "POST", "/api/reviews", M{"product": 999, "rating": 5, "name": "A", "body": "hello"}, false, 404)
	expect(t, "review", "POST", "/api/reviews", M{"product": 1, "rating": 5, "name": "Asha", "body": "very good pan"}, false, 200)
	if out := expect(t, "not yet shown", "GET", "/api/catalog", nil, false, 200); strings.Contains(out, "very good pan") {
		t.Error("an unapproved review is public")
	}
	out = expect(t, "reviews", "GET", "/api/admin/reviews", nil, true, 200, "very good pan", `"approved":false`)
	var rs []struct{ ID float64 }
	json.Unmarshal([]byte(out), &rs)
	id = jsonID(rs[0].ID)
	expect(t, "approve", "PUT", "/api/admin/reviews/"+id, "{}", true, 200)
	expect(t, "shown", "GET", "/api/catalog", nil, false, 200, "very good pan")
	expect(t, "delete review", "DELETE", "/api/admin/reviews/"+id, nil, true, 200)
	if out := expect(t, "removed", "GET", "/api/catalog", nil, false, 200); strings.Contains(out, "very good pan") {
		t.Error("a deleted review is still public")
	}
}

func jsonID(f float64) string {
	b, _ := json.Marshal(int64(f))
	return string(b)
}

func TestProductAddUpdateDelete(t *testing.T) {
	reset(t)
	expect(t, "no name", "POST", "/api/admin/products", M{"name": "", "slug": "x", "price": 1, "regular": 1}, true, 400)
	expect(t, "space in slug", "POST", "/api/admin/products", M{"name": "A", "slug": "a b", "price": 1, "regular": 1}, true, 400)
	expect(t, "fractional price", "POST", "/api/admin/products", M{"name": "A", "slug": "a", "price": 1.5, "regular": 2}, true, 400)
	expect(t, "negative price", "POST", "/api/admin/products", M{"name": "A", "slug": "a", "price": -1, "regular": 2}, true, 400)
	out := expect(t, "add", "POST", "/api/admin/products", M{"name": "New Pan", "slug": "new-pan", "price": 500, "regular": 400, "stock": 7, "short": "Nice", "cats": []string{"nonstick"}}, true, 200, `"id"`)
	var r struct{ ID float64 }
	json.Unmarshal([]byte(out), &r)
	id := jsonID(r.ID)
	expect(t, "public", "GET", "/api/catalog", nil, false, 200, "New Pan", `"regular":500`)
	expect(t, "same slug", "POST", "/api/admin/products", M{"name": "B", "slug": "new-pan", "price": 1, "regular": 1}, true, 409)
	expect(t, "edit", "PUT", "/api/admin/products/"+id, M{"name": "Better Pan", "slug": "new-pan", "price": 450, "regular": 500, "stockDelta": 3, "short": "Nicer"}, true, 200)
	if stockOf(t, int64(r.ID)) != 10 {
		t.Errorf("stock %d", stockOf(t, int64(r.ID)))
	}
	expect(t, "edited", "GET", "/api/catalog", nil, false, 200, "Better Pan", "Nicer")
	expect(t, "edit unknown", "PUT", "/api/admin/products/123456", M{"name": "A", "slug": "zz", "price": 1, "regular": 1}, true, 404)
	expect(t, "quick price", "PATCH", "/api/admin/products/"+id, M{"price": 300}, true, 200)
	expect(t, "quick negative", "PATCH", "/api/admin/products/"+id, M{"price": -1}, true, 400)
	expect(t, "quick stock floor", "PATCH", "/api/admin/products/"+id, M{"stockDelta": -999}, true, 200, `"stock":0`)
	expect(t, "quick unknown", "PATCH", "/api/admin/products/123456", M{"price": 3}, true, 404)
	expect(t, "hide", "PATCH", "/api/admin/products/"+id, M{"active": false}, true, 200)
	if out := expect(t, "hidden", "GET", "/api/catalog", nil, false, 200); strings.Contains(out, "Better Pan") {
		t.Error("hidden product is public")
	}
	expect(t, "still in admin", "GET", "/api/admin/products", nil, true, 200, "Better Pan")
}

func TestContentAddUpdateDelete(t *testing.T) {
	reset(t)
	for _, kind := range []string{"cat", "tag"} {
		expect(t, kind+" add", "PUT", "/api/admin/content/"+kind+"/mixers", M{"name": "Mixers"}, true, 200)
		expect(t, kind+" blank", "PUT", "/api/admin/content/"+kind+"/mixers", M{"name": " "}, true, 400)
		expect(t, kind+" edit", "PUT", "/api/admin/content/"+kind+"/mixers", M{"name": "Grinders"}, true, 200)
		expect(t, kind+" list", "GET", "/api/admin/content/"+kind, nil, true, 200, "Grinders")
		expect(t, kind+" delete", "DELETE", "/api/admin/content/"+kind+"/mixers", nil, true, 200)
		if out := expect(t, kind+" gone", "GET", "/api/admin/content/"+kind, nil, true, 200); strings.Contains(out, "Grinders") {
			t.Error(kind + " not deleted")
		}
	}
	expect(t, "unknown kind", "GET", "/api/admin/content/nope", nil, true, 404)
	expect(t, "cat in use", "PUT", "/api/admin/products/1", M{"name": "P", "slug": "p1", "price": 1, "regular": 1, "cats": []string{"pans"}}, true, 200)
	expect(t, "cat add", "PUT", "/api/admin/content/cat/pans", M{"name": "Pans"}, true, 200)
	expect(t, "cat protected", "DELETE", "/api/admin/content/cat/pans", nil, true, 409)
	expect(t, "reserved", "PUT", "/api/admin/content/page/shop", M{"title": "x", "html": ""}, true, 400)
	expect(t, "bad slug", "PUT", "/api/admin/content/page/a%20b", M{"title": "x", "html": ""}, true, 400)
	expect(t, "page", "PUT", "/api/admin/content/page/faq", M{"title": "FAQ", "html": "<p>a</p>"}, true, 200)
	expect(t, "post clash", "PUT", "/api/admin/content/post/faq", M{"title": "x", "html": ""}, true, 409)
	expect(t, "storefront", "GET", "/api/storefront", nil, false, 200, "FAQ")
	expect(t, "draft", "PUT", "/api/admin/content/page/faq", M{"title": "FAQ", "html": "x", "draft": true}, true, 200)
	if out := expect(t, "draft hidden", "GET", "/api/storefront", nil, false, 200); strings.Contains(out, "FAQ") {
		t.Error("a draft is public")
	}
	expect(t, "post", "PUT", "/api/admin/content/post/news", M{"title": "News", "html": "x"}, true, 200, `"ok"`)
	expect(t, "post date filled", "GET", "/api/admin/content/post", nil, true, 200, `"date"`)
}

// Old WordPress slugs are stored percent-encoded, and the admin sends every slug URL-encoded.
func TestBanglaSlugsSaveAndDelete(t *testing.T) {
	reset(t)
	const stored = "%e0%a6%aa%e0%a7%8d%e0%a6%b0%e0%a6%be%e0%a6%87%e0%a6%b8"
	if _, err := db.Exec(bg, `INSERT INTO content(kind,slug,data) VALUES('tag',$1,'{"name":"old"}')`, stored); err != nil {
		t.Fatal(err)
	}
	addr := "/api/admin/content/tag/" + strings.ReplaceAll(stored, "%", "%25") // what encodeURIComponent makes of it
	expect(t, "rename", "PUT", addr, M{"name": "new"}, true, 200)
	var n int
	db.QueryRow(bg, `SELECT count(*) FROM content WHERE kind='tag'`).Scan(&n)
	if n != 1 {
		t.Errorf("renaming made %d tags, want 1", n)
	}
	expect(t, "renamed", "GET", "/api/admin/content/tag", nil, true, 200, `"new"`)
	expect(t, "delete", "DELETE", addr, nil, true, 200)
	db.QueryRow(bg, `SELECT count(*) FROM content WHERE kind='tag'`).Scan(&n)
	if n != 0 {
		t.Errorf("%d tags left after delete", n)
	}
	expect(t, "real bangla", "PUT", "/api/admin/content/page/%E0%A6%AA%E0%A6%BE%E0%A6%A4%E0%A6%BE", M{"title": "পাতা", "html": ""}, true, 200)
	expect(t, "bangla slug stored readable", "GET", "/api/admin/content/page", nil, true, 200, `"slug":"পাতা"`)
}

func TestCouponAddUpdateDelete(t *testing.T) {
	reset(t)
	clearLimits()
	c := func(v M) M {
		m := M{"kind": "percent", "value": 10, "minOrder": 0, "maxUses": 0, "expires": "", "active": true}
		for k, x := range v {
			m[k] = x
		}
		return m
	}
	expect(t, "bad code", "PUT", "/api/admin/coupons/a", c(nil), true, 400)
	expect(t, "over 100", "PUT", "/api/admin/coupons/SALE", c(M{"value": 101}), true, 400)
	expect(t, "bad kind", "PUT", "/api/admin/coupons/SALE", c(M{"kind": "free"}), true, 400)
	expect(t, "bad date", "PUT", "/api/admin/coupons/SALE", c(M{"expires": "soon"}), true, 400)
	expect(t, "add", "PUT", "/api/admin/coupons/sale", c(nil), true, 200)
	items := []M{{"id": 1, "qty": 1}}
	expect(t, "works", "POST", "/api/coupon", M{"code": "SALE", "items": items}, false, 200, `"discount":100`)
	expect(t, "edit", "PUT", "/api/admin/coupons/SALE", c(M{"kind": "amount", "value": 50}), true, 200)
	expect(t, "edited", "POST", "/api/coupon", M{"code": "sale", "items": items}, false, 200, `"discount":50`)
	expect(t, "off", "PUT", "/api/admin/coupons/SALE", c(M{"active": false}), true, 200)
	expect(t, "inactive", "POST", "/api/coupon", M{"code": "SALE", "items": items}, false, 400)
	expect(t, "list", "GET", "/api/admin/coupons", nil, true, 200, "SALE")
	expect(t, "delete", "DELETE", "/api/admin/coupons/SALE", nil, true, 200)
	if out := expect(t, "gone", "GET", "/api/admin/coupons", nil, true, 200); strings.Contains(out, "SALE") {
		t.Error("coupon not deleted")
	}
}

func TestSettingsSaveAndValidate(t *testing.T) {
	reset(t)
	_, s := call(t, nil, "GET", "/api/admin/settings", nil, true)
	if s["live"] == nil || s["site"] == nil {
		t.Fatalf("settings: %v", s)
	}
	live, site := s["live"].(map[string]any), s["site"].(map[string]any)
	saved := func() (Live, map[string]any) {
		l, w, err := loadSettings(bg)
		if err != nil {
			t.Fatal(err)
		}
		return l, w
	}
	put := func(want int) {
		t.Helper()
		expect(t, "save", "PUT", "/api/admin/settings", M{"live": live, "site": site}, true, want)
	}
	site["name"], site["phone"], site["brandColor"] = "My Shop", "01900000000", "#112233"
	live["ordersOpen"], live["notice"], live["freeOver"] = false, "Closed for Eid", 5000
	live["delivery"] = []M{{"id": "dhaka", "label": "Dhaka", "fee": 120, "days": "2 days"}}
	put(200)
	l, w := saved()
	if w["name"] != "My Shop" || l.OrdersOpen || l.Notice != "Closed for Eid" || l.FreeOver != 5000 || l.Delivery[0].ID != "dhaka" {
		t.Errorf("not saved: %+v %v", l, w["name"])
	}
	expect(t, "live at once", "GET", "/api/stock", nil, false, 200, "Closed for Eid", "dhaka")
	site["brandColor"] = "red"
	put(400)
	site["brandColor"] = "#112233"
	live["delivery"] = []M{}
	put(400)
	live["delivery"] = []M{{"id": "a", "label": "", "fee": 1}}
	put(400)
	live["delivery"] = []M{{"id": "a", "label": "A", "fee": -1}}
	put(400)
	live["delivery"] = []M{{"id": "a", "label": "A", "fee": 1}, {"id": "a", "label": "B", "fee": 1}}
	put(400)
	live["delivery"] = []M{{"id": "a", "label": "A", "fee": 1}}
	live["payments"] = []M{{"id": "cod", "label": "Cash", "enabled": false}}
	put(400)
	live["payments"] = []M{{"id": "cod", "label": "Cash", "enabled": true}}
	live["freeOver"] = -1
	put(400)
	expect(t, "not json", "PUT", "/api/admin/settings", "{", true, 400)
}

func TestOrderAdminInputs(t *testing.T) {
	reset(t)
	clearLimits()
	out := expect(t, "order", "POST", "/api/checkout", M{"items": []M{{"id": 1, "qty": 2}}, "name": "Karim, =CMD", "phone": "01744444444", "address": "12 Road, Jashore", "area": "outside", "payment": "cod"}, false, 200)
	var r struct{ Number string }
	json.Unmarshal([]byte(out), &r)
	expect(t, "find", "GET", "/api/admin/orders?q=01744444444", nil, true, 200, r.Number, `"total":1`)
	expect(t, "filter", "GET", "/api/admin/orders?status=shipped", nil, true, 200, `"total":0`)
	expect(t, "dates", "GET", "/api/admin/orders?from=2020-01-01&to=2099-01-01", nil, true, 200, r.Number)
	expect(t, "bad page", "GET", "/api/admin/orders?page=-3", nil, true, 200, r.Number)
	expect(t, "csv", "GET", "/api/admin/orders.csv", nil, true, 200, "Order,Date", r.Number)
	expect(t, "unknown status", "PUT", "/api/admin/orders/"+r.Number, M{"status": "lost"}, true, 400)
	expect(t, "unknown order", "PUT", "/api/admin/orders/LB-NOPE", M{"status": "shipped"}, true, 404)
	expect(t, "courier", "PUT", "/api/admin/orders/"+r.Number, M{"courier": "Pathao", "tracking": "T1", "adminNote": "private"}, true, 200)
	expect(t, "customers", "GET", "/api/admin/customers?q=0174", nil, true, 200, "01744444444", `"orders":1`)
	tr := expect(t, "customer view", "GET", "/api/track?order="+r.Number+"&phone=01744444444", nil, false, 200, "Pathao")
	if strings.Contains(tr, "private") {
		t.Error("a private note reached the customer")
	}
	expect(t, "dashboard", "GET", "/api/admin/dashboard", nil, true, 200, "todayOrders", "series", "low")
}

func TestImageUploadInputs(t *testing.T) {
	reset(t)
	t.Setenv("LOCAL_UPLOADS", t.TempDir())
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	send := func(body []byte) int {
		req, _ := http.NewRequest("POST", api.URL+"/api/admin/image?folder=products/pans&name=pan-1", bytes.NewReader(body))
		req.Header.Set("X-Admin-Token", adminKey)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		res.Body.Close()
		return res.StatusCode
	}
	if c := send(png); c != 200 {
		t.Errorf("png: %d", c)
	}
	if c := send([]byte("<svg onload=alert(1)>")); c != 400 {
		t.Errorf("svg or text: %d", c)
	}
	if c := send(append(png, make([]byte, 6<<20)...)); c != 413 {
		t.Errorf("too big: %d", c)
	}
}

func TestPublishNotConfigured(t *testing.T) {
	reset(t)
	t.Setenv("GITHUB_REPO", "")
	t.Setenv("GITHUB_TOKEN", "")
	t.Setenv("DEV_BUILD_DIR", "")
	expect(t, "publish", "POST", "/api/admin/publish", "", true, 501)
}

func TestDeleteProduct(t *testing.T) {
	reset(t)
	clearLimits()
	expect(t, "never sold", "DELETE", "/api/admin/products/2", nil, true, 200, `"deleted":true`)
	if out := expect(t, "gone from admin", "GET", "/api/admin/products", nil, true, 200); strings.Contains(out, "Product 2") {
		t.Error("product not deleted")
	}
	expect(t, "order", "POST", "/api/checkout", M{"items": []M{{"id": 1, "qty": 1}}, "name": "A", "phone": "01755555555", "address": "12 Road, Jashore", "area": "jashore", "payment": "cod"}, false, 200)
	expect(t, "sold before", "DELETE", "/api/admin/products/1", nil, true, 200, `"deleted":false`)
	expect(t, "kept for old orders", "GET", "/api/admin/products", nil, true, 200, "Product 1", `"active":false`)
	expect(t, "unknown", "DELETE", "/api/admin/products/123456", nil, true, 404)
}

func TestPublicID(t *testing.T) {
	for in, want := range map[string]string{
		"https://res.cloudinary.com/x/image/upload/f_auto,q_auto/v12/loverbaazar/products/pans/pan-1.jpg": "loverbaazar/products/pans/pan-1",
		"https://res.cloudinary.com/x/image/upload/f_auto,q_auto,w_300/loverbaazar/products/pans/pan-1":   "loverbaazar/products/pans/pan-1",
		"https://res.cloudinary.com/x/image/upload/f_auto/loverbaazar/site/logo.png?v=2":                  "loverbaazar/site/logo",
		"https://res.cloudinary.com/x/image/upload/other/folder/pic.jpg":                                  "",
		"https://loverbaazar.com/wp-content/uploads/loverbaazar/a.jpg":                                    "",
		"/uploads/abc.png": "",
	} {
		if got := publicID(in); got != want {
			t.Errorf("publicID(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPhotosStillInUseAreKept(t *testing.T) {
	reset(t)
	const shared = "https://res.cloudinary.com/x/image/upload/loverbaazar/products/p/shared-1.jpg"
	const single = "https://res.cloudinary.com/x/image/upload/loverbaazar/products/p/single-1.jpg"
	if _, err := db.Exec(bg, `UPDATE products SET data=data||jsonb_build_object('images',jsonb_build_array(jsonb_build_object('src',$1::text))) WHERE id=2`, shared); err != nil {
		t.Fatal(err)
	}
	got := unusedImages(bg, []any{M{"src": shared}, M{"src": single}, M{"src": "/placeholder.svg"}}, []any{})
	if len(got) != 1 || got[0] != "loverbaazar/products/p/single-1" {
		t.Errorf("unused: %v", got)
	}
	if got := unusedImages(bg, []any{M{"src": single}}, []any{M{"src": single}}); len(got) != 0 {
		t.Errorf("a photo still on the product was marked unused: %v", got)
	}
}

type fakeSite func(*http.Request) *http.Response

func (f fakeSite) RoundTrip(r *http.Request) (*http.Response, error) { return f(r), nil }

// answer makes httpClient talk to a fake site, and returns what gets logged.
func answer(t *testing.T, status int, body string) *bytes.Buffer {
	t.Helper()
	logged := &bytes.Buffer{}
	client, out := httpClient, log.Writer()
	httpClient = &http.Client{Transport: fakeSite(func(*http.Request) *http.Response {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
	})}
	log.SetOutput(logged)
	t.Cleanup(func() { httpClient = client; log.SetOutput(out) })
	return logged
}

func TestBotCheckSaysWhyItFailed(t *testing.T) {
	t.Setenv("TURNSTILE_SECRET", "secret")
	r := httptest.NewRequest("POST", "/api/checkout", nil)
	logged := answer(t, 200, `{"success":false,"error-codes":["invalid-input-secret"]}`)
	if human(r, "token") || !strings.Contains(logged.String(), "invalid-input-secret") {
		t.Fatalf("a refusal must fail and log the reason, logged %q", logged)
	}
	logged = answer(t, 200, `{"success":true}`)
	if !human(r, "token") || logged.Len() != 0 {
		t.Fatalf("a pass must pass quietly, logged %q", logged)
	}
	t.Setenv("TURNSTILE_SECRET", "")
	if !human(r, "") {
		t.Fatal("with no secret the check is off")
	}
}

func TestReceiptText(t *testing.T) {
	b := receipt{number: "LB-1", area: "Outside", payment: "Cash", lines: []string{"Rice cooker × 5: ৳10000"}, sub: 10000, fee: 500, total: 10500}
	got := customerMail("Rahim", "LoverBaazar", "01710-076076", b.text())
	for _, want := range []string{"Delivery charge (Outside): ৳500", "Total: ৳10500", "Thanks for shopping from LoverBaazar"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in\n%s", want, got)
		}
	}
}

func TestDeliveryIsPerPiece(t *testing.T) {
	z := Zone{Fee: 100}
	if f := deliveryFee(z, Live{}, 5000, 5); f != 500 {
		t.Fatalf("5 pieces at 100 = %d", f)
	}
	if f := deliveryFee(z, Live{FreeOver: 4000}, 5000, 5); f != 0 {
		t.Fatalf("free over the limit = %d", f)
	}
}

func TestEmailSaysWhyItFailed(t *testing.T) {
	t.Setenv("BREVO_KEY", "key")
	t.Setenv("SHOP_EMAIL", "shop@example.com")
	logged := answer(t, 401, `{"code":"unauthorized","message":"unrecognised IP address"}`)
	notify("subject", "text")
	if !strings.Contains(logged.String(), "401") || !strings.Contains(logged.String(), "unrecognised IP address") {
		t.Fatalf("logged %q", logged)
	}
	logged = answer(t, 201, `{"messageId":"x"}`)
	notify("subject", "text")
	if logged.Len() != 0 {
		t.Fatalf("a sent email must log nothing, logged %q", logged)
	}
}
