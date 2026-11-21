package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestHealthHeadAndGetWithoutDB(t *testing.T) {
	reset(t)
	t.Setenv("ORIGIN_SECRET", "a-secret-only-the-worker-knows")
	before := db.Stat().AcquireCount()
	h := router()
	for _, method := range []string{http.MethodGet, http.MethodHead} {
		req := httptest.NewRequest(method, "/api/health", nil)
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s /api/health = %d, want 200", method, rec.Code)
		}
		if method == http.MethodGet && rec.Body.String() != "ok" {
			t.Fatalf("GET /api/health body = %q, want ok", rec.Body.String())
		}
	}
	if db.Stat().AcquireCount() != before {
		t.Fatal("/api/health touched the database")
	}
}

func TestAnalyticsUnconfiguredReturnsRealOrdersOnly(t *testing.T) {
	reset(t)
	t.Setenv("CLOUDFLARE_ANALYTICS_TOKEN", "")
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", "")
	t.Setenv("CLOUDFLARE_WEB_ANALYTICS_SITE_TAG", "")

	oldNow := analyticsNow
	fixedNow := time.Date(2026, 11, 21, 10, 0, 0, 0, dhakaTZ)
	analyticsNow = func() time.Time { return fixedNow }
	defer func() { analyticsNow = oldNow }()

	code, _ := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false)
	if code != 200 {
		t.Fatalf("checkout status = %d", code)
	}
	if _, err := db.Exec(bg, `UPDATE orders SET created_at=$1`, fixedNow.UTC()); err != nil {
		t.Fatal(err)
	}

	code, res := call(t, nil, "GET", "/api/admin/analytics", nil, true)
	if code != 200 {
		t.Fatalf("analytics = %d: %v", code, res)
	}
	if res["configured"] != false {
		t.Fatalf("configured = %v, want false", res["configured"])
	}
	missing := res["missingConfig"].([]any)
	if len(missing) != 3 {
		t.Fatalf("missingConfig = %v", missing)
	}
	today := res["today"].(M)
	if today["day"] != "2026-11-21" || today["hasVisitors"] != false || today["orders"].(float64) != 1 || today["sales"].(float64) != 1060 {
		t.Fatalf("today = %v", today)
	}
	l7 := res["last7Days"].(M)
	if l7["orders"].(float64) != 1 || l7["sales"].(float64) != 1060 || l7["daysRecorded"].(float64) != 0 || len(l7["days"].([]any)) != 7 {
		t.Fatalf("last7Days = %v", l7)
	}
	months := res["months"].([]any)
	if len(months) != 12 {
		t.Fatalf("months length = %d", len(months))
	}
	curMonth := months[11].(M)
	if curMonth["month"] != "2026-11" || curMonth["orders"].(float64) != 1 || curMonth["avgPerDay"] != nil || curMonth["changePct"] != nil {
		t.Fatalf("current month = %v", curMonth)
	}
}

func TestAnalyticsSyncDhakaBucketingCacheAndFallback(t *testing.T) {
	reset(t)

	// 2026-11-20T19:30:00Z == 2026-11-21 01:30:00 +06:00 (Asia/Dhaka)
	fixedNow := time.Date(2026, 11, 20, 19, 30, 0, 0, time.UTC)
	oldNow := analyticsNow
	analyticsNow = func() time.Time { return fixedNow }
	defer func() { analyticsNow = oldNow }()

	// Pre-populate an unsampled finalized day in the backfill range to verify ON CONFLICT DO NOTHING keeps it intact.
	if _, err := db.Exec(bg, `INSERT INTO analytics_daily(day, visitors, pageviews, sample_rate, source, finalized) VALUES('2026-11-10', 88, 210, 1, 'cloudflare_rum', TRUE)`); err != nil {
		t.Fatal(err)
	}

	const secretToken = "super-secret-cf-token-do-not-leak"
	const accountID = "acct-123"
	const siteTag = "0123456789abcdef0123456789abcdef"
	t.Setenv("CLOUDFLARE_ANALYTICS_TOKEN", secretToken)
	t.Setenv("CLOUDFLARE_ACCOUNT_ID", accountID)
	t.Setenv("CLOUDFLARE_WEB_ANALYTICS_SITE_TAG", siteTag)

	var cfCalls int
	var failCF bool
	var capturedPayloads []string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cfCalls++
		if got := r.Header.Get("Authorization"); got != "Bearer "+secretToken {
			t.Errorf("Authorization = %q", got)
			w.WriteHeader(401)
			return
		}
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(body)
		capturedPayloads = append(capturedPayloads, string(raw))
		if failCF {
			w.WriteHeader(500)
			_, _ = w.Write([]byte(`{"errors":[{"message":"secret-internal-cf-error"}]}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.Contains(body.Query, "LoverBaazarHourlyRUM"):
			_, _ = w.Write([]byte(`{"data":{"viewer":{"accounts":[{"rumPageloadEventsAdaptiveGroups":[
				{"count":12,"sum":{"visits":5},"avg":{"sampleInterval":1},"dimensions":{"datetimeHour":"2026-11-20T17:00:00Z"}},
				{"count":30,"sum":{"visits":14},"avg":{"sampleInterval":1},"dimensions":{"datetimeHour":"2026-11-20T19:00:00Z"}}
			]}]}}}`))
		case strings.Contains(body.Query, "LoverBaazarBreakdowns"):
			_, _ = w.Write([]byte(`{"data":{"viewer":{"accounts":[{"pages":[
				{"count":10,"sum":{"visits":4},"dimensions":{"requestPath":"/checkout/"}},
				{"count":25,"sum":{"visits":11},"dimensions":{"requestPath":"/product/rice-cooker/"}}
			],"referrers":[
				{"count":15,"sum":{"visits":8},"dimensions":{"refererHost":""}},
				{"count":10,"sum":{"visits":5},"dimensions":{"refererHost":"Facebook.com"}}
			],"devices":[
				{"count":20,"sum":{"visits":12},"dimensions":{"deviceType":"mobile"}}
			],"countries":[
				{"count":22,"sum":{"visits":13},"dimensions":{"countryName":"Bangladesh"}}
			]}]}}}`))
		case strings.Contains(body.Query, "LoverBaazarBackfillRUM"):
			_, _ = w.Write([]byte(`{"data":{"viewer":{"accounts":[{"rumPageloadEventsAdaptiveGroups":[
				{"count":999,"sum":{"visits":999},"avg":{"sampleInterval":10},"dimensions":{"date":"2026-11-10"}},
				{"count":40,"sum":{"visits":18},"avg":{"sampleInterval":2},"dimensions":{"date":"2026-11-05"}}
			]}]}}}`))
		default:
			t.Fatalf("unexpected GraphQL query: %s", body.Query)
		}
	}))
	defer srv.Close()

	oldURL := cloudflareGraphQLURL
	cloudflareGraphQLURL = srv.URL
	defer func() { cloudflareGraphQLURL = oldURL }()

	code, res := call(t, nil, "GET", "/api/admin/analytics", nil, true)
	if code != 200 {
		t.Fatalf("analytics = %d: %v", code, res)
	}
	if cfCalls != 3 {
		t.Fatalf("expected 3 GraphQL calls (hourly, breakdowns, backfill), got %d", cfCalls)
	}
	for _, p := range capturedPayloads {
		if !strings.Contains(p, "bot: 0") || !strings.Contains(p, siteTag) {
			t.Fatalf("GraphQL payload missing bot:0 or siteTag: %s", p)
		}
	}

	today := res["today"].(M)
	yesterday := res["yesterday"].(M)
	if today["day"] != "2026-11-21" || today["visitors"].(float64) != 14 || today["pageviews"].(float64) != 30 || today["hasVisitors"] != true {
		t.Fatalf("today Dhaka bucketing wrong: %v", today)
	}
	if yesterday["day"] != "2026-11-20" || yesterday["visitors"].(float64) != 5 || yesterday["pageviews"].(float64) != 12 || yesterday["finalized"] != true {
		t.Fatalf("yesterday Dhaka bucketing wrong: %v", yesterday)
	}

	// Verify backfill did not overwrite finalized unsampled 2026-11-10, while inserting 2026-11-05.
	var v10, v05 int64
	if err := db.QueryRow(bg, `SELECT visitors FROM analytics_daily WHERE day='2026-11-10'`).Scan(&v10); err != nil || v10 != 88 {
		t.Fatalf("2026-11-10 visitors = %d (%v), want 88", v10, err)
	}
	if err := db.QueryRow(bg, `SELECT visitors FROM analytics_daily WHERE day='2026-11-05'`).Scan(&v05); err != nil || v05 != 18 {
		t.Fatalf("2026-11-05 visitors = %d (%v), want 18", v05, err)
	}

	// Breakdowns exclude /checkout/ and normalize empty refererHost.
	bd := res["breakdowns"].(M)
	pages := bd["topPages"].([]any)
	if len(pages) != 1 || pages[0].(M)["path"] != "/product/rice-cooker/" {
		t.Fatalf("topPages = %v", pages)
	}
	refs := bd["referrers"].([]any)
	if len(refs) != 2 || refs[0].(M)["source"] != "Direct / bookmark" || refs[1].(M)["source"] != "facebook.com" {
		t.Fatalf("referrers = %v", refs)
	}
	devs := bd["devices"].([]any)
	if len(devs) != 1 || devs[0].(M)["device"] != "Mobile" {
		t.Fatalf("devices = %v", devs)
	}

	// Dashboard exposes cached todayVisitors without hitting Cloudflare.
	prevCalls := cfCalls
	code, dash := call(t, nil, "GET", "/api/admin/dashboard", nil, true)
	if code != 200 || cfCalls != prevCalls {
		t.Fatalf("dashboard status=%d cfCalls=%d->%d", code, prevCalls, cfCalls)
	}
	// Note: dashboard uses Postgres now(), while fixedNow is mocked in tests, so just verify field presence unless DB clock matches.
	if _, ok := dash["todayVisitors"]; !ok {
		t.Fatalf("dashboard missing todayVisitors field: %v", dash)
	}
	_ = os.Getenv("TEST_DATABASE_URL") // keeps imports tidy if adjusted

	// Second GET within 5-minute TTL hits cache and makes 0 Cloudflare calls.
	code, _ = call(t, nil, "GET", "/api/admin/analytics", nil, true)
	if code != 200 || cfCalls != prevCalls {
		t.Fatalf("cached GET called Cloudflare: status=%d calls=%d->%d", code, prevCalls, cfCalls)
	}

	// Forced POST /sync when Cloudflare fails with 500 degrades gracefully to 200 stale without leaking secrets.
	failCF = true
	code, staleRes := call(t, nil, "POST", "/api/admin/analytics/sync", "{}", true)
	if code != 200 {
		t.Fatalf("sync fallback status = %d", code)
	}
	if cfCalls <= prevCalls {
		t.Fatalf("POST /sync did not call Cloudflare")
	}
	if staleRes["stale"] != true || staleRes["syncError"] == "" {
		t.Fatalf("expected stale=true and syncError, got %v", staleRes)
	}
	errMsg := staleRes["syncError"].(string)
	if strings.Contains(errMsg, secretToken) || strings.Contains(errMsg, "secret-internal-cf-error") {
		t.Fatalf("syncError leaked internal detail: %q", errMsg)
	}
	if staleRes["today"].(M)["visitors"].(float64) != 14 {
		t.Fatalf("archived visitors lost after sync failure: %v", staleRes["today"])
	}
}
