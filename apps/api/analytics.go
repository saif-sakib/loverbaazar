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

	analyticsSyncMu  sync.Mutex
	analyticsCacheMu sync.RWMutex
	analyticsCache   = newEmptyAnalyticsCache()
)

type analyticsCacheState struct {
	cfgKey        string
	syncedAt      time.Time
	lastAttemptAt time.Time
	breakdowns    analyticsBreakdowns
	syncError     string
}

func newEmptyAnalyticsCache() analyticsCacheState {
	return analyticsCacheState{breakdowns: emptyBreakdowns()}
}

func resetAnalyticsCache() {
	analyticsCacheMu.Lock()
	analyticsCache = newEmptyAnalyticsCache()
	analyticsCacheMu.Unlock()
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
	Stale         bool                    `json:"stale"`
	SyncError     string                  `json:"syncError"`
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
        limit: 10
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
		s := strings.ToLower(clip(strings.TrimSpace(g.Dimensions.RefererHost), 120))
		if s == "" {
			s = "Direct / bookmark"
		}
		c := refMap[s]
		c.visits += roundNonNeg(g.Sum.Visits)
		c.views += roundNonNeg(g.Count)
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

func syncCloudflareAnalytics(ctx context.Context, cfg analyticsConfig, force bool) {
	if !cfg.configured {
		return
	}
	analyticsSyncMu.Lock()
	defer analyticsSyncMu.Unlock()

	now := analyticsNow()
	cfgKey := cfg.key()
	analyticsCacheMu.RLock()
	cached := analyticsCache
	analyticsCacheMu.RUnlock()
	if !force && cached.cfgKey == cfgKey && !cached.lastAttemptAt.IsZero() && now.Sub(cached.lastAttemptAt) < analyticsCacheTTL {
		return
	}

	syncCtx, cancel := context.WithTimeout(ctx, analyticsSyncTimeout)
	defer cancel()

	nowDhaka := now.In(dhakaTZ)
	todayStart := time.Date(nowDhaka.Year(), nowDhaka.Month(), nowDhaka.Day(), 0, 0, 0, 0, dhakaTZ)
	todayStr := todayStart.Format("2006-01-02")
	recentCutoffStr := todayStart.AddDate(0, 0, -2).Format("2006-01-02")
	end := now.UTC().Add(time.Minute)

	hourly, orderedDays, err := fetchCloudflareHourlyRUM(syncCtx, cfg, todayStart, end)
	if err != nil {
		log.Printf("analytics_sync event=cloudflare_hourly_failed reason=%s", err)
		analyticsCacheMu.Lock()
		if analyticsCache.cfgKey != cfgKey {
			analyticsCache = newEmptyAnalyticsCache()
			analyticsCache.cfgKey = cfgKey
		}
		analyticsCache.lastAttemptAt = now
		analyticsCache.syncError = analyticsErrorFallback
		analyticsCacheMu.Unlock()
		return
	}

	if err := pgx.BeginFunc(syncCtx, db, func(tx pgx.Tx) error {
		for _, dayStr := range orderedDays {
			agg := hourly[dayStr]
			finalized := dayStr < todayStr
			if _, err := tx.Exec(syncCtx, `
				INSERT INTO analytics_daily(day, visitors, pageviews, sample_rate, source, finalized, updated_at)
				VALUES($1::date, $2, $3, $4, 'cloudflare_rum', $5, now())
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
				dayStr, agg.visitors, agg.pageviews, agg.sampleRate, finalized, recentCutoffStr); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		log.Printf("analytics_sync event=db_upsert_failed type=%T", err)
		analyticsCacheMu.Lock()
		if analyticsCache.cfgKey != cfgKey {
			analyticsCache = newEmptyAnalyticsCache()
			analyticsCache.cfgKey = cfgKey
		}
		analyticsCache.lastAttemptAt = now
		analyticsCache.syncError = "Visitor history could not be saved right now. Showing previously archived totals."
		analyticsCacheMu.Unlock()
		return
	}

	bd, bdErr := fetchCloudflareBreakdowns(syncCtx, cfg, todayStart, end)
	if bdErr != nil {
		log.Printf("analytics_sync event=cloudflare_breakdowns_failed")
	}

	backfillCloudflare30Days(syncCtx, cfg, todayStart)

	analyticsCacheMu.Lock()
	if analyticsCache.cfgKey != cfgKey {
		analyticsCache = newEmptyAnalyticsCache()
		analyticsCache.cfgKey = cfgKey
	}
	analyticsCache.syncedAt = now.UTC()
	analyticsCache.lastAttemptAt = now
	analyticsCache.syncError = ""
	if bdErr == nil {
		analyticsCache.breakdowns = cloneBreakdowns(bd)
	}
	analyticsCacheMu.Unlock()
}

func buildAnalyticsReport(ctx context.Context, now time.Time, cfg analyticsConfig) (analyticsReport, error) {
	nowDhaka := now.In(dhakaTZ)
	today := time.Date(nowDhaka.Year(), nowDhaka.Month(), nowDhaka.Day(), 0, 0, 0, 0, dhakaTZ)
	todayStr := today.Format("2006-01-02")
	yesterdayStr := today.AddDate(0, 0, -1).Format("2006-01-02")
	start14 := today.AddDate(0, 0, -13)
	start14Str := start14.Format("2006-01-02")
	start7Str := today.AddDate(0, 0, -6).Format("2006-01-02")
	prev7EndStr := today.AddDate(0, 0, -7).Format("2006-01-02")

	curMonthStart := time.Date(nowDhaka.Year(), nowDhaka.Month(), 1, 0, 0, 0, 0, dhakaTZ)
	monthStart12 := curMonthStart.AddDate(0, -11, 0)
	monthStart12Str := monthStart12.Format("2006-01-02")

	type visitorDayRow struct {
		visitors, pageviews int64
		sampleRate          float64
		finalized           bool
	}
	visitorDays := map[string]visitorDayRow{}
	rows, err := db.Query(ctx, `SELECT to_char(day, 'YYYY-MM-DD'), visitors, pageviews, sample_rate, finalized FROM analytics_daily WHERE day BETWEEN $1::date AND $2::date ORDER BY day`, start14Str, todayStr)
	if err != nil {
		return analyticsReport{}, err
	}
	for rows.Next() {
		var d string
		var r visitorDayRow
		if err := rows.Scan(&d, &r.visitors, &r.pageviews, &r.sampleRate, &r.finalized); err != nil {
			rows.Close()
			return analyticsReport{}, err
		}
		visitorDays[d] = r
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return analyticsReport{}, err
	}
	rows.Close()

	type orderTotals struct {
		orders, sales int64
	}
	orderDays := map[string]orderTotals{}
	rows, err = db.Query(ctx, `
		SELECT to_char((created_at AT TIME ZONE 'Asia/Dhaka')::date, 'YYYY-MM-DD') AS d,
		       count(*) FILTER (WHERE status NOT IN `+outStatuses+`),
		       coalesce(sum(total) FILTER (WHERE status NOT IN `+outStatuses+`), 0)
		FROM orders
		WHERE (created_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN $1::date AND $2::date
		GROUP BY d`, start14Str, todayStr)
	if err != nil {
		return analyticsReport{}, err
	}
	for rows.Next() {
		var d string
		var o orderTotals
		if err := rows.Scan(&d, &o.orders, &o.sales); err != nil {
			rows.Close()
			return analyticsReport{}, err
		}
		orderDays[d] = o
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return analyticsReport{}, err
	}
	rows.Close()

	dayAt := func(d string) analyticsDaySummary {
		out := analyticsDaySummary{Day: d, SampleRate: 1}
		if v, ok := visitorDays[d]; ok {
			out.Visitors = v.visitors
			out.Pageviews = v.pageviews
			out.HasVisitors = true
			out.SampleRate = v.sampleRate
			out.Finalized = v.finalized
		}
		if o, ok := orderDays[d]; ok {
			out.Orders = o.orders
			out.Sales = o.sales
		}
		return out
	}

	last7 := analytics7DaySummary{Days: make([]analyticsDaySummary, 0, 7)}
	for offset := -13; offset <= 0; offset++ {
		d := today.AddDate(0, 0, offset).Format("2006-01-02")
		s := dayAt(d)
		if d <= prev7EndStr {
			last7.PrevOrders += s.Orders
			last7.PrevSales += s.Sales
			if s.HasVisitors {
				last7.PrevVisitors += s.Visitors
				last7.PrevPageviews += s.Pageviews
				last7.PrevDaysRecorded++
			}
		} else if d >= start7Str {
			last7.Orders += s.Orders
			last7.Sales += s.Sales
			if s.HasVisitors {
				last7.Visitors += s.Visitors
				last7.Pageviews += s.Pageviews
				last7.DaysRecorded++
			}
			last7.Days = append(last7.Days, s)
		}
	}

	type visitorMonthAgg struct {
		visitors, pageviews int64
		days, sampledDays   int
	}
	visitorMonths := map[string]visitorMonthAgg{}
	rows, err = db.Query(ctx, `
		SELECT to_char(date_trunc('month', day), 'YYYY-MM') AS m,
		       coalesce(sum(visitors), 0),
		       coalesce(sum(pageviews), 0),
		       count(*),
		       count(*) FILTER (WHERE sample_rate > 1)
		FROM analytics_daily
		WHERE day BETWEEN $1::date AND $2::date
		GROUP BY m`, monthStart12Str, todayStr)
	if err != nil {
		return analyticsReport{}, err
	}
	for rows.Next() {
		var m string
		var a visitorMonthAgg
		if err := rows.Scan(&m, &a.visitors, &a.pageviews, &a.days, &a.sampledDays); err != nil {
			rows.Close()
			return analyticsReport{}, err
		}
		visitorMonths[m] = a
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return analyticsReport{}, err
	}
	rows.Close()

	orderMonths := map[string]orderTotals{}
	rows, err = db.Query(ctx, `
		SELECT to_char(date_trunc('month', (created_at AT TIME ZONE 'Asia/Dhaka')::date), 'YYYY-MM') AS m,
		       count(*) FILTER (WHERE status NOT IN `+outStatuses+`),
		       coalesce(sum(total) FILTER (WHERE status NOT IN `+outStatuses+`), 0)
		FROM orders
		WHERE (created_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN $1::date AND $2::date
		GROUP BY m`, monthStart12Str, todayStr)
	if err != nil {
		return analyticsReport{}, err
	}
	for rows.Next() {
		var m string
		var o orderTotals
		if err := rows.Scan(&m, &o.orders, &o.sales); err != nil {
			rows.Close()
			return analyticsReport{}, err
		}
		orderMonths[m] = o
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return analyticsReport{}, err
	}
	rows.Close()

	months := make([]analyticsMonthSummary, 0, 12)
	for i := 0; i < 12; i++ {
		mStart := monthStart12.AddDate(0, i, 0)
		mStr := mStart.Format("2006-01")
		current := i == 11
		daysInPeriod := mStart.AddDate(0, 1, -1).Day()
		if current {
			daysInPeriod = nowDhaka.Day()
		}
		vm := visitorMonths[mStr]
		om := orderMonths[mStr]
		var avgPerDay *float64
		if vm.days > 0 {
			avg := math.Round((float64(vm.visitors)/float64(vm.days))*10) / 10
			avgPerDay = &avg
		}
		var changePct *float64
		if i > 0 && vm.days > 0 {
			prev := months[i-1]
			if prev.DaysRecorded > 0 && prev.Visitors > 0 {
				pct := math.Round(((float64(vm.visitors)-float64(prev.Visitors))/float64(prev.Visitors))*1000) / 10
				changePct = &pct
			}
		}
		months = append(months, analyticsMonthSummary{
			Month:        mStr,
			Label:        mStart.Format("Jan 2006"),
			Current:      current,
			Visitors:     vm.visitors,
			Pageviews:    vm.pageviews,
			Orders:       om.orders,
			Sales:        om.sales,
			DaysRecorded: vm.days,
			DaysInPeriod: daysInPeriod,
			SampledDays:  vm.sampledDays,
			AvgPerDay:    avgPerDay,
			ChangePct:    changePct,
		})
	}

	analyticsCacheMu.RLock()
	cached := analyticsCache
	analyticsCacheMu.RUnlock()

	syncedAt := ""
	breakdowns := emptyBreakdowns()
	syncError := ""
	stale := false
	if cfg.configured && cached.cfgKey == cfg.key() {
		if !cached.syncedAt.IsZero() {
			syncedAt = cached.syncedAt.Format(time.RFC3339)
		}
		breakdowns = cloneBreakdowns(cached.breakdowns)
		syncError = cached.syncError
		stale = syncError != ""
	}

	return analyticsReport{
		Configured:    cfg.configured,
		MissingConfig: cfg.missing,
		Source:        "cloudflare_rum",
		SourceLabel:   "Cloudflare Web Analytics (human visits, bot-filtered)",
		Timezone:      "Asia/Dhaka",
		SyncedAt:      syncedAt,
		Stale:         stale,
		SyncError:     syncError,
		Today:         dayAt(todayStr),
		Yesterday:     dayAt(yesterdayStr),
		Last7Days:     last7,
		Months:        months,
		Breakdowns:    breakdowns,
	}, nil
}

func adminAnalytics(w http.ResponseWriter, r *http.Request) {
	cfg := loadAnalyticsConfig(r)
	if cfg.configured {
		syncCloudflareAnalytics(r.Context(), cfg, false)
	}
	report, err := buildAnalyticsReport(r.Context(), analyticsNow(), cfg)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, report)
}

func adminSyncAnalytics(w http.ResponseWriter, r *http.Request) {
	cfg := loadAnalyticsConfig(r)
	if cfg.configured {
		syncCloudflareAnalytics(r.Context(), cfg, true)
	}
	report, err := buildAnalyticsReport(r.Context(), analyticsNow(), cfg)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, report)
}
