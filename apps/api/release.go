package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

//go:embed migrations.sql
var migrationSQL string
var localPublishMu sync.Mutex
var buildsMu sync.RWMutex
var builds = map[string]struct {
	Payload json.RawMessage
	Key     string
	Until   time.Time
}{}

func loadBuilds(ctx context.Context) {
	rows, e := db.Query(ctx, `SELECT id,key_hash,payload,created_at+interval '1 day' FROM releases WHERE created_at>now()-interval '1 day'`)
	if e != nil {
		return
	}
	defer rows.Close()
	buildsMu.Lock()
	defer buildsMu.Unlock()
	clear(builds)
	for rows.Next() {
		var id, key string
		var payload json.RawMessage
		var until time.Time
		if rows.Scan(&id, &key, &payload, &until) == nil {
			builds[id] = struct {
				Payload json.RawMessage
				Key     string
				Until   time.Time
			}{payload, key, until}
		}
	}
}

var releaseVersion = func() string {
	if s := os.Getenv("RENDER_GIT_COMMIT"); s != "" {
		return s
	}
	if b, ok := debug.ReadBuildInfo(); ok {
		for _, s := range b.Settings {
			if s.Key == "vcs.revision" {
				return s.Value
			}
		}
	}
	return "development"
}()

type querier interface {
	Query(context.Context, string, ...any) (pgx.Rows, error)
}

func rowsFrom(ctx context.Context, q querier, sql string, args ...any) ([]json.RawMessage, error) {
	rows, e := q.Query(ctx, sql, args...)
	if e != nil {
		return nil, e
	}
	list, e := pgx.CollectRows(rows, pgx.RowTo[json.RawMessage])
	if list == nil {
		list = []json.RawMessage{}
	}
	return list, e
}
func migrate(ctx context.Context) error {
	return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(834925)`); e != nil {
			return e
		}
		if _, e := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations(version INT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`); e != nil {
			return e
		}
		for i, sql := range []string{schema, migrationSQL, catalogMigrationSQL} {
			sum := hashTok(sql)
			var old string
			e := tx.QueryRow(ctx, `SELECT checksum FROM schema_migrations WHERE version=$1`, i+1).Scan(&old)
			if e == nil {
				if old != sum {
					return fmt.Errorf("migration %d checksum changed; append a new migration", i+1)
				}
				continue
			}
			if !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
			if _, e = tx.Exec(ctx, sql); e != nil {
				return fmt.Errorf("migration %d failed: %w", i+1, e)
			}
			if _, e = tx.Exec(ctx, `INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)`, i+1, sum); e != nil {
				return e
			}
		}
		return nil
	})
}
func readyFile(w http.ResponseWriter, r *http.Request) {
	code := 200
	if stockSnap.Load() == nil || catalogSnap.Load() == nil || storefrontSnap.Load() == nil {
		code = 503
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]any{"ready": code == 200, "version": releaseVersion})
}

// Excludes transport/expected-total/Turnstile fields so a legitimate retry can refresh its challenge.
func orderFingerprint(v any) string {
	b, _ := json.Marshal(v)
	var m map[string]any
	json.Unmarshal(b, &m)
	for _, k := range []string{"Expected", "Turnstile", "turnstile", "Key"} {
		delete(m, k)
	}
	if items, ok := m["items"].([]any); ok {
		var in []item
		b, _ = json.Marshal(items)
		json.Unmarshal(b, &in)
		merged, _ := mergeItems(in)
		m["items"] = merged
	}
	b, _ = json.Marshal(m)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
func publishStatus(w http.ResponseWriter, r *http.Request) {
	_, _ = db.Exec(r.Context(), `UPDATE releases SET state='failed' WHERE state IN ('queued','running') AND created_at<now()-interval '1 day'`)
	var revision, published int64
	if e := db.QueryRow(r.Context(), `SELECT revision,published FROM publication_state WHERE id=1`).Scan(&revision, &published); e != nil {
		oops(w, e)
		return
	}
	var latest json.RawMessage
	_ = db.QueryRow(r.Context(), `SELECT jsonb_build_object('id',id,'state',state,'revision',revision,'commit',commit_sha) FROM releases ORDER BY created_at DESC LIMIT 1`).Scan(&latest)
	ok(w, map[string]any{"revision": revision, "published": published, "dirty": revision != published, "latest": latest})
}
func frozenRelease(ctx context.Context, editorial bool) (id, key string, err error) {
	id, key = token(16), token(32)
	err = pgx.BeginTxFunc(ctx, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead}, func(tx pgx.Tx) error {
		// Keep the frozen database inputs bounded without touching current/rollback releases.
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(834926)`); e != nil {
			return e
		}
		_, _ = tx.Exec(ctx, `DELETE FROM releases WHERE id NOT IN (SELECT id FROM releases ORDER BY created_at DESC LIMIT 10) AND id NOT IN (SELECT id FROM releases WHERE state='published' ORDER BY created_at DESC LIMIT 2) AND created_at<now()-interval '1 day'`)
		var rev int64
		if e := tx.QueryRow(ctx, `SELECT revision FROM publication_state WHERE id=1`).Scan(&rev); e != nil {
			return e
		}
		catalog, e := catalogFrom(ctx, tx)
		if e != nil {
			return e
		}
		store, e := storefrontFrom(ctx, tx)
		if e != nil {
			return e
		}
		if !editorial {
			var prior struct {
				Products []map[string]any `json:"products"`
				Store    map[string]any   `json:"store"`
			}
			var raw []byte
			if e := tx.QueryRow(ctx, `SELECT payload,revision FROM releases WHERE state='published' ORDER BY created_at DESC LIMIT 1`).Scan(&raw, &rev); e != nil {
				return userErr{409, "Publish the initial catalog in admin before releasing code"}
			}
			if e := json.Unmarshal(raw, &prior); e != nil {
				return e
			}
			var current []map[string]any
			json.Unmarshal(catalog, &current)
			byID := map[float64]map[string]any{}
			for _, p := range current {
				byID[p["id"].(float64)] = p
			}
			var kept []map[string]any
			for _, p := range prior.Products {
				if live, ok := byID[p["id"].(float64)]; ok {
					for _, k := range []string{"price", "regular", "inStock"} {
						p[k] = live[k]
					}
					kept = append(kept, p)
				}
			}
			catalog, _ = json.Marshal(kept)
			var currentStore map[string]any
			json.Unmarshal(store, &currentStore)
			prior.Store["live"] = currentStore["live"]
			store, _ = json.Marshal(prior.Store)
		}
		payload, _ := json.Marshal(map[string]any{"products": json.RawMessage(catalog), "store": json.RawMessage(store), "revision": rev})
		_, e = tx.Exec(ctx, `INSERT INTO releases(id,key_hash,revision,state,payload) VALUES($1,$2,$3,'queued',$4)`, id, hashTok(key), rev, string(payload))
		return e
	})
	if err == nil {
		loadBuilds(ctx)
	}
	return
}
func startPublish(w http.ResponseWriter, r *http.Request) {
	dir := os.Getenv("DEV_BUILD_DIR")
	repo, tok := os.Getenv("GITHUB_REPO"), os.Getenv("GITHUB_TOKEN")
	if dir == "" && (repo == "" || tok == "") {
		fail(w, 501, "publishing is not configured")
		return
	}
	id, key, e := frozenRelease(r.Context(), true)
	if e != nil {
		oops(w, e)
		return
	}
	if dir != "" {
		go func() {
			localPublishMu.Lock()
			defer localPublishMu.Unlock()
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			var newer bool
			if e := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM releases WHERE state='published' AND created_at>(SELECT created_at FROM releases WHERE id=$1))`, id).Scan(&newer); e != nil {
				_ = finishRelease(ctx, id, key, "failed", "local")
				return
			}
			if newer {
				_ = finishRelease(ctx, id, key, "published", "local")
				return
			}
			_, _ = db.Exec(ctx, `UPDATE releases SET state='running' WHERE id=$1`, id)
			out := os.Getenv("BUILD_OUTPUT")
			if out == "" {
				out = filepath.Join(dir, "dist")
			}
			stage, e := os.MkdirTemp(filepath.Dir(out), "lb-publish-")
			if e != nil {
				_ = finishRelease(ctx, id, key, "failed", "local")
				return
			}
			defer os.RemoveAll(stage)
			args := []string{filepath.Join(dir, "node_modules", "astro", "astro.js"), "build", "--outDir", stage}
			cmd := exec.CommandContext(ctx, "node", args...)
			cmd.Dir = dir
			cmd.Env = append(cmd.Environ(), "CATALOG_URL=http://127.0.0.1:"+os.Getenv("PORT")+"/api/catalog", "BUILD_ID="+id, "BUILD_KEY="+key, "BUILD_ENV=local")
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			state := "published"
			if e := cmd.Run(); e != nil {
				log.Printf("local publication failed: %v: %s", e, clip(stderr.String(), 2000))
				state = "failed"
			} else {
				backup, e := os.MkdirTemp(filepath.Dir(out), "lb-previous-")
				if e != nil {
					state = "failed"
				} else {
					os.Remove(backup)
					if e = os.Rename(out, backup); e != nil {
						state = "failed"
					} else if e = os.Rename(stage, out); e != nil {
						_ = os.Rename(backup, out)
						state = "failed"
					}
					if state == "published" {
						os.RemoveAll(backup)
					}
				}
			}
			_ = finishRelease(ctx, id, key, state, "local")
		}()
	} else {
		body, _ := json.Marshal(map[string]any{"event_type": "publish", "client_payload": map[string]string{"id": id, "key": key}})
		req, _ := http.NewRequestWithContext(r.Context(), "POST", "https://api.github.com/repos/"+repo+"/dispatches", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Accept", "application/vnd.github+json")
		res, e := httpClient.Do(req)
		if e != nil {
			_ = finishRelease(context.Background(), id, key, "failed", "")
			fail(w, 502, "publish dispatch failed")
			return
		}
		res.Body.Close()
		if res.StatusCode >= 300 {
			_ = finishRelease(context.Background(), id, key, "failed", "")
			fail(w, 502, "GitHub refused publication; check its token")
			return
		}
	}
	ok(w, map[string]string{"id": id, "message": "Publication queued. Saved edits remain pending until deployment is confirmed."})
}
func buildFile(w http.ResponseWriter, r *http.Request) {
	buildsMu.RLock()
	b, found := builds[chi.URLParam(r, "id")]
	buildsMu.RUnlock()
	if !found || time.Now().After(b.Until) || !same(b.Key, hashTok(r.Header.Get("X-Build-Key"))) {
		fail(w, 404, "build not found")
		return
	}
	ok(w, b.Payload)
}
func prepareRelease(w http.ResponseWriter, r *http.Request) {
	want := os.Getenv("PUBLISH_TOKEN")
	if len(want) < 32 || !same(want, r.Header.Get("X-Publish-Token")) {
		fail(w, 401, "publish token required")
		return
	}
	id, key, e := frozenRelease(r.Context(), false)
	if e != nil {
		oops(w, e)
		return
	}
	ok(w, map[string]string{"id": id, "key": key})
}

func finishRelease(ctx context.Context, id, key, state, commit string) error {
	if state != "running" && state != "published" && state != "failed" {
		return userErr{400, "invalid publication state"}
	}
	return pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(834926)`); e != nil {
			return e
		}
		var revision int64
		var old string
		if e := tx.QueryRow(ctx, `SELECT revision,state FROM releases WHERE id=$1 AND key_hash=$2 AND created_at>now()-interval '1 day' FOR UPDATE`, id, hashTok(key)).Scan(&revision, &old); e != nil {
			return userErr{404, "build not found"}
		}
		if old == "published" || old == "failed" || old == "superseded" {
			return nil
		}
		if state == "published" {
			var newer bool
			if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM releases WHERE state='published' AND created_at>(SELECT created_at FROM releases WHERE id=$1))`, id).Scan(&newer); e != nil {
				return e
			}
			if newer {
				state = "superseded"
			} else {
				if _, e := tx.Exec(ctx, `UPDATE publication_state SET published=$1 WHERE id=1`, revision); e != nil {
					return e
				}
			}
		}
		_, e := tx.Exec(ctx, `UPDATE releases SET state=$2,commit_sha=$3 WHERE id=$1`, id, state, clip(commit, 80))
		return e
	})
}
func buildResult(w http.ResponseWriter, r *http.Request) {
	var in struct{ State, Commit string }
	if !read(w, r, &in) {
		return
	}
	if e := finishRelease(r.Context(), chi.URLParam(r, "id"), r.Header.Get("X-Build-Key"), in.State, in.Commit); e != nil {
		oops(w, e)
		return
	}
	done(w)
}
func queueImages(ctx context.Context, urls []string) {
	for _, u := range urls {
		_, _ = db.Exec(ctx, `INSERT INTO retired_images(url) VALUES($1) ON CONFLICT DO NOTHING`, u)
	}
}

// Keep the interface compile-checked against a real transaction.
var _ interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
} = (pgx.Tx)(nil)
