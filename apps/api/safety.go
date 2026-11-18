package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"golang.org/x/net/html"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strings"
)

const maxMoney int64 = 1_000_000_000 // whole taka; 1,000 maximum pieces still fit safely in BIGINT
const maxStock int64 = 1_000_000

func safeTestDatabase(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil {
		return false
	}
	for k := range u.Query() {
		if k != "sslmode" {
			return false
		}
	}
	return (u.Scheme == "postgres" || u.Scheme == "postgresql") && (u.Hostname() == "127.0.0.1" || u.Hostname() == "localhost" || u.Hostname() == "::1") && u.Path == "/lb_test" && u.Query().Get("host") == "" && u.Query().Get("service") == ""
}
func safeSlug(s string, path bool) bool {
	d, e := url.PathUnescape(s)
	if e != nil || d == "" || len(d) > 240 {
		return false
	}
	for _, p := range strings.Split(d, "/") {
		if p == "" || p == "." || p == ".." || !slugRe.MatchString(p) || strings.Contains(p, "%") {
			return false
		}
	}
	return path || !strings.Contains(d, "/")
}
func integer(v any, min, max int64) (int64, bool) {
	var f float64
	switch n := v.(type) {
	case float64:
		f = n
	case json.Number:
		var e error
		f, e = n.Float64()
		if e != nil {
			return 0, false
		}
	default:
		return 0, false
	}
	if math.IsNaN(f) || math.IsInf(f, 0) || f < float64(min) || f > float64(max) || math.Trunc(f) != f {
		return 0, false
	}
	return int64(f), true
}
func safeURL(s string) bool {
	if s == "" {
		return true
	}
	u, e := url.Parse(s)
	if e != nil || u.User != nil {
		return false
	}
	return (u.Scheme == "https" || u.Scheme == "http") && u.Host != "" || u.Scheme == "" && u.Host == "" && strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//") && !strings.Contains(s, "\\")
}

// Parse HTML with the HTML5 parser, then allow only inert editorial markup.
func cleanHTML(raw string) string {
	nodes, e := html.ParseFragment(strings.NewReader(raw), nil)
	if e != nil {
		return ""
	}
	allowed := map[string]bool{}
	for _, s := range strings.Fields("p br strong b em i u s h2 h3 h4 ul ol li blockquote table thead tbody tr th td a img figure figcaption hr div span") {
		allowed[s] = true
	}
	var walk func(*html.Node)
	walk = func(n *html.Node) {
		for c := n.FirstChild; c != nil; {
			next := c.NextSibling
			if c.Type == html.ElementNode && !allowed[c.Data] && c.Data != "html" && c.Data != "head" && c.Data != "body" {
				n.RemoveChild(c)
			} else {
				var attrs []html.Attribute
				for _, a := range c.Attr {
					if a.Key == "href" && safeLink(a.Val) || a.Key == "src" && safeURL(a.Val) || a.Key == "alt" || a.Key == "title" {
						attrs = append(attrs, a)
					}
				}
				c.Attr = attrs
				walk(c)
			}
			c = next
		}
	}
	root := &html.Node{Type: html.DocumentNode}
	for _, n := range nodes {
		root.AppendChild(n)
	}
	walk(root)
	var out bytes.Buffer
	var render func(*html.Node)
	render = func(n *html.Node) {
		if n.Type == html.DocumentNode || n.Data == "html" || n.Data == "body" || n.Data == "head" {
			for c := n.FirstChild; c != nil; c = c.NextSibling {
				render(c)
			}
		} else {
			html.Render(&out, n)
		}
	}
	render(root)
	return out.String()
}
func requestGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "GET" && r.Method != "HEAD" {
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				fail(w, 403, "cross-site request refused")
				return
			}
			if origin := r.Header.Get("Origin"); origin != "" {
				u, e := url.Parse(origin)
				if e != nil || !strings.EqualFold(u.Host, requestHost(r)) {
					fail(w, 403, "cross-site request refused")
					return
				}
			}
			contentType := strings.ToLower(r.Header.Get("Content-Type"))
			photoSave := strings.HasPrefix(contentType, "multipart/form-data;") &&
				(r.Method == http.MethodPost && r.URL.Path == "/api/admin/products" ||
					r.Method == http.MethodPut && strings.HasPrefix(r.URL.Path, "/api/admin/products/"))
			if !photoSave && r.URL.Path != "/api/admin/image" && r.ContentLength != 0 && !strings.HasPrefix(contentType, "application/json") {
				fail(w, 415, "use application/json")
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
func decodeJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
	d.UseNumber()
	if e := d.Decode(v); e != nil {
		fail(w, 400, "invalid request")
		return false
	}
	if e := d.Decode(new(any)); e != io.EOF {
		fail(w, 400, "send one JSON value")
		return false
	}
	return true
}
func checkProduct(p map[string]any) error {
	if p["migrationBlocked"] == true && p["active"] != false {
		return fmt.Errorf("product is quarantined; resolve the migration review before activating it")
	}
	for _, k := range []string{"cats", "tags", "images", "attrs"} {
		if v, exists := p[k]; exists {
			if _, ok := v.([]any); !ok {
				return fmt.Errorf("%s must be a list", k)
			}
		}
	}

	if attrs, ok := p["attrs"].([]any); ok {
		for _, a := range attrs {
			m, ok := a.(map[string]any)
			if !ok {
				return fmt.Errorf("invalid attribute")
			}
			name, ok := m["name"].(string)
			values, list := m["values"].([]any)
			if !ok || name == "" || !list || len(values) > 100 {
				return fmt.Errorf("invalid attribute values")
			}
			for _, v := range values {
				if _, ok := v.(string); !ok {
					return fmt.Errorf("invalid attribute value")
				}
			}
		}
	}

	for _, k := range []string{"cats", "tags"} {
		if v, ok := p[k].([]any); ok {
			for _, s := range v {
				t, ok := s.(string)
				if !ok || !safeSlug(t, false) {
					return fmt.Errorf("invalid %s", k)
				}
			}
		}
	}
	if v, ok := p["images"].([]any); ok {
		for _, v := range v {
			im, ok := v.(map[string]any)
			if !ok {
				return fmt.Errorf("invalid image")
			}
			for _, k := range []string{"src", "thumb"} {
				if s, ok := im[k].(string); ok && !safeURL(s) {
					return fmt.Errorf("invalid image URL")
				}
			}
		}
	}
	if d, ok := p["desc"].(string); ok {
		p["desc"] = cleanHTML(d)
	}
	return nil
}

func requestHost(r *http.Request) string {
	if h := r.Header.Get("X-Shop-Host"); h != "" && r.Header.Get("X-Origin-Secret") != "" {
		return h
	}
	return r.Host
}

func checkRuntime() error {
	mode := os.Getenv("APP_ENV")
	if mode == "" {
		mode = "production"
	}
	if mode != "local" && mode != "preview" && mode != "production" {
		return fmt.Errorf("invalid APP_ENV")
	}
	if dev {
		if mode != "local" {
			return fmt.Errorf("DEV requires APP_ENV=local")
		}
		return nil
	}
	if mode == "local" || os.Getenv("LOCAL_UPLOADS") != "" || os.Getenv("DEV_BUILD_DIR") != "" {
		return fmt.Errorf("local storage/build settings require local DEV")
	}
	if mode == "production" && (os.Getenv("TURNSTILE_SECRET") == "" || os.Getenv("TURNSTILE_SITE") == "") {
		return fmt.Errorf("production requires TURNSTILE_SITE and TURNSTILE_SECRET")
	}
	return nil
}

func validateURLs(v any) bool {
	switch x := v.(type) {
	case map[string]any:
		for k, v := range x {
			if s, ok := v.(string); ok {
				switch k {
				case "logo", "src", "thumb", "image", "link", "facebook", "youtube":
					if !safeURL(s) {
						return false
					}
				}
			}
			if !validateURLs(v) {
				return false
			}
		}
	case []any:
		for _, v := range x {
			if !validateURLs(v) {
				return false
			}
		}
	}
	return true
}

func safeLink(s string) bool {
	if safeURL(s) || strings.HasPrefix(s, "#") {
		return true
	}
	u, e := url.Parse(s)
	return e == nil && (u.Scheme == "tel" || u.Scheme == "mailto") && !strings.ContainsAny(s, "\r\n")
}
