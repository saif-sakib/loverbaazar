package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations-v7.sql
var analyticsSQL string

const (
	analyticsCacheTTL      = 5 * time.Minute
	analyticsSyncTimeout   = 15 * time.Second
	analyticsErrorFallback = "Could not refresh from Cloudflare Analytics right now. Check CLOUDFLARE_ANALYTICS_TOKEN (Account Analytics: Read) and CLOUDFLARE_ACCOUNT_ID."
)

var (
	dhakaTZ              = time.FixedZone("Asia/Dhaka", 6*3600)
	cloudflareGraphQLURL = "https://api.cloudflare.com/client/v4/graphql"
	analyticsNow         = time.Now

	analyticsSyncMu      sync.Mutex
	analyticsBreakdownMu sync.Mutex
	analyticsCacheMu     sync.RWMutex
	analyticsCache       = newEmptyAnalyticsCache()
)

type analyticsCacheState struct {
	cfgKey             string
	syncedAt           time.Time
	lastAttemptAt      time.Time
	breakdownAttemptAt time.Time
	breakdowns         analyticsBreakdowns
	syncError          string
	breakdownError     string
}

func newEmptyAnalyticsCache() analyticsCacheState {
	return analyticsCacheState{breakdowns: emptyBreakdowns()}
}

func resetAnalyticsCache() {
	analyticsCacheMu.Lock()
	analyticsCache = newEmptyAnalyticsCache()
	analyticsCacheMu.Unlock()
}

func cachedAnalytics(cfgKey string) analyticsCacheState {
	analyticsCacheMu.RLock()
	defer analyticsCacheMu.RUnlock()
	if analyticsCache.cfgKey != cfgKey {
		return newEmptyAnalyticsCache()
	}
	return analyticsCache
}

func updateAnalyticsCache(cfgKey string, update func(*analyticsCacheState)) {
	analyticsCacheMu.Lock()
	defer analyticsCacheMu.Unlock()
	if analyticsCache.cfgKey != cfgKey {
		analyticsCache = newEmptyAnalyticsCache()
		analyticsCache.cfgKey = cfgKey
	}
	update(&analyticsCache)
}

func analyticsDayStart(at time.Time) time.Time {
	day := at.In(dhakaTZ)
	return time.Date(day.Year(), day.Month(), day.Day(), 0, 0, 0, 0, dhakaTZ)
}

func analyticsRefreshDue(now, lastAttempt time.Time) bool {
	return now.Sub(lastAttempt) >= analyticsCacheTTL || analyticsDayStart(now).After(analyticsDayStart(lastAttempt))
}

type analyticsConfig struct {
	token      string
	accountID  string
	host       string
	configured bool
	missing    []string
}

func parseAnalyticsHost(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return ""
	}
	if !strings.Contains(s, "://") {
		s = "https://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	h := strings.ToLower(strings.TrimSpace(u.Hostname()))
	if h == "" || h == "localhost" || net.ParseIP(h) != nil {
		return ""
	}
	return h
}

func resolveAnalyticsHost(r *http.Request) string {
	for _, cand := range []string{
		os.Getenv("CLOUDFLARE_ANALYTICS_HOST"),
		os.Getenv("SITE_URL"),
		os.Getenv("CHECKOUT_METRICS_HOST"),
	} {
		if h := parseAnalyticsHost(cand); h != "" {
			return h
		}
	}
	if r != nil {
		if h := parseAnalyticsHost(requestHost(r)); h != "" {
			return h
		}
	}
	return "loverbaazar.com"
}

func loadAnalyticsConfig(r *http.Request) analyticsConfig {
	token := strings.TrimSpace(os.Getenv("CLOUDFLARE_ANALYTICS_TOKEN"))
	accountID := strings.TrimSpace(os.Getenv("CLOUDFLARE_ACCOUNT_ID"))
	missing := []string{}
	if token == "" {
		missing = append(missing, "CLOUDFLARE_ANALYTICS_TOKEN")
	}
	if accountID == "" {
		missing = append(missing, "CLOUDFLARE_ACCOUNT_ID")
	}
	return analyticsConfig{
		token:      token,
		accountID:  accountID,
		host:       resolveAnalyticsHost(r),
		configured: len(missing) == 0,
		missing:    missing,
	}
}

func (c analyticsConfig) key() string {
	if !c.configured {
		return ""
	}
	return c.accountID + ":" + c.host + ":" + hashTok(c.token)
}

type analyticsPathRow struct {
	Path      string `json:"path"`
	Title     string `json:"title,omitempty"`
	Kind      string `json:"kind,omitempty"`
	ProductID int64  `json:"productId,omitempty"`
	Price     *int64 `json:"price,omitempty"`
	Stock     *int   `json:"stock,omitempty"`
	Sold30d   int64  `json:"sold30d,omitempty"`
	Visits    int64  `json:"visits"`
	Pageviews int64  `json:"pageviews"`
}

type analyticsSourceRow struct {
	Source    string `json:"source"`
	Visits    int64  `json:"visits"`
	Pageviews int64  `json:"pageviews"`
}

type analyticsDeviceRow struct {
	Device    string `json:"device"`
	Visits    int64  `json:"visits"`
	Pageviews int64  `json:"pageviews"`
}

type analyticsCountryRow struct {
	Country   string `json:"country"`
	Visits    int64  `json:"visits"`
	Pageviews int64  `json:"pageviews"`
}

type analyticsBreakdowns struct {
	WindowDays int                   `json:"windowDays"`
	TopPages   []analyticsPathRow    `json:"topPages"`
	Referrers  []analyticsSourceRow  `json:"referrers"`
	Devices    []analyticsDeviceRow  `json:"devices"`
	Countries  []analyticsCountryRow `json:"countries"`
}

func emptyBreakdowns() analyticsBreakdowns {
	return analyticsBreakdowns{
		WindowDays: 7,
		TopPages:   []analyticsPathRow{},
		Referrers:  []analyticsSourceRow{},
		Devices:    []analyticsDeviceRow{},
		Countries:  []analyticsCountryRow{},
	}
}

func cloneBreakdowns(in analyticsBreakdowns) analyticsBreakdowns {
	out := emptyBreakdowns()
	if in.WindowDays > 0 {
		out.WindowDays = in.WindowDays
	}
	if len(in.TopPages) > 0 {
		out.TopPages = append(out.TopPages, in.TopPages...)
	}
	if len(in.Referrers) > 0 {
		out.Referrers = append(out.Referrers, in.Referrers...)
	}
	if len(in.Devices) > 0 {
		out.Devices = append(out.Devices, in.Devices...)
	}
	if len(in.Countries) > 0 {
		out.Countries = append(out.Countries, in.Countries...)
	}
	return out
}

type analyticsDaySummary struct {
	Day         string  `json:"day"`
	Visitors    int64   `json:"visitors"`
	Pageviews   int64   `json:"pageviews"`
	Orders      int64   `json:"orders"`
	Sales       int64   `json:"sales"`
	HasVisitors bool    `json:"hasVisitors"`
	SampleRate  float64 `json:"sampleRate"`
	Finalized   bool    `json:"finalized"`
}

type analytics7DaySummary struct {
	Visitors         int64                 `json:"visitors"`
	Pageviews        int64                 `json:"pageviews"`
	Orders           int64                 `json:"orders"`
	Sales            int64                 `json:"sales"`
	DaysRecorded     int                   `json:"daysRecorded"`
	PrevVisitors     int64                 `json:"prevVisitors"`
	PrevPageviews    int64                 `json:"prevPageviews"`
	PrevOrders       int64                 `json:"prevOrders"`
	PrevSales        int64                 `json:"prevSales"`
	PrevDaysRecorded int                   `json:"prevDaysRecorded"`
	Days             []analyticsDaySummary `json:"days"`
}

type analyticsMonthSummary struct {
	Month        string   `json:"month"`
	Label        string   `json:"label"`
	Current      bool     `json:"current"`
	Visitors     int64    `json:"visitors"`
	Pageviews    int64    `json:"pageviews"`
	Orders       int64    `json:"orders"`
	Sales        int64    `json:"sales"`
	DaysRecorded int      `json:"daysRecorded"`
	DaysInPeriod int      `json:"daysInPeriod"`
	SampledDays  int      `json:"sampledDays"`
	AvgPerDay    *float64 `json:"avgPerDay"`
	ChangePct    *float64 `json:"changePct"`
}

type analyticsReport struct {
	Configured    bool                    `json:"configured"`
	MissingConfig []string                `json:"missingConfig"`
	Source        string                  `json:"source"`
	SourceLabel   string                  `json:"sourceLabel"`
	Timezone      string                  `json:"timezone"`
	SyncedAt      string                  `json:"syncedAt"`
	RefreshDue    bool                    `json:"refreshDue"`
	Stale         bool                    `json:"stale"`
	SyncError     string                  `json:"syncError"`
	LowStock      int                     `json:"lowStock"`
	Today         analyticsDaySummary     `json:"today"`
	Yesterday     analyticsDaySummary     `json:"yesterday"`
	Last7Days     analytics7DaySummary    `json:"last7Days"`
	Months        []analyticsMonthSummary `json:"months"`
	Breakdowns    analyticsBreakdowns     `json:"breakdowns"`
}

type cfRUMGroup struct {
	Count float64 `json:"count"`
	Sum   struct {
		Visits float64 `json:"visits"`
	} `json:"sum"`
	Avg struct {
		SampleInterval float64 `json:"sampleInterval"`
	} `json:"avg"`
	Dimensions struct {
		Date         string `json:"date"`
		DatetimeHour string `json:"datetimeHour"`
		RequestPath  string `json:"requestPath"`
		RefererHost  string `json:"refererHost"`
		DeviceType   string `json:"deviceType"`
		CountryName  string `json:"countryName"`
	} `json:"dimensions"`
}

func runCloudflareGraphQL(ctx context.Context, token, query string, vars map[string]any, target any) error {
	payload, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, cloudflareGraphQLURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return errors.New("cloudflare request failed")
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 2<<20))
	if err != nil {
		return errors.New("cloudflare response unreadable")
	}
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("cloudflare status %d", res.StatusCode)
	}
	var envelope struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return errors.New("cloudflare invalid json")
	}
	if len(envelope.Errors) > 0 {
		return errors.New("cloudflare graphql error")
	}
	if len(envelope.Data) == 0 || string(envelope.Data) == "null" {
		return errors.New("cloudflare empty data")
	}
	return json.Unmarshal(envelope.Data, target)
}

func parseCFTime(raw string) (time.Time, error) {
	if t, err := time.Parse(time.RFC3339Nano, raw); err == nil {
		return t, nil
	}
	return time.Parse(time.RFC3339, raw)
}

func roundNonNeg(v float64) int64 {
	if math.IsNaN(v) || math.IsInf(v, 0) || v <= 0 {
		return 0
	}
	return int64(math.Round(v))
}

func isPrivateAnalyticsPath(p string) bool {
	lower := strings.ToLower(strings.TrimSpace(p))
	for _, prefix := range []string{"/admin", "/checkout", "/cart", "/my-account", "/track", "/api"} {
		if lower == prefix || strings.HasPrefix(lower, prefix+"/") {
			return true
		}
	}
	return false
}

func cleanDeviceLabel(raw string) string {
	s := strings.TrimSpace(raw)
	if s == "" {
		return "Unknown"
	}
	lower := strings.ToLower(s)
	return strings.ToUpper(lower[:1]) + lower[1:]
}

func hostMatches(host, domain string) bool {
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func classifyReferrer(rawHost, siteHost string) (string, bool) {
	host := strings.ToLower(strings.TrimSpace(rawHost))
	if host == "" {
		return "Direct / shared link", false
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	baseSite := strings.TrimPrefix(strings.ToLower(strings.TrimSpace(siteHost)), "www.")
	cleanHost := strings.TrimPrefix(host, "www.")
	if baseSite != "" && (cleanHost == baseSite || strings.HasSuffix(cleanHost, "."+baseSite)) {
		return "", true
	}
	switch {
	case host == "com.google.android.googlequicksearchbox" || host == "search.app.goo.gl" || host == "l.google.com" || strings.HasPrefix(cleanHost, "google."):
		return "Google Search", false
	case hostMatches(host, "facebook.com") || hostMatches(host, "fb.com") || host == "fb.me":
		return "Facebook", false
	case hostMatches(host, "instagram.com"):
		return "Instagram", false
	case hostMatches(host, "youtube.com") || host == "youtu.be":
		return "YouTube", false
	case hostMatches(host, "whatsapp.com") || host == "wa.me":
		return "WhatsApp", false
	case hostMatches(host, "messenger.com"):
		return "Messenger", false
	case hostMatches(host, "bing.com"):
		return "Bing Search", false
	case hostMatches(host, "duckduckgo.com"):
		return "DuckDuckGo", false
	case hostMatches(host, "yahoo.com"):
		return "Yahoo Search", false
	case host == "chatgpt.com" || host == "chat.openai.com":
		return "ChatGPT", false
	case hostMatches(host, "tiktok.com"):
		return "TikTok", false
	case host == "t.co" || hostMatches(host, "x.com") || hostMatches(host, "twitter.com"):
		return "X (Twitter)", false
	case hostMatches(host, "linkedin.com") || host == "lnkd.in":
		return "LinkedIn", false
	case hostMatches(host, "pinterest.com"):
		return "Pinterest", false
	}
	return clip(cleanHost, 120), false
}

func humanizeSlug(raw string) string {
	trimmed := strings.Trim(strings.TrimSpace(raw), "/")
	if trimmed == "" {
		return "Home page"
	}
	if dec, err := url.PathUnescape(trimmed); err == nil && dec != "" {
		trimmed = dec
	}
	parts := strings.Split(trimmed, "/")
	seg := parts[len(parts)-1]
	words := strings.Fields(strings.NewReplacer("-", " ", "_", " ").Replace(seg))
	for i, w := range words {
		if len(w) > 0 && w[0] >= 'a' && w[0] <= 'z' {
			words[i] = strings.ToUpper(w[:1]) + w[1:]
		}
	}
	if len(words) == 0 {
		return raw
	}
	return strings.Join(words, " ")
}

var staticPageTitles = map[string][2]string{
	"/":                         {"Home page", "home"},
	"/shop/":                    {"All products (Shop)", "page"},
	"/shop":                     {"All products (Shop)", "page"},
	"/offers/":                  {"Offers & Discounts", "page"},
	"/offers":                   {"Offers & Discounts", "page"},
	"/blog/":                    {"Blog", "blog"},
	"/blog":                     {"Blog", "blog"},
	"/contact-us/":              {"Contact us", "page"},
	"/contact-us":               {"Contact us", "page"},
	"/online-shopping-jashore/": {"Online shopping in Jashore", "page"},
	"/online-shopping-jashore":  {"Online shopping in Jashore", "page"},
}

func enrichTopPages(ctx context.Context, pages []analyticsPathRow) {
	if len(pages) == 0 {
		return
	}
	type prodMeta struct {
		id    int64
		price int64
		stock int
		name  string
		sold  int64
	}
	type contentMeta struct {
		kind, title string
	}

	prodKeysMap := map[string]bool{}
	contentKeysMap := map[string]bool{}
	for _, p := range pages {
		trimmed := strings.Trim(strings.TrimSpace(p.Path), "/")
		if trimmed == "" {
			continue
		}
		addKey := func(m map[string]bool, s string) {
			if s == "" {
				return
			}
			m[s] = true
			m[strings.ToLower(s)] = true
			if dec, err := url.PathUnescape(s); err == nil && dec != "" {
				m[dec] = true
				m[strings.ToLower(dec)] = true
			}
		}
		switch {
		case strings.HasPrefix(trimmed, "product/"):
			slug := strings.Trim(strings.TrimPrefix(trimmed, "product/"), "/")
			addKey(prodKeysMap, slug)
		case strings.HasPrefix(trimmed, "product-category/"):
			catPath := strings.Trim(strings.TrimPrefix(trimmed, "product-category/"), "/")
			addKey(contentKeysMap, catPath)
			parts := strings.Split(catPath, "/")
			addKey(contentKeysMap, parts[len(parts)-1])
		case strings.HasPrefix(trimmed, "product-tag/"):
			addKey(contentKeysMap, strings.Trim(strings.TrimPrefix(trimmed, "product-tag/"), "/"))
		case strings.HasPrefix(trimmed, "blog/"):
			addKey(contentKeysMap, strings.Trim(strings.TrimPrefix(trimmed, "blog/"), "/"))
		default:
			addKey(contentKeysMap, trimmed)
		}
	}

	prodsByKey := map[string]*prodMeta{}
	prodsByID := map[int64]*prodMeta{}
	if len(prodKeysMap) > 0 {
		keys := make([]string, 0, len(prodKeysMap))
		for k := range prodKeysMap {
			keys = append(keys, k)
		}
		rows, err := db.Query(ctx, `SELECT id, slug, price, stock, coalesce(data->>'name', slug) FROM products WHERE slug = ANY($1) OR lower(slug) = ANY($1)`, keys)
		if err == nil {
			for rows.Next() {
				var pm prodMeta
				var slug string
				if rows.Scan(&pm.id, &slug, &pm.price, &pm.stock, &pm.name) == nil {
					copyPM := pm
					prodsByID[copyPM.id] = &copyPM
					prodsByKey[slug] = &copyPM
					prodsByKey[strings.ToLower(slug)] = &copyPM
					if dec, e := url.PathUnescape(slug); e == nil && dec != "" {
						prodsByKey[dec] = &copyPM
						prodsByKey[strings.ToLower(dec)] = &copyPM
					}
				}
			}
			rows.Close()
		}
		if len(prodsByID) > 0 {
			ids := make([]int64, 0, len(prodsByID))
			for id := range prodsByID {
				ids = append(ids, id)
			}
			srows, err := db.Query(ctx, `
				SELECT oi.product_id, coalesce(sum(oi.qty), 0)
				FROM order_items oi
				JOIN orders o ON o.id = oi.order_id
				WHERE oi.product_id = ANY($1) AND o.status NOT IN `+outStatuses+` AND o.created_at > now() - interval '30 days'
				GROUP BY oi.product_id`, ids)
			if err == nil {
				for srows.Next() {
					var pid, sold int64
					if srows.Scan(&pid, &sold) == nil {
						if pm, ok := prodsByID[pid]; ok {
							pm.sold = sold
						}
					}
				}
				srows.Close()
			}
		}
	}

	contentByKey := map[string]contentMeta{}
	if len(contentKeysMap) > 0 {
		keys := make([]string, 0, len(contentKeysMap))
		for k := range contentKeysMap {
			keys = append(keys, k)
		}
		rows, err := db.Query(ctx, `
			SELECT kind, slug, coalesce(data->>'path',''), coalesce(nullif(data->>'name',''), nullif(data->>'title',''), slug)
			FROM content
			WHERE kind IN ('cat','tag','post','page')
			  AND (slug = ANY($1) OR lower(slug) = ANY($1) OR lower(coalesce(data->>'path','')) = ANY($1))`, keys)
		if err == nil {
			for rows.Next() {
				var kind, slug, cpath, title string
				if rows.Scan(&kind, &slug, &cpath, &title) == nil {
					cm := contentMeta{kind: kind, title: title}
					contentByKey[kind+":"+slug] = cm
					contentByKey[kind+":"+strings.ToLower(slug)] = cm
					if dec, e := url.PathUnescape(slug); e == nil && dec != "" {
						contentByKey[kind+":"+dec] = cm
						contentByKey[kind+":"+strings.ToLower(dec)] = cm
					}
					if cpath != "" {
						contentByKey[kind+":"+strings.ToLower(strings.Trim(cpath, "/"))] = cm
					}
				}
			}
			rows.Close()
		}
	}

	lookupContent := func(kind, key string) (contentMeta, bool) {
		for _, cand := range []string{key, strings.ToLower(key)} {
			if cm, ok := contentByKey[kind+":"+cand]; ok {
				return cm, true
			}
		}
		if dec, err := url.PathUnescape(key); err == nil && dec != "" {
			for _, cand := range []string{dec, strings.ToLower(dec)} {
				if cm, ok := contentByKey[kind+":"+cand]; ok {
					return cm, true
				}
			}
		}
		return contentMeta{}, false
	}

	for i := range pages {
		p := &pages[i]
		if static, ok := staticPageTitles[strings.ToLower(p.Path)]; ok {
			p.Title = static[0]
			p.Kind = static[1]
			continue
		}
		trimmed := strings.Trim(strings.TrimSpace(p.Path), "/")
		switch {
		case strings.HasPrefix(trimmed, "product/"):
			slug := strings.Trim(strings.TrimPrefix(trimmed, "product/"), "/")
			p.Kind = "product"
			var pm *prodMeta
			for _, cand := range []string{slug, strings.ToLower(slug)} {
				if hit, ok := prodsByKey[cand]; ok {
					pm = hit
					break
				}
			}
			if pm == nil {
				if dec, err := url.PathUnescape(slug); err == nil && dec != "" {
					for _, cand := range []string{dec, strings.ToLower(dec)} {
						if hit, ok := prodsByKey[cand]; ok {
							pm = hit
							break
						}
					}
				}
			}
			if pm != nil {
				p.Title = pm.name
				p.ProductID = pm.id
				priceVal := pm.price
				stockVal := pm.stock
				p.Price = &priceVal
				p.Stock = &stockVal
				p.Sold30d = pm.sold
			} else {
				p.Title = humanizeSlug(slug)
			}
		case strings.HasPrefix(trimmed, "product-category/"):
			catPath := strings.Trim(strings.TrimPrefix(trimmed, "product-category/"), "/")
			parts := strings.Split(catPath, "/")
			p.Kind = "category"
			if cm, ok := lookupContent("cat", catPath); ok {
				p.Title = cm.title
			} else if cm, ok := lookupContent("cat", parts[len(parts)-1]); ok {
				p.Title = cm.title
			} else {
				p.Title = humanizeSlug(catPath)
			}
		case strings.HasPrefix(trimmed, "product-tag/"):
			slug := strings.Trim(strings.TrimPrefix(trimmed, "product-tag/"), "/")
			p.Kind = "tag"
			if cm, ok := lookupContent("tag", slug); ok {
				p.Title = cm.title
			} else {
				p.Title = humanizeSlug(slug)
			}
		case strings.HasPrefix(trimmed, "blog/"):
			slug := strings.Trim(strings.TrimPrefix(trimmed, "blog/"), "/")
			p.Kind = "blog"
			if cm, ok := lookupContent("post", slug); ok {
				p.Title = cm.title
			} else {
				p.Title = humanizeSlug(slug)
			}
		default:
			p.Kind = "page"
			if cm, ok := lookupContent("page", trimmed); ok {
				p.Title = cm.title
			} else {
				p.Title = humanizeSlug(trimmed)
			}
		}
	}
}

func fetchCloudflareHourlyRUM(ctx context.Context, cfg analyticsConfig, todayStart, end time.Time) (map[string]struct {
	visitors, pageviews int64
	sampleRate          float64
}, []string, error) {
	const query = `query LoverBaazarHourlyRUM($accountTag: String!, $host: String!, $hourlyStart: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 500
        orderBy: [datetimeHour_ASC]
        filter: {
          requestHost: $host
          bot: 0
          datetime_geq: $hourlyStart
          datetime_lt: $end
        }
      ) {
        count
        sum { visits }
        avg { sampleInterval }
        dimensions { datetimeHour }
      }
    }
  }
}`
	hourlyStart := todayStart.AddDate(0, 0, -7).UTC()
	var resp struct {
		Viewer struct {
			Accounts []struct {
				Groups []cfRUMGroup `json:"rumPageloadEventsAdaptiveGroups"`
			} `json:"accounts"`
		} `json:"viewer"`
	}
	err := runCloudflareGraphQL(ctx, cfg.token, query, map[string]any{
		"accountTag":  cfg.accountID,
		"host":        cfg.host,
		"hourlyStart": hourlyStart.Format(time.RFC3339),
		"end":         end.Format(time.RFC3339),
	}, &resp)
	if err != nil {
		return nil, nil, err
	}
	if len(resp.Viewer.Accounts) == 0 {
		return nil, nil, errors.New("cloudflare account not returned")
	}

	type dayAgg struct {
		visitors, pageviews int64
		sampleRate          float64
	}
	byDay := make(map[string]*dayAgg, 8)
	ordered := make([]string, 0, 8)
	for offset := -7; offset <= 0; offset++ {
		d := todayStart.AddDate(0, 0, offset).Format("2006-01-02")
		ordered = append(ordered, d)
		byDay[d] = &dayAgg{sampleRate: 1}
	}

	for _, g := range resp.Viewer.Accounts[0].Groups {
		if g.Dimensions.DatetimeHour == "" {
			continue
		}
		ts, err := parseCFTime(g.Dimensions.DatetimeHour)
		if err != nil {
			continue
		}
		dayStr := ts.In(dhakaTZ).Format("2006-01-02")
		agg, ok := byDay[dayStr]
		if !ok {
			continue
		}
		agg.visitors += roundNonNeg(g.Sum.Visits)
		agg.pageviews += roundNonNeg(g.Count)
		sr := g.Avg.SampleInterval
		if math.IsNaN(sr) || math.IsInf(sr, 0) || sr < 1 {
			sr = 1
		}
		if sr > agg.sampleRate {
			agg.sampleRate = sr
		}
	}

	out := make(map[string]struct {
		visitors, pageviews int64
		sampleRate          float64
	}, len(ordered))
	for _, d := range ordered {
		a := byDay[d]
		out[d] = struct {
			visitors, pageviews int64
			sampleRate          float64
		}{a.visitors, a.pageviews, a.sampleRate}
	}
	return out, ordered, nil
}

func fetchCloudflareBreakdowns(ctx context.Context, cfg analyticsConfig, todayStart, end time.Time) (analyticsBreakdowns, error) {
	const query = `query LoverBaazarBreakdowns($accountTag: String!, $host: String!, $start: Time!, $end: Time!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      pages: rumPageloadEventsAdaptiveGroups(
        limit: 12
        orderBy: [sum_visits_DESC]
        filter: { requestHost: $host, bot: 0, datetime_geq: $start, datetime_lt: $end }
      ) {
        count
        sum { visits }
        dimensions { requestPath }
      }
      referrers: rumPageloadEventsAdaptiveGroups(
        limit: 25
        orderBy: [sum_visits_DESC]
        filter: { requestHost: $host, bot: 0, datetime_geq: $start, datetime_lt: $end }
      ) {
        count
        sum { visits }
        dimensions { refererHost }
      }
      devices: rumPageloadEventsAdaptiveGroups(
        limit: 6
        orderBy: [sum_visits_DESC]
        filter: { requestHost: $host, bot: 0, datetime_geq: $start, datetime_lt: $end }
      ) {
        count
        sum { visits }
        dimensions { deviceType }
      }
      countries: rumPageloadEventsAdaptiveGroups(
        limit: 10
        orderBy: [sum_visits_DESC]
        filter: { requestHost: $host, bot: 0, datetime_geq: $start, datetime_lt: $end }
      ) {
        count
        sum { visits }
        dimensions { countryName }
      }
    }
  }
}`
	start := todayStart.AddDate(0, 0, -6).UTC()
	var resp struct {
		Viewer struct {
			Accounts []struct {
				Pages     []cfRUMGroup `json:"pages"`
				Referrers []cfRUMGroup `json:"referrers"`
				Devices   []cfRUMGroup `json:"devices"`
				Countries []cfRUMGroup `json:"countries"`
			} `json:"accounts"`
		} `json:"viewer"`
	}
	if err := runCloudflareGraphQL(ctx, cfg.token, query, map[string]any{
		"accountTag": cfg.accountID,
		"host":       cfg.host,
		"start":      start.Format(time.RFC3339),
		"end":        end.Format(time.RFC3339),
	}, &resp); err != nil {
		return emptyBreakdowns(), err
	}
	if len(resp.Viewer.Accounts) == 0 {
		return emptyBreakdowns(), errors.New("cloudflare account not returned")
	}

	acc := resp.Viewer.Accounts[0]
	out := emptyBreakdowns()

	type counts struct{ visits, views int64 }

	pageMap := map[string]counts{}
	for _, g := range acc.Pages {
		p := strings.TrimSpace(g.Dimensions.RequestPath)
		if p == "" {
			p = "/"
		}
		if isPrivateAnalyticsPath(p) {
			continue
		}
		p = clip(p, 200)
		c := pageMap[p]
		c.visits += roundNonNeg(g.Sum.Visits)
		c.views += roundNonNeg(g.Count)
		pageMap[p] = c
	}
	for k, c := range pageMap {
		out.TopPages = append(out.TopPages, analyticsPathRow{Path: k, Visits: c.visits, Pageviews: c.views})
	}
	sort.Slice(out.TopPages, func(i, j int) bool {
		if out.TopPages[i].Visits != out.TopPages[j].Visits {
			return out.TopPages[i].Visits > out.TopPages[j].Visits
		}
		if out.TopPages[i].Pageviews != out.TopPages[j].Pageviews {
			return out.TopPages[i].Pageviews > out.TopPages[j].Pageviews
		}
		return out.TopPages[i].Path < out.TopPages[j].Path
	})
	if len(out.TopPages) > 10 {
		out.TopPages = out.TopPages[:10]
	}

	refMap := map[string]counts{}
	for _, g := range acc.Referrers {
		visits := roundNonNeg(g.Sum.Visits)
		views := roundNonNeg(g.Count)
		if visits == 0 {
			continue
		}
		s, skip := classifyReferrer(g.Dimensions.RefererHost, cfg.host)
		if skip {
			continue
		}
		c := refMap[s]
		c.visits += visits
		c.views += views
		refMap[s] = c
	}
	for k, c := range refMap {
		out.Referrers = append(out.Referrers, analyticsSourceRow{Source: k, Visits: c.visits, Pageviews: c.views})
	}
	sort.Slice(out.Referrers, func(i, j int) bool {
		if out.Referrers[i].Visits != out.Referrers[j].Visits {
			return out.Referrers[i].Visits > out.Referrers[j].Visits
		}
		if out.Referrers[i].Pageviews != out.Referrers[j].Pageviews {
			return out.Referrers[i].Pageviews > out.Referrers[j].Pageviews
		}
		return out.Referrers[i].Source < out.Referrers[j].Source
	})
	if len(out.Referrers) > 10 {
		out.Referrers = out.Referrers[:10]
	}

	devMap := map[string]counts{}
	for _, g := range acc.Devices {
		d := clip(cleanDeviceLabel(g.Dimensions.DeviceType), 40)
		c := devMap[d]
		c.visits += roundNonNeg(g.Sum.Visits)
		c.views += roundNonNeg(g.Count)
		devMap[d] = c
	}
	for k, c := range devMap {
		out.Devices = append(out.Devices, analyticsDeviceRow{Device: k, Visits: c.visits, Pageviews: c.views})
	}
	sort.Slice(out.Devices, func(i, j int) bool {
		if out.Devices[i].Visits != out.Devices[j].Visits {
			return out.Devices[i].Visits > out.Devices[j].Visits
		}
		if out.Devices[i].Pageviews != out.Devices[j].Pageviews {
			return out.Devices[i].Pageviews > out.Devices[j].Pageviews
		}
		return out.Devices[i].Device < out.Devices[j].Device
	})

	ctryMap := map[string]counts{}
	for _, g := range acc.Countries {
		k := clip(strings.TrimSpace(g.Dimensions.CountryName), 80)
		if k == "" {
			k = "Unknown"
		}
		c := ctryMap[k]
		c.visits += roundNonNeg(g.Sum.Visits)
		c.views += roundNonNeg(g.Count)
		ctryMap[k] = c
	}
	for k, c := range ctryMap {
		out.Countries = append(out.Countries, analyticsCountryRow{Country: k, Visits: c.visits, Pageviews: c.views})
	}
	sort.Slice(out.Countries, func(i, j int) bool {
		if out.Countries[i].Visits != out.Countries[j].Visits {
			return out.Countries[i].Visits > out.Countries[j].Visits
		}
		if out.Countries[i].Pageviews != out.Countries[j].Pageviews {
			return out.Countries[i].Pageviews > out.Countries[j].Pageviews
		}
		return out.Countries[i].Country < out.Countries[j].Country
	})
	if len(out.Countries) > 10 {
		out.Countries = out.Countries[:10]
	}

	return out, nil
}

func backfillCloudflare30Days(ctx context.Context, cfg analyticsConfig, todayStart time.Time) {
	backfillStart := todayStart.AddDate(0, 0, -30).Format("2006-01-02")
	backfillEnd := todayStart.AddDate(0, 0, -8).Format("2006-01-02")
	var existing int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date`, backfillStart, backfillEnd).Scan(&existing); err != nil || existing >= 23 {
		return
	}
	const query = `query LoverBaazarBackfillRUM($accountTag: String!, $host: String!, $startDate: Date!, $endDate: Date!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      rumPageloadEventsAdaptiveGroups(
        limit: 40
        orderBy: [date_ASC]
        filter: {
          requestHost: $host
          bot: 0
          date_geq: $startDate
          date_leq: $endDate
        }
      ) {
        count
        sum { visits }
        avg { sampleInterval }
        dimensions { date }
      }
    }
  }
}`
	var resp struct {
		Viewer struct {
			Accounts []struct {
				Groups []cfRUMGroup `json:"rumPageloadEventsAdaptiveGroups"`
			} `json:"accounts"`
		} `json:"viewer"`
	}
	if err := runCloudflareGraphQL(ctx, cfg.token, query, map[string]any{
		"accountTag": cfg.accountID,
		"host":       cfg.host,
		"startDate":  backfillStart,
		"endDate":    backfillEnd,
	}, &resp); err != nil || len(resp.Viewer.Accounts) == 0 {
		return
	}
	type row struct {
		day                 string
		visitors, pageviews int64
		sampleRate          float64
	}
	var rows []row
	for _, g := range resp.Viewer.Accounts[0].Groups {
		d := strings.TrimSpace(g.Dimensions.Date)
		if d < backfillStart || d > backfillEnd {
			continue
		}
		if _, err := time.Parse("2006-01-02", d); err != nil {
			continue
		}
		sr := g.Avg.SampleInterval
		if math.IsNaN(sr) || math.IsInf(sr, 0) || sr < 1 {
			sr = 1
		}
		rows = append(rows, row{day: d, visitors: roundNonNeg(g.Sum.Visits), pageviews: roundNonNeg(g.Count), sampleRate: sr})
	}
	if len(rows) == 0 {
		return
	}
	_ = pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		for _, r := range rows {
			if _, err := tx.Exec(ctx, `
				INSERT INTO analytics_daily(day, visitors, pageviews, sample_rate, source, finalized, updated_at)
				VALUES($1::date, $2, $3, $4, 'cloudflare_rum_backfill', TRUE, now())
				ON CONFLICT(day) DO NOTHING`,
				r.day, r.visitors, r.pageviews, r.sampleRate); err != nil {
				return err
			}
		}
		return nil
	})
}

// Traffic refreshes are shared by the full report and the Overview tile.
func syncCloudflareTraffic(ctx context.Context, cfg analyticsConfig, force bool) bool {
	if !cfg.configured {
		return false
	}
	syncCtx, cancel := context.WithTimeout(ctx, analyticsSyncTimeout)
	defer cancel()

	analyticsSyncMu.Lock()
	defer analyticsSyncMu.Unlock()
	if syncCtx.Err() != nil {
		return false
	}

	now := analyticsNow()
	cfgKey := cfg.key()
	cached := cachedAnalytics(cfgKey)
	if !force && !analyticsRefreshDue(now, cached.lastAttemptAt) {
		return cached.syncError == ""
	}

	todayStart := analyticsDayStart(now)
	hourly, days, err := fetchCloudflareHourlyRUM(syncCtx, cfg, todayStart, now.UTC().Add(time.Minute))
	if err != nil {
		log.Printf("analytics_sync event=cloudflare_hourly_failed reason=%s", err)
		updateAnalyticsCache(cfgKey, func(state *analyticsCacheState) {
			state.lastAttemptAt = now
			state.syncError = analyticsErrorFallback
		})
		return false
	}

	visitors := make([]int64, 0, len(days))
	views := make([]int64, 0, len(days))
	sampleRates := make([]float64, 0, len(days))
	for _, day := range days {
		visitors = append(visitors, hourly[day].visitors)
		views = append(views, hourly[day].pageviews)
		sampleRates = append(sampleRates, hourly[day].sampleRate)
	}
	_, err = db.Exec(syncCtx, `
		INSERT INTO analytics_daily(day, visitors, pageviews, sample_rate, source, finalized, updated_at)
		SELECT day::date, visitors, pageviews, sample_rate, 'cloudflare_rum', day::date < $5::date, now()
		FROM unnest($1::text[], $2::bigint[], $3::bigint[], $4::float8[]) AS traffic(day, visitors, pageviews, sample_rate)
		ON CONFLICT(day) DO UPDATE SET
		  visitors = EXCLUDED.visitors,
		  pageviews = EXCLUDED.pageviews,
		  sample_rate = EXCLUDED.sample_rate,
		  source = EXCLUDED.source,
		  finalized = EXCLUDED.finalized,
		  updated_at = now()
		WHERE NOT analytics_daily.finalized
		   OR EXCLUDED.sample_rate < analytics_daily.sample_rate
		   OR (analytics_daily.day >= $6::date AND EXCLUDED.sample_rate <= analytics_daily.sample_rate)`,
		days, visitors, views, sampleRates, todayStart.Format("2006-01-02"), todayStart.AddDate(0, 0, -2).Format("2006-01-02"))
	if err != nil {
		log.Printf("analytics_sync event=db_upsert_failed type=%T", err)
		updateAnalyticsCache(cfgKey, func(state *analyticsCacheState) {
			state.lastAttemptAt = now
			state.syncError = "Visitor history could not be saved right now. Showing previously archived totals."
		})
		return false
	}

	updateAnalyticsCache(cfgKey, func(state *analyticsCacheState) {
		state.syncedAt = now.UTC()
		state.lastAttemptAt = now
		state.syncError = ""
	})
	return true
}

func syncCloudflareAnalytics(ctx context.Context, cfg analyticsConfig, force bool) {
	syncCtx, cancel := context.WithTimeout(ctx, analyticsSyncTimeout)
	defer cancel()
	if !syncCloudflareTraffic(syncCtx, cfg, force) {
		return
	}

	analyticsBreakdownMu.Lock()
	defer analyticsBreakdownMu.Unlock()
	if syncCtx.Err() != nil {
		return
	}
	now := analyticsNow()
	cfgKey := cfg.key()
	if !force && !analyticsRefreshDue(now, cachedAnalytics(cfgKey).breakdownAttemptAt) {
		return
	}

	todayStart := analyticsDayStart(now)
	breakdowns, err := fetchCloudflareBreakdowns(syncCtx, cfg, todayStart, now.UTC().Add(time.Minute))
	if err != nil {
		log.Printf("analytics_sync event=cloudflare_breakdowns_failed")
	}
	updateAnalyticsCache(cfgKey, func(state *analyticsCacheState) {
		state.breakdownAttemptAt = now
		state.breakdownError = ""
		if err != nil {
			state.breakdownError = "Cloudflare could not update the traffic breakdowns."
			return
		}
		state.breakdowns = breakdowns
	})
	backfillCloudflare30Days(syncCtx, cfg, todayStart)
}

func buildAnalyticsReport(ctx context.Context, now time.Time, cfg analyticsConfig) (analyticsReport, error) {
	today := analyticsDayStart(now)
	todayStr := today.Format("2006-01-02")
	yesterdayStr := today.AddDate(0, 0, -1).Format("2006-01-02")
	start14Str := today.AddDate(0, 0, -13).Format("2006-01-02")
	curMonthStart := today.AddDate(0, 0, 1-today.Day())
	monthStart12 := curMonthStart.AddDate(0, -11, 0)

	type monthTotals struct {
		visitors, pageviews int64
		orders, sales       int64
		days, sampledDays   int
	}
	monthsByDate := map[string]monthTotals{}
	recentDays := map[string]analyticsDaySummary{}
	var lastSaved time.Time

	// Read the archive once for both charts, with one indexed pass over the order date range.
	rows, err := db.Query(ctx, `
		WITH order_days AS (
		  SELECT (created_at AT TIME ZONE 'Asia/Dhaka')::date AS day, count(*) AS orders, sum(total) AS sales
		  FROM orders
		  WHERE created_at >= ($1::date::timestamp AT TIME ZONE 'Asia/Dhaka')
		    AND created_at < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Dhaka')
		    AND status NOT IN `+outStatuses+`
		  GROUP BY day
		)
		SELECT to_char(day, 'YYYY-MM-DD'), coalesce(a.visitors,0), coalesce(a.pageviews,0),
		       a.day IS NOT NULL, coalesce(a.sample_rate,1), coalesce(a.finalized,false), a.updated_at,
		       coalesce(o.orders,0), coalesce(o.sales,0)
		FROM (SELECT * FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date) a
		FULL JOIN order_days o USING(day)`, monthStart12.Format("2006-01-02"), todayStr)
	if err != nil {
		return analyticsReport{}, err
	}
	var d analyticsDaySummary
	var updatedAt *time.Time
	_, err = pgx.ForEachRow(rows, []any{&d.Day, &d.Visitors, &d.Pageviews, &d.HasVisitors, &d.SampleRate, &d.Finalized, &updatedAt, &d.Orders, &d.Sales}, func() error {
		if d.Day >= start14Str {
			recentDays[d.Day] = d
		}
		key := d.Day[:7]
		month := monthsByDate[key]
		month.orders += d.Orders
		month.sales += d.Sales
		if d.HasVisitors {
			month.visitors += d.Visitors
			month.pageviews += d.Pageviews
			month.days++
			if d.SampleRate > 1 {
				month.sampledDays++
			}
			if updatedAt != nil && updatedAt.After(lastSaved) {
				lastSaved = *updatedAt
			}
		}
		monthsByDate[key] = month
		return nil
	})
	if err != nil {
		return analyticsReport{}, err
	}

	dayAt := func(day string) analyticsDaySummary {
		if row, ok := recentDays[day]; ok {
			return row
		}
		return analyticsDaySummary{Day: day, SampleRate: 1}
	}
	last7 := analytics7DaySummary{Days: make([]analyticsDaySummary, 0, 7)}
	for offset := -13; offset <= 0; offset++ {
		day := dayAt(today.AddDate(0, 0, offset).Format("2006-01-02"))
		if offset < -6 {
			last7.PrevOrders += day.Orders
			last7.PrevSales += day.Sales
			if day.HasVisitors {
				last7.PrevVisitors += day.Visitors
				last7.PrevPageviews += day.Pageviews
				last7.PrevDaysRecorded++
			}
		} else {
			last7.Orders += day.Orders
			last7.Sales += day.Sales
			if day.HasVisitors {
				last7.Visitors += day.Visitors
				last7.Pageviews += day.Pageviews
				last7.DaysRecorded++
			}
			last7.Days = append(last7.Days, day)
		}
	}

	months := make([]analyticsMonthSummary, 0, 12)
	for i := 0; i < 12; i++ {
		mStart := monthStart12.AddDate(0, i, 0)
		mStr := mStart.Format("2006-01")
		current := i == 11
		daysInPeriod := mStart.AddDate(0, 1, -1).Day()
		if current {
			daysInPeriod = today.Day()
		}
		month := monthsByDate[mStr]
		var avgPerDay *float64
		if month.days > 0 {
			avg := math.Round((float64(month.visitors)/float64(month.days))*10) / 10
			avgPerDay = &avg
		}
		var changePct *float64
		if i > 0 && month.days > 0 {
			prev := months[i-1]
			if prev.DaysRecorded > 0 && prev.Visitors > 0 {
				pct := math.Round(((float64(month.visitors)-float64(prev.Visitors))/float64(prev.Visitors))*1000) / 10
				changePct = &pct
			}
		}
		months = append(months, analyticsMonthSummary{
			Month:        mStr,
			Label:        mStart.Format("Jan 2006"),
			Current:      current,
			Visitors:     month.visitors,
			Pageviews:    month.pageviews,
			Orders:       month.orders,
			Sales:        month.sales,
			DaysRecorded: month.days,
			DaysInPeriod: daysInPeriod,
			SampledDays:  month.sampledDays,
			AvgPerDay:    avgPerDay,
			ChangePct:    changePct,
		})
	}

	breakdowns := emptyBreakdowns()
	syncError := ""
	refreshDue := false
	if cfg.configured {
		cached := cachedAnalytics(cfg.key())
		if !cached.syncedAt.IsZero() {
			lastSaved = cached.syncedAt
		}
		breakdowns = cloneBreakdowns(cached.breakdowns)
		syncError = cached.syncError
		if syncError == "" {
			syncError = cached.breakdownError
		}
		refreshDue = analyticsRefreshDue(now, cached.lastAttemptAt) ||
			(cached.syncError == "" && analyticsRefreshDue(now, cached.breakdownAttemptAt))
	}
	syncedAt := ""
	if !lastSaved.IsZero() {
		syncedAt = lastSaved.UTC().Format(time.RFC3339)
	}
	enrichTopPages(ctx, breakdowns.TopPages)
	lowStock := 5
	if live, _, err := loadSettings(ctx); err == nil && live.LowStock > 0 {
		lowStock = live.LowStock
	}

	return analyticsReport{
		Configured:    cfg.configured,
		MissingConfig: cfg.missing,
		Source:        "cloudflare_rum",
		SourceLabel:   "Cloudflare Web Analytics (human visits, bot-filtered)",
		Timezone:      "Asia/Dhaka",
		SyncedAt:      syncedAt,
		RefreshDue:    refreshDue,
		Stale:         syncError != "",
		SyncError:     syncError,
		LowStock:      lowStock,
		Today:         dayAt(todayStr),
		Yesterday:     dayAt(yesterdayStr),
		Last7Days:     last7,
		Months:        months,
		Breakdowns:    breakdowns,
	}, nil
}

func adminAnalytics(w http.ResponseWriter, r *http.Request) {
	cfg := loadAnalyticsConfig(r)
	report, err := buildAnalyticsReport(r.Context(), analyticsNow(), cfg)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, report)
}

func adminSyncAnalytics(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("auto") != "1"
	syncCloudflareAnalytics(r.Context(), loadAnalyticsConfig(r), force)
	adminAnalytics(w, r)
}

func adminAnalyticsToday(w http.ResponseWriter, r *http.Request) {
	cfg := loadAnalyticsConfig(r)
	var result struct {
		Visitors  *int64     `json:"visitors"`
		UpdatedAt *time.Time `json:"updatedAt"`
		Sampled   bool       `json:"sampled"`
		Stale     bool       `json:"stale"`
	}
	if cfg.configured {
		result.Stale = !syncCloudflareTraffic(r.Context(), cfg, false)
	}
	day := analyticsDayStart(analyticsNow()).Format("2006-01-02")
	err := db.QueryRow(r.Context(), `
		SELECT visitors, updated_at, sample_rate > 1 FROM analytics_daily WHERE day=$1::date`, day).
		Scan(&result.Visitors, &result.UpdatedAt, &result.Sampled)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		oops(w, err)
		return
	}
	ok(w, result)
}
