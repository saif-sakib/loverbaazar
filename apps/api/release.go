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
	"regexp"
	"runtime/debug"
	"strings"
	"sync"
	"time"
)

//go:embed migrations.sql
var migrationSQL string

//go:embed migrations-v8.sql
var publishSQL string
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
		for i, sql := range []string{schema, migrationSQL, catalogMigrationSQL, notificationSQL, productPhotoSQL, orderUpdateMailSQL, analyticsSQL, publishSQL} {
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

// liveProductFields reach shoppers through /api/stock, so changing them alone never needs a rebuild.
var liveProductFields = []string{"price", "regular", "inStock"}

// contentHash fingerprints exactly what Publish changes: the frozen editorial catalog and storefront,
// without live prices, stock or live settings. Equal hashes mean a rebuild would show nothing new.
func contentHash(products, store []byte) (string, error) {
	var list []map[string]any
	var site map[string]any
	if e := json.Unmarshal(products, &list); e != nil {
		return "", e
	}
	if e := json.Unmarshal(store, &site); e != nil {
		return "", e
	}
	if list == nil {
		list = []map[string]any{}
	}
	for _, p := range list {
		for _, k := range liveProductFields {
			delete(p, k)
		}
	}
	delete(site, "live")
	b, e := json.Marshal([]any{list, site})
	if e != nil {
		return "", e
	}
	return hashTok(string(b)), nil
}

func payloadHash(payload []byte) (string, error) {
	var p struct {
		Products json.RawMessage `json:"products"`
		Store    json.RawMessage `json:"store"`
	}
	if e := json.Unmarshal(payload, &p); e != nil {
		return "", e
	}
	return contentHash(p.Products, p.Store)
}

type rowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// latestRelease returns the release among states that is (or will be, once in-flight work settles)
// shown to customers. Ordering matches finishArtifact's supersede rule.
func latestRelease(ctx context.Context, q rowQuerier, states ...string) (id, state, hash string, err error) {
	var payload []byte
	err = q.QueryRow(ctx, `SELECT id,state,content_hash,CASE WHEN content_hash='' THEN payload END FROM releases
		WHERE state=ANY($1) ORDER BY revision DESC,created_at DESC LIMIT 1`, states).Scan(&id, &state, &hash, &payload)
	if err == nil && hash == "" {
		hash, err = payloadHash(payload)
	}
	return
}

// publicationDirtyFrom compares saved editorial content with the content customers currently see inside one snapshot.
func publicationDirtyFrom(ctx context.Context, tx pgx.Tx) (bool, error) {
	catalog, e := catalogFrom(ctx, tx)
	if e != nil {
		return false, e
	}
	store, e := storefrontFrom(ctx, tx)
	if e != nil {
		return false, e
	}
	current, e := contentHash(catalog, store)
	if e != nil {
		return false, e
	}
	_, _, live, e := latestRelease(ctx, tx, "published")
	if errors.Is(e, pgx.ErrNoRows) {
		return true, nil
	}
	return e == nil && live != current, e
}

func publicationDirty(ctx context.Context) (bool, error) {
	var dirty bool
	e := pgx.BeginTxFunc(ctx, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var err error
		dirty, err = publicationDirtyFrom(ctx, tx)
		return err
	})
	return dirty, e
}

const staleReleaseFailure = "GitHub did not confirm this publication within 45 minutes. Check the Publish store workflow in GitHub Actions."

func expireStaleReleases(ctx context.Context) {
	_, _ = db.Exec(ctx, `UPDATE releases SET state='failed',failure=$1,finished_at=now() WHERE state IN ('queued','running') AND created_at<now()-interval '45 minutes'`, staleReleaseFailure)
}

const releaseStatusJSON = `jsonb_build_object('id',id,'state',state,'revision',revision,'commit',commit_sha,'artifact',artifact_sha,'error',failure,'run',run_url,'created',created_at,'finished',finished_at)`

func publishStatus(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	expireStaleReleases(ctx)
	var revision, published int64
	var dirty bool
	var latest json.RawMessage
	var history []json.RawMessage
	if e := pgx.BeginTxFunc(ctx, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		if e := tx.QueryRow(ctx, `SELECT revision,published FROM publication_state WHERE id=1`).Scan(&revision, &published); e != nil {
			return e
		}
		var e error
		if dirty, e = publicationDirtyFrom(ctx, tx); e != nil {
			return e
		}
		if e = tx.QueryRow(ctx, `SELECT `+releaseStatusJSON+` FROM releases
			ORDER BY CASE WHEN state IN ('queued','running') THEN 0 ELSE 1 END, revision DESC, created_at DESC LIMIT 1`).Scan(&latest); e != nil && !errors.Is(e, pgx.ErrNoRows) {
			return e
		}
		history, e = rowsFrom(ctx, tx, `SELECT `+releaseStatusJSON+` FROM releases ORDER BY created_at DESC LIMIT 5`)
		return e
	}); e != nil {
		oops(w, e)
		return
	}
	ok(w, map[string]any{"revision": revision, "published": published, "dirty": dirty, "latest": latest, "history": history})
}

// sameRelease reports that an existing live or in-flight release already carries the requested content.
type sameRelease struct{ id, state string }

func (s sameRelease) Error() string { return "release content unchanged" }

func frozenRelease(ctx context.Context, editorial bool) (id, key string, err error) {
	return freezeRelease(ctx, editorial, false)
}

// freezeRelease captures one consistent release. With onlyChanged it returns sameRelease instead of
// queueing a build whose content matches what is live or already being published.
func freezeRelease(ctx context.Context, editorial, onlyChanged bool) (id, key string, err error) {
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
		hash, e := contentHash(catalog, store)
		if e != nil {
			return e
		}
		if onlyChanged {
			targetID, targetState, targetHash, e := latestRelease(ctx, tx, "queued", "running", "published")
			if e == nil && targetHash == hash {
				return sameRelease{targetID, targetState}
			}
			if e != nil && !errors.Is(e, pgx.ErrNoRows) {
				return e
			}
		}
		payload, _ := json.Marshal(map[string]any{"products": json.RawMessage(catalog), "store": json.RawMessage(store), "revision": rev})
		_, e = tx.Exec(ctx, `INSERT INTO releases(id,key_hash,revision,state,payload,content_hash) VALUES($1,$2,$3,'queued',$4,$5)`, id, hashTok(key), rev, string(payload), hash)
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
	expireStaleReleases(r.Context())
	id, key, e := freezeRelease(r.Context(), true, true)
	var existing sameRelease
	if errors.As(e, &existing) {
		if existing.state == "published" {
			ok(w, map[string]string{"state": "unchanged", "message": "Nothing new to publish. The website already shows your saved edits."})
		} else {
			ok(w, map[string]string{"id": existing.id, "state": existing.state, "message": "These changes are already being published."})
		}
		return
	}
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
			failLocal := func(msg string) { _ = finishFailure(ctx, id, key, "local", msg) }
			var rev int64
			if e := db.QueryRow(ctx, `SELECT revision FROM releases WHERE id=$1`, id).Scan(&rev); e != nil {
				failLocal("Could not read the release from the database.")
				return
			}
			var newer bool
			if e := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM releases WHERE state='published' AND (revision>$2 OR (revision=$2 AND created_at>(SELECT created_at FROM releases WHERE id=$1))))`, id, rev).Scan(&newer); e != nil {
				failLocal("Could not check for newer releases.")
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
				failLocal("Could not create the build folder.")
				return
			}
			defer os.RemoveAll(stage)
			args := []string{filepath.Join(dir, "node_modules", ".bin", "astro"), "build", "--outDir", stage}
			cmd := exec.CommandContext(ctx, "node", args...)
			cmd.Dir = dir
			cmd.Env = append(cmd.Environ(), "CATALOG_URL=http://127.0.0.1:"+os.Getenv("PORT")+"/api/catalog", "BUILD_ID="+id, "BUILD_KEY="+key, "BUILD_ENV=local")
			var stderr bytes.Buffer
			cmd.Stderr = &stderr
			failure := ""
			if e := cmd.Run(); e != nil {
				log.Printf("local publication failed: %v: %s", e, clip(stderr.String(), 2000))
				failure = "The website build failed: " + lastLine(stderr.String())
			} else {
				backup, e := os.MkdirTemp(filepath.Dir(out), "lb-previous-")
				if e != nil {
					failure = "Could not prepare the previous-build backup."
				} else {
					os.Remove(backup)
					if e = os.Rename(out, backup); e != nil {
						failure = "Could not move the previous build aside."
					} else if e = os.Rename(stage, out); e != nil {
						_ = os.Rename(backup, out)
						failure = "Could not install the new build; the previous build was restored."
					}
					if failure == "" {
						os.RemoveAll(backup)
					}
				}
			}
			if failure != "" {
				failLocal(failure)
			} else {
				_ = finishRelease(ctx, id, key, "published", "local")
			}
		}()
	} else {
		body, _ := json.Marshal(map[string]any{"event_type": "publish", "client_payload": map[string]string{"id": id, "key": key}})
		req, _ := http.NewRequestWithContext(r.Context(), "POST", "https://api.github.com/repos/"+repo+"/dispatches", strings.NewReader(string(body)))
		req.Header.Set("Authorization", "Bearer "+tok)
		req.Header.Set("Accept", "application/vnd.github+json")
		res, e := httpClient.Do(req)
		if e != nil {
			_ = finishFailure(context.Background(), id, key, "", "Could not reach GitHub to start the publish job.")
			fail(w, 502, "publish dispatch failed")
			return
		}
		res.Body.Close()
		if res.StatusCode >= 300 {
			_ = finishFailure(context.Background(), id, key, "", fmt.Sprintf("GitHub refused to start the publish job (HTTP %d). Check GITHUB_TOKEN and GITHUB_REPO on Render.", res.StatusCode))
			fail(w, 502, "GitHub refused publication; check its token")
			return
		}
	}
	ok(w, map[string]string{"id": id, "state": "queued", "message": "Publish started. Your edits go live when the build finishes."})
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
	return finishArtifact(ctx, id, key, state, commit, "", "", "")
}

func finishFailure(ctx context.Context, id, key, commit, failure string) error {
	return finishArtifact(ctx, id, key, "failed", commit, "", failure, "")
}

// lastLine keeps the most useful end of build output for the admin, without paths or secrets in bulk.
func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return clip(l, 200)
		}
	}
	return "no error output"
}

var runURL = regexp.MustCompile(`^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/actions/runs/[0-9]+(/attempts/[0-9]+)?$`)

var artifactSHA = regexp.MustCompile(`^[a-f0-9]{64}$`)

func finishArtifact(ctx context.Context, id, key, state, commit, artifact, failure, run string) error {
	if artifact != "" && (state != "published" || !artifactSHA.MatchString(artifact)) {
		return userErr{400, "invalid artifact fingerprint"}
	}
	if state != "running" && state != "published" && state != "failed" {
		return userErr{400, "invalid publication state"}
	}
	if !runURL.MatchString(run) {
		run = ""
	}
	if state != "failed" {
		failure = ""
	} else if failure = clip(strings.TrimSpace(failure), 300); failure == "" {
		failure = "The publish job failed. Open the build log for details."
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
			if run != "" {
				_, _ = tx.Exec(ctx, `UPDATE releases SET run_url=$2 WHERE id=$1 AND run_url=''`, id, run)
			}
			if state == "running" {
				return userErr{409, "release is already terminal"}
			}
			return nil
		}
		if state == "published" || state == "running" {
			var newer bool
			if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM releases WHERE state='published' AND (revision>$2 OR (revision=$2 AND created_at>(SELECT created_at FROM releases WHERE id=$1))))`, id, revision).Scan(&newer); e != nil {
				return e
			}
			if newer {
				if state == "running" {
					return userErr{409, "release superseded by a newer publication"}
				}
				state = "superseded"
			} else if state == "published" {
				if _, e := tx.Exec(ctx, `UPDATE publication_state SET published=$1 WHERE id=1`, revision); e != nil {
					return e
				}
				if _, e := tx.Exec(ctx, `UPDATE releases SET state='superseded' WHERE id<>$1 AND state='queued' AND (revision<$2 OR (revision=$2 AND created_at<(SELECT created_at FROM releases WHERE id=$1)))`, id, revision); e != nil {
					return e
				}
			}
		}
		_, e := tx.Exec(ctx, `UPDATE releases SET state=$2,commit_sha=$3,artifact_sha=$4,failure=$5,
			run_url=CASE WHEN $6::text<>'' THEN $6::text ELSE run_url END,
			finished_at=CASE WHEN $2::text='running' THEN NULL ELSE now() END WHERE id=$1`, id, state, clip(commit, 80), artifact, failure, run)
		return e
	})
}
func buildResult(w http.ResponseWriter, r *http.Request) {
	var in struct{ State, Commit, Artifact, Error, Run string }
	if !read(w, r, &in) {
		return
	}
	if e := finishArtifact(r.Context(), chi.URLParam(r, "id"), r.Header.Get("X-Build-Key"), in.State, in.Commit, in.Artifact, in.Error, in.Run); e != nil {
		oops(w, e)
		return
	}
	var state string
	if e := db.QueryRow(r.Context(), `SELECT state FROM releases WHERE id=$1`, chi.URLParam(r, "id")).Scan(&state); e != nil {
		oops(w, e)
		return
	}
	ok(w, map[string]any{"ok": true, "state": state})
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
