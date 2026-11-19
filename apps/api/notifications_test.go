package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestOrderMailDurabilityAndRecovery(t *testing.T) {
	reset(t)
	clearLimits()
	old := dev
	defer func() { dev = old }()
	dev = false
	t.Setenv("APP_ENV", "production")
	t.Setenv("TURNSTILE_SECRET", "test-secret")
	t.Setenv("BREVO_KEY", "")
	t.Setenv("SHOP_EMAIL", "sender@example.invalid")
	t.Setenv("SHOP_REPLY_TO", "help@example.invalid")
	t.Setenv("ADMIN_EMAIL", "owner@example.invalid")
	t.Setenv("CUSTOMER_ORDER_EMAIL", "true")
	logs := answer(t, 200, `{"success":true,"hostname":"shop.test"}`)
	order := `{"items":[{"id":1,"qty":1}],"name":"Buyer fixture","phone":"01711111111","address":"Private fixture address","area":"jashore","payment":"cod","email":"buyer@example.invalid","key":"fixture-email"}`
	handler := router()
	for range 2 {
		r := httptest.NewRequest("POST", "https://shop.test/api/checkout", strings.NewReader(order))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("checkout failed: %d %s", w.Code, logs.String())
		}
	}
	var orders, jobs int
	if err := db.QueryRow(bg, `SELECT (SELECT count(*) FROM orders),(SELECT count(*) FROM order_notifications)`).Scan(&orders, &jobs); err != nil || orders != 1 || jobs != 2 {
		t.Fatal("checkout and retry must produce one order with two queued email records", orders, jobs, err)
	}
	t.Setenv("BREVO_KEY", "test")
	prev := httpClient
	t.Cleanup(func() { httpClient = prev })
	var calls []map[string]json.RawMessage
	code := 429
	httpClient = &http.Client{Transport: fakeSite(func(r *http.Request) *http.Response {
		var body map[string]json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		calls = append(calls, body)
		return &http.Response{StatusCode: code, Body: http.NoBody}
	})}
	send := func(id int64, verified, want bool) {
		t.Helper()
		sent, err := sendQueuedMail(context.Background(), id, verified)
		if err != nil || sent != want {
			t.Fatalf("send result %v %v, want %v", sent, err, want)
		}
	}
	send(1, false, true)
	code = 503
	send(2, false, true)
	send(2, false, false)
	code = 201
	send(1, false, true)
	send(1, false, false)
	send(2, true, true)
	if len(calls) != 4 || !strings.Contains(string(calls[0]["to"]), "owner@example.invalid") ||
		strings.Contains(string(calls[0]["textContent"]), "Private fixture address") ||
		!strings.Contains(string(calls[1]["to"]), "buyer@example.invalid") ||
		strings.Contains(string(calls[1]["to"]), "owner@example.invalid") {
		t.Fatal("mail provider did not get isolated recipients")
	}
	if !strings.Contains(string(calls[1]["sender"]), "sender@example.invalid") ||
		!strings.Contains(string(calls[1]["replyTo"]), "help@example.invalid") {
		t.Fatal("mail provider did not get the configured sender and reply address")
	}
	var used, cleared int
	if err := db.QueryRow(bg, `SELECT (SELECT recipients FROM notification_daily_budget),(SELECT count(*) FROM order_notifications WHERE state='accepted' AND payload='{}')`).Scan(&used, &cleared); err != nil || used != 4 || cleared != 2 {
		t.Fatal("mail quota or accepted payload cleanup incorrect", used, cleared, err)
	}
}

func TestNotificationQuotaDoesNotSend(t *testing.T) {
	reset(t)
	t.Setenv("ORDER_EMAIL_DAILY_LIMIT", "1")
	t.Setenv("ADMIN_EMAIL", "first@example.invalid,second@example.invalid")
	_, err := db.Exec(bg, `WITH new_order AS (
		INSERT INTO orders(number,name,phone,address,area,payment,subtotal,shipping,total)
		VALUES('LB-FIXTURE','Fixture','01710000000','Fixture address','Jashore','COD',100,0,100) RETURNING id)
		INSERT INTO order_notifications(order_id,kind,payload) SELECT id,'owner','{"Subject":"Fixture"}' FROM new_order`)
	if err != nil {
		t.Fatal(err)
	}
	sent, err := sendQueuedMail(bg, 0, false)
	if err != nil || sent {
		t.Fatal("expected blocked quota", err)
	}
	var state string
	var attempts int
	if err := db.QueryRow(bg, `SELECT outcome,attempts FROM order_notifications`).Scan(&state, &attempts); err != nil || state != "local_quota" || attempts != 0 {
		t.Fatal(state, attempts, err)
	}
}

func TestOrderStatusMailFollowsSavedChanges(t *testing.T) {
	reset(t)
	old := dev
	defer func() { dev = old }()
	dev = false
	t.Setenv("APP_ENV", "production")
	t.Setenv("BREVO_KEY", "")
	t.Setenv("CUSTOMER_ORDER_EMAIL", "true")
	t.Setenv("SITE_URL", "https://shop.example.invalid")

	if _, err := db.Exec(bg, `INSERT INTO orders(number,name,phone,email,address,area,payment,subtotal,shipping,total)
		VALUES ('LB-MAIL','Fixture','01710000000','buyer@example.invalid','Fixture address','Jashore','COD',100,0,100),
		       ('LB-NO-MAIL','Fixture','01710000000','','Fixture address','Jashore','COD',100,0,100)`); err != nil {
		t.Fatal(err)
	}
	update := func(number string, fields M, wantCode int, wantMail bool) {
		t.Helper()
		code, out := call(t, nil, "PUT", "/api/admin/orders/"+number, fields, true)
		if code != wantCode || code == 200 && out["emailQueued"] != wantMail {
			t.Fatalf("update %v returned %d %v", fields, code, out)
		}
	}
	update("LB-MAIL", M{"status": "confirmed", "expectedStatus": "pending"}, 200, false)
	update("LB-MAIL", M{"status": "shipped", "expectedStatus": "pending", "tracking": "UNSAVED"}, 409, false)
	update("LB-MAIL", M{"status": "shipped", "expectedStatus": "confirmed", "tracking": "FIXTURE-42", "courier": "Fixture courier", "adminNote": "Private note"}, 200, true)
	update("LB-MAIL", M{"status": "shipped", "tracking": "FIXTURE-43"}, 200, false)
	update("LB-MAIL", M{"status": "delivered"}, 200, false)
	update("LB-MAIL", M{"status": "shipped"}, 200, false)
	update("LB-NO-MAIL", M{"status": "cancelled"}, 200, false)
	update("LB-MAIL", M{"status": "returned"}, 200, true)
	update("LB-MAIL", M{"status": "cancelled"}, 200, true)
	t.Setenv("CUSTOMER_ORDER_EMAIL", "false")
	if _, err := db.Exec(bg, `UPDATE orders SET email='buyer@example.invalid' WHERE number='LB-NO-MAIL'`); err != nil {
		t.Fatal(err)
	}
	update("LB-NO-MAIL", M{"status": "returned"}, 200, false)

	var payload []byte
	if err := db.QueryRow(bg, `SELECT payload FROM order_notifications WHERE kind='customer_shipped'`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	var message mailPayload
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatal(err)
	}
	if len(message.To) != 1 || message.To[0] != "buyer@example.invalid" ||
		!strings.Contains(message.Text, "Tracking number: FIXTURE-42") ||
		!strings.Contains(message.Text, "https://shop.example.invalid/track/") ||
		strings.Contains(message.Text, "Private note") || strings.Contains(message.Text, "UNSAVED") {
		t.Fatalf("incorrect shipment mail: %+v", message)
	}
	var jobs int
	if err := db.QueryRow(bg, `SELECT count(*) FROM order_notifications`).Scan(&jobs); err != nil || jobs != 3 {
		t.Fatalf("want shipment, cancellation and return notices, got %d: %v", jobs, err)
	}
}
