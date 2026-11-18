package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestDatabaseTargetGuard(t *testing.T) {
	for _, raw := range []string{"postgres://localhost/lb", "postgres://localhost.evil/lb_test", "postgres://localhost@evil/lb_test", "postgres://127.0.0.1/lb_test?host=evil", "postgres://127.0.0.1/lb_test?dbname=lb", "postgres://127.0.0.1/lb_test?port=55432"} {
		if safeTestDatabase(raw) {
			t.Fatal("unsafe test target accepted")
		}
	}
	if !safeTestDatabase("postgres://postgres:dev@127.0.0.1:5432/lb_test") {
		t.Fatal("test target refused")
	}
}
func TestEditorialValidation(t *testing.T) {
	for _, s := range []string{"%2f", "%252f", "..", "%00", "a/b", "%zz"} {
		if safeSlug(s, false) {
			t.Fatal("unsafe slug accepted", s)
		}
	}
	if !safeSlug("%e0%a6%aa", false) {
		t.Fatal("Bangla refused")
	}
	for _, v := range []any{json.Number("1.5"), json.Number("1e30"), "1"} {
		if _, ok := integer(v, 0, maxStock); ok {
			t.Fatal("bad integer")
		}
	}
	safe := cleanHTML(`<p onclick="alert(1)">Hello <strong>buyer</strong><script>alert(1)</script><img src="javascript:alert(1)"><a href="https://example.com">link</a></p>`)
	if strings.Contains(safe, "onclick") || strings.Contains(safe, "javascript:") || strings.Contains(safe, "script") {
		t.Fatal(safe)
	}
	if !strings.Contains(safe, "<strong>buyer</strong>") {
		t.Fatal(safe)
	}
}
func TestRequestBoundaries(t *testing.T) {
	for _, tc := range []struct {
		origin, typ, body string
		code              int
	}{{"https://evil.test", "application/json", "{}", 403}, {"", "text/plain", "{}", 415}, {"", "application/json", "{} {}", 400}} {
		r := httptest.NewRequest("POST", "https://shop.test/api/contact", strings.NewReader(tc.body))
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Content-Type", tc.typ)
		w := httptest.NewRecorder()
		requestGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { read(w, r, new(any)) })).ServeHTTP(w, r)
		if w.Code != tc.code {
			t.Fatal(w.Code, tc.code)
		}
	}
}
func TestRetryCannotReadDifferentOrder(t *testing.T) {
	reset(t)
	first := order(M{"key": "secret-retry-key"}, M{"id": 1, "qty": 1})
	if c, _ := call(t, nil, "POST", "/api/checkout", first, false); c != 200 {
		t.Fatal(c)
	}
	changed := order(M{"key": "secret-retry-key", "phone": "01711111111"}, M{"id": 1, "qty": 1})
	if c, _ := call(t, nil, "POST", "/api/checkout", changed, false); c != 409 {
		t.Fatal(c)
	}
	if c, _ := call(t, nil, "POST", "/api/checkout", first, false); c != 200 {
		t.Fatal(c)
	}
}
func TestMigrationLockAndChecksums(t *testing.T) {
	reset(t)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := migrate(bg); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	_, e := db.Exec(bg, `UPDATE schema_migrations SET checksum='bad' WHERE version=2`)
	if e != nil {
		t.Fatal(e)
	}
	if e = migrate(bg); e == nil {
		t.Error("changed migration accepted")
	}
	_, _ = db.Exec(bg, `UPDATE schema_migrations SET checksum=$1 WHERE version=2`, hashTok(migrationSQL))
}
func TestFrozenPublicationAndImageProtection(t *testing.T) {
	reset(t)
	id, key, e := frozenRelease(bg, true)
	if e != nil {
		t.Fatal(e)
	}
	_, _ = db.Exec(bg, `UPDATE products SET data=data||'{"name":"Later edit","images":[{"src":"/uploads/previous.png"}]}' WHERE id=1`)
	before := db.Stat().AcquireCount()
	r := httptest.NewRequest("GET", "/api/build/"+id, nil)
	r.Header.Set("X-Build-Key", key)
	w := httptest.NewRecorder()
	router().ServeHTTP(w, r)
	if w.Code != 200 || strings.Contains(w.Body.String(), "Later edit") {
		t.Fatal(w.Code, w.Body.String())
	}
	if db.Stat().AcquireCount() != before {
		t.Fatal("build read acquired DB")
	}
	if e = finishRelease(bg, id, key, "published", "test"); e != nil {
		t.Fatal(e)
	}
	var dirty bool
	db.QueryRow(bg, `SELECT revision<>published FROM publication_state`).Scan(&dirty)
	if !dirty {
		t.Fatal("later edit incorrectly published")
	}
	id2, key2, e := frozenRelease(bg, true)
	if e != nil {
		t.Fatal(e)
	}
	if e = finishRelease(bg, id2, key2, "published", "test2"); e != nil {
		t.Fatal(e)
	}
	_, _ = db.Exec(bg, `UPDATE products SET data=data||'{"images":[]}' WHERE id=1`)
	if !isImageRefUsed(bg, "/uploads/previous.png") {
		t.Fatal("published image unprotected")
	}
	if e = finishRelease(bg, id2, key2, "failed", ""); e != nil {
		t.Fatal(e)
	}
	var state string
	db.QueryRow(bg, `SELECT state FROM releases WHERE id=$1`, id2).Scan(&state)
	if state != "published" {
		t.Fatal("late failure replaced success")
	}
	// Code-only releases use published editorial content, even with pending edits.
	_, _ = db.Exec(bg, `UPDATE products SET data=data||'{"name":"Unpublished"}',price=1234,stock=0 WHERE id=1`)
	id3, key3, e := frozenRelease(bg, false)
	if e != nil {
		t.Fatal(e)
	}
	if e = finishRelease(bg, id3, key3, "failed", ""); e != nil {
		t.Fatal(e)
	}
	var data string
	db.QueryRow(bg, `SELECT payload::text FROM releases WHERE id=$1`, id3).Scan(&data)
	var refreshed struct {
		Products []struct {
			ID      int64
			Name    string
			Price   int64
			InStock bool
		}
	}
	if err := json.Unmarshal([]byte(data), &refreshed); err != nil {
		t.Fatal(err)
	}
	found := false
	for _, product := range refreshed.Products {
		if product.ID == 1 {
			found = true
			if product.Name != "Later edit" || product.Price != 1234 || product.InStock {
				t.Fatal("refresh released an editorial edit or retained stale offers", product)
			}
			break
		}
	}
	if !found {
		t.Fatal("sold-out published product missing after refresh")
	}
	older, olderKey, e := frozenRelease(bg, true)
	if e != nil {
		t.Fatal(e)
	}
	newer, newerKey, e := frozenRelease(bg, true)
	if e != nil {
		t.Fatal(e)
	}
	if e = finishRelease(bg, newer, newerKey, "published", "new"); e != nil {
		t.Fatal(e)
	}
	if e = finishRelease(bg, older, olderKey, "running", "old"); e == nil {
		t.Fatal("superseded release is still eligible for promotion")
	}
	if e = finishRelease(bg, older, olderKey, "published", "old"); e != nil {
		t.Fatal(e)
	}
	db.QueryRow(bg, `SELECT state FROM releases WHERE id=$1`, older).Scan(&state)
	if state != "superseded" {
		t.Fatal("older build replaced newer release")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e = migrate(ctx); e != nil {
		t.Fatal(e)
	}
}

func TestEnvironmentAndChallengeHost(t *testing.T) {
	old := dev
	defer func() { dev = old }()
	dev = false
	t.Setenv("APP_ENV", "production")
	t.Setenv("DEV_BUILD_DIR", "")
	t.Setenv("LOCAL_UPLOADS", "")
	t.Setenv("TURNSTILE_SECRET", "")
	t.Setenv("TURNSTILE_SITE", "")
	if checkRuntime() == nil {
		t.Fatal("botless production accepted")
	}
	t.Setenv("TURNSTILE_SECRET", "test-secret")
	t.Setenv("TURNSTILE_SITE", "test-site")
	if e := checkRuntime(); e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("POST", "https://shop.test/api/checkout", nil)
	answer(t, 200, `{"success":true,"hostname":"evil.test"}`)
	if human(r, "token") {
		t.Fatal("wrong hostname accepted")
	}
	answer(t, 200, `{"success":true,"hostname":"shop.test"}`)
	if !human(r, "token") {
		t.Fatal("correct hostname refused")
	}
	t.Setenv("APP_ENV", "preview")
	logged := answer(t, 500, `{}`)
	sendMail([]string{"test@example.com"}, "subject", "body")
	if logged.Len() != 0 {
		t.Fatal("preview attempted email")
	}
}

func TestCheckoutMeasurementCountsCommittedOrdersOnce(t *testing.T) {
	reset(t)
	clearLimits()
	old := dev
	defer func() { dev = old }()
	dev = false
	t.Setenv("APP_ENV", "production")
	t.Setenv("CHECKOUT_METRICS_HOST", "shop.test")
	t.Setenv("BREVO_KEY", "")
	t.Setenv("TURNSTILE_SECRET", "fixture-secret")
	logs := answer(t, 200, `{"success":true,"hostname":"shop.test"}`)
	handler := router()
	body := `{"items":[{"id":1,"qty":1}],"name":"Private fixture name","phone":"১৭১১১১১১১১","address":"গোপন ঠিকানা, যশোর","area":"jashore","payment":"cod","key":"fixture-idempotency"}`
	send := func(host, data string, expected int) {
		t.Helper()
		r := httptest.NewRequest("POST", "https://"+host+"/api/checkout", strings.NewReader(data))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != expected {
			t.Fatalf("checkout got %d want %d: %s %s", w.Code, expected, w.Body.String(), logs.String())
		}
	}
	send("shop.test", body, 200)
	send("shop.test", body, 200)
	send("shop.test", "{}", 400)
	send("preview.test", "{}", 400)
	text := logs.String()
	if strings.Count(text, "event=order_created") != 1 || strings.Count(text, "event=request status=200") != 2 ||
		strings.Count(text, "event=request status=400") != 1 || strings.Contains(text, "Private fixture name") ||
		strings.Contains(text, "fixture-idempotency") || strings.Contains(text, "গোপন") {
		t.Fatal("incorrect checkout aggregate logs", text)
	}
}
