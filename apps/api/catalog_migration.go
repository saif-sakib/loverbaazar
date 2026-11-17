package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations-v3.sql
var catalogMigrationSQL string

type importRecord struct {
	Kind     string         `json:"kind"`
	Key      string         `json:"key"`
	Expected string         `json:"expected,omitempty"`
	Hash     string         `json:"hash,omitempty"`
	Value    map[string]any `json:"value"`
}
type importPlan struct {
	TargetHash   string            `json:"target_hash"`
	Version      int               `json:"version"`
	Origin       string            `json:"origin"`
	SettingsHash string            `json:"settings_hash"`
	SourceDigest string            `json:"source_manifest_sha256"`
	Records      []importRecord    `json:"records"`
	Conflicts    []json.RawMessage `json:"conflicts"`
}
type importApproval struct {
	PlanHash   string    `json:"plan_sha256"`
	Owner      string    `json:"owner"`
	ApprovedAt time.Time `json:"approved_at"`
}

func recordHash(value map[string]any) string { b, _ := json.Marshal(value); return hashTok(string(b)) }

func currentImportRecord(ctx context.Context, tx pgx.Tx, kind, key string) (map[string]any, error) {
	var raw []byte
	var e error
	if kind == "product" {
		e = tx.QueryRow(ctx, `SELECT data || jsonb_build_object('id',id,'slug',slug,'price',price,'regular',regular,'stock',stock,'active',active,'inStock',stock>0) FROM products WHERE id=$1`, key).Scan(&raw)
	} else {
		e = tx.QueryRow(ctx, `SELECT data FROM content WHERE kind=$1 AND slug=$2`, kind, key).Scan(&raw)
	}
	if errors.Is(e, pgx.ErrNoRows) {
		return nil, nil
	}
	if e != nil {
		return nil, e
	}
	var value map[string]any
	e = json.Unmarshal(raw, &value)
	return value, e
}
func readImportRecords(ctx context.Context, tx pgx.Tx) ([]importRecord, error) {
	rows, e := tx.Query(ctx, `SELECT 'product',id::text,data||jsonb_build_object('id',id,'slug',slug,'price',price,'regular',regular,'stock',stock,'active',active,'inStock',stock>0) FROM products UNION ALL SELECT kind,slug,data FROM content ORDER BY 1,2`)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	records := []importRecord{}
	for rows.Next() {
		var r importRecord
		var raw []byte
		if e = rows.Scan(&r.Kind, &r.Key, &raw); e != nil {
			return nil, e
		}
		if e = json.Unmarshal(raw, &r.Value); e != nil {
			return nil, e
		}
		r.Hash = recordHash(r.Value)
		records = append(records, r)
	}
	return records, rows.Err()
}
func importRecordsHash(records []importRecord) string {
	b, _ := json.Marshal(records)
	return hashTok(string(b))
}
func migrationSnapshot(ctx context.Context) (map[string]any, error) {
	result := map[string]any{"version": 1}
	e := pgx.BeginTxFunc(ctx, db, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly}, func(tx pgx.Tx) error {
		var phase string
		var orders int
		if e := tx.QueryRow(ctx, `SELECT phase FROM catalog_migration_gate WHERE id=1`).Scan(&phase); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM orders`).Scan(&orders); e != nil {
			return e
		}
		records, e := readImportRecords(ctx, tx)
		if e != nil {
			return e
		}
		result["target_hash"] = importRecordsHash(records)
		rows, e := tx.Query(ctx, `SELECT kind||':'||key FROM catalog_imported ORDER BY 1`)
		if e != nil {
			return e
		}
		imported := []string{}
		for rows.Next() {
			var k string
			if e = rows.Scan(&k); e != nil {
				rows.Close()
				return e
			}
			imported = append(imported, k)
		}
		e = rows.Err()
		rows.Close()
		live, site, settingsErr := settingsFrom(ctx, tx)
		if settingsErr != nil {
			return settingsErr
		}
		settings := map[string]any{"live": live, "site": site}
		result["settings"], result["settings_hash"] = settings, recordHash(settings)
		result["records"], result["imported"], result["phase"], result["orders"] = records, imported, phase, orders
		return e
	})
	return result, e
}
func validImportRecord(r *importRecord) error {
	v := r.Value
	if v == nil {
		return errors.New("missing record value")
	}
	if r.Kind == "product" {
		for _, key := range []string{"cats", "tags", "images", "attrs"} {
			if _, ok := v[key].([]any); !ok {
				return fmt.Errorf("%s list required", key)
			}
		}
		id, e := strconv.ParseInt(r.Key, 10, 64)
		if e != nil || id < 1 {
			return errors.New("invalid source product ID")
		}
		if n, ok := wholeNumber(v["id"]); !ok || n != id {
			return errors.New("product ID mismatch")
		}
		for _, key := range []string{"price", "regular", "stock"} {
			max := maxMoney
			if key == "stock" {
				max = maxStock
			}
			if _, ok := integer(v[key], 0, max); !ok {
				return fmt.Errorf("invalid %s", key)
			}
		}
		if v["regular"].(float64) < v["price"].(float64) {
			return errors.New("regular price below price")
		}
		s, ok := v["slug"].(string)
		if !ok || !safeSlug(s, false) {
			return errors.New("invalid product slug")
		}
		if name, ok := v["name"].(string); !ok || strings.TrimSpace(name) == "" {
			return errors.New("missing product name")
		}
		if _, ok := v["active"].(bool); !ok {
			return errors.New("explicit active state required")
		}
		return checkProduct(v)
	}
	validKind := r.Kind == "cat" || r.Kind == "tag" || r.Kind == "page" || r.Kind == "post"
	if !validKind || !safeSlug(r.Key, false) || v["slug"] != r.Key {
		return errors.New("invalid content identity")
	}
	if slicesReserved(r.Key) && (r.Kind == "page" || r.Kind == "post") {
		return errors.New("reserved page path")
	}
	if r.Kind == "cat" {
		s, ok := v["path"].(string)
		if !ok || !safeSlug(s, true) {
			return errors.New("invalid category path")
		}
	}
	if body, ok := v["html"].(string); ok {
		v["html"] = cleanHTML(body)
	}
	return nil
}
func slicesReserved(s string) bool {
	for _, v := range reservedSlugs {
		if s == v {
			return true
		}
	}
	return s == "home" || s == "sample-page"
}
func applyCatalogPlan(ctx context.Context, raw []byte, approval importApproval) error {
	if os.Getenv("MIGRATION_MAINTENANCE") != "1" || (os.Getenv("APP_ENV") != "local" && os.Getenv("APP_ENV") != "preview") {
		return errors.New("catalog writes require local/preview maintenance mode; stop the API first")
	}
	if approval.PlanHash != hashTok(string(raw)) || strings.TrimSpace(approval.Owner) == "" || approval.ApprovedAt.IsZero() {
		return errors.New("missing or mismatched owner approval")
	}
	var plan importPlan
	if e := json.Unmarshal(raw, &plan); e != nil {
		return e
	}
	origin, e := url.Parse(plan.Origin)
	if e != nil || origin.Scheme != "https" || origin.Hostname() == "" || origin.User != nil || plan.Version != 1 || len(plan.Conflicts) > 0 || len(plan.SourceDigest) != 64 {
		return errors.New("invalid or conflicted migration plan")
	}
	seen := map[string]bool{}
	for i := range plan.Records {
		r := &plan.Records[i]
		key := r.Kind + ":" + r.Key
		if seen[key] {
			return errors.New("duplicate migration identity")
		}
		seen[key] = true
		if e = validImportRecord(r); e != nil {
			return e
		}
	}
	e = pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if _, e := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(834926)`); e != nil {
			return e
		}
		// Match checkout's order-before-product lock order; only tx is used inside this transaction.
		if _, e := tx.Exec(ctx, `LOCK TABLE orders IN EXCLUSIVE MODE; LOCK TABLE products,content,settings IN SHARE ROW EXCLUSIVE MODE`); e != nil {
			return e
		}
		var phase string
		var orders int
		if e := tx.QueryRow(ctx, `SELECT phase FROM catalog_migration_gate WHERE id=1 FOR UPDATE`).Scan(&phase); e != nil {
			return e
		}
		if e := tx.QueryRow(ctx, `SELECT count(*) FROM orders`).Scan(&orders); e != nil {
			return e
		}
		if phase != "prelaunch" || orders != 0 {
			return errors.New("migration closed: target has accepted new-store orders")
		}
		live, site, settingsErr := settingsFrom(ctx, tx)
		if settingsErr != nil {
			return settingsErr
		}
		if plan.SettingsHash == "" || plan.SettingsHash != recordHash(map[string]any{"live": live, "site": site}) {
			return errors.New("shop policies/settings changed or were not captured; regenerate approval")
		}
		currentRecords, recordsErr := readImportRecords(ctx, tx)
		if recordsErr != nil {
			return recordsErr
		}
		// An already applied identical batch remains a no-op, while later batches bind the full target.
		var applied bool
		if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM catalog_import_batches WHERE digest=$1)`, approval.PlanHash).Scan(&applied); e != nil {
			return e
		}
		if applied {
			return nil
		}
		if plan.TargetHash == "" || plan.TargetHash != importRecordsHash(currentRecords) {
			return errors.New("target catalog changed after review; regenerate the full plan")
		}
		// Validate every baseline before making any changes.
		for _, r := range plan.Records {
			current, e := currentImportRecord(ctx, tx, r.Kind, r.Key)
			if e != nil {
				return e
			}
			if current == nil {
				var previous bool
				if e = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM catalog_imported WHERE kind=$1 AND key=$2)`, r.Kind, r.Key).Scan(&previous); e != nil {
					return e
				}
				if previous || r.Expected != "absent" {
					return errors.New("deleted or changed target record; regenerate the plan")
				}
			} else if r.Expected != recordHash(current) {
				return errors.New("target changed after the dry run; regenerate the plan")
			}
		}
		for _, r := range plan.Records {
			b, _ := json.Marshal(r.Value)
			if r.Kind == "product" {
				var current int64
				currentValue, e := currentImportRecord(ctx, tx, r.Kind, r.Key)
				if e != nil {
					return e
				}
				if currentValue != nil {
					var valid bool
					current, valid = integer(currentValue["stock"], 0, 1<<31-1)
					if !valid {
						return errors.New("invalid target stock quantity")
					}
				}
				stock, _ := wholeNumber(r.Value["stock"])
				if currentValue == nil {
					_, e = tx.Exec(ctx, `INSERT INTO products(id,slug,price,regular,stock,active,data) VALUES($1,$2,$3,$4,$5,$6,$7)`, r.Key, r.Value["slug"], r.Value["price"], r.Value["regular"], stock, r.Value["active"], string(b))
				} else {
					_, e = tx.Exec(ctx, `UPDATE products SET slug=$2,price=$3,regular=$4,stock=stock+$5,active=$6,data=$7 WHERE id=$1`, r.Key, r.Value["slug"], r.Value["price"], r.Value["regular"], stock-current, r.Value["active"], string(b))
				}
				if e != nil {
					return e
				}
			} else if _, e := tx.Exec(ctx, `INSERT INTO content(kind,slug,data) VALUES($1,$2,$3) ON CONFLICT(kind,slug) DO UPDATE SET data=excluded.data`, r.Kind, r.Key, string(b)); e != nil {
				return e
			}
			if _, e := tx.Exec(ctx, `INSERT INTO catalog_imported VALUES($1,$2,$3) ON CONFLICT(kind,key) DO UPDATE SET origin=excluded.origin`, r.Kind, r.Key, plan.Origin); e != nil {
				return e
			}
		}
		for _, r := range plan.Records {
			if r.Kind != "product" {
				continue
			}
			for _, pair := range [][2]string{{"cats", "cat"}, {"tags", "tag"}} {
				for _, key := range r.Value[pair[0]].([]any) {
					var exists bool
					if e := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM content WHERE kind=$1 AND slug=$2)`, pair[1], key).Scan(&exists); e != nil {
						return e
					}
					if !exists {
						return errors.New("unresolved category/tag relationship")
					}
				}
			}
		}
		if _, e := tx.Exec(ctx, `SELECT setval('product_ids',GREATEST(10000000,coalesce((SELECT max(id)+1 FROM products),10000000),(SELECT last_value+CASE WHEN is_called THEN 1 ELSE 0 END FROM product_ids)),false)`); e != nil {
			return e
		}
		_, e := tx.Exec(ctx, `INSERT INTO catalog_import_batches(digest,source_digest,approved_by) VALUES($1,$2,$3)`, approval.PlanHash, plan.SourceDigest, approval.Owner)
		return e
	})
	if e == nil {
		refresh()
	}
	return e
}
func migrationFile(path string) (string, error) {
	p, e := filepath.Abs(path)
	if e != nil {
		return "", e
	}
	for _, part := range strings.Split(filepath.ToSlash(p), "/") {
		if part == "public" || part == "public_html" || part == "dist" || part == "htdocs" {
			return "", errors.New("choose a private path outside web roots")
		}
	}
	cwd, _ := os.Getwd()
	for d := cwd; ; d = filepath.Dir(d) {
		if _, e := os.Stat(filepath.Join(d, "AGENTS.md")); e == nil {
			if p == d || strings.HasPrefix(p, d+string(os.PathSeparator)) {
				return "", errors.New("keep migration artifacts outside the public repository")
			}
			break
		}
		if filepath.Dir(d) == d {
			break
		}
	}
	return p, nil
}
func catalogCommand(ctx context.Context, args []string) error {
	if e := migrate(ctx); e != nil {
		return e
	}
	switch args[0] {
	case "catalog-snapshot":
		if len(args) != 2 {
			return errors.New("usage: catalog-snapshot PRIVATE_FILE")
		}
		p, e := migrationFile(args[1])
		if e != nil {
			return e
		}
		snapshot, e := migrationSnapshot(ctx)
		if e != nil {
			return e
		}
		b, e := json.Marshal(snapshot)
		if e != nil {
			return e
		}
		f, e := os.OpenFile(p, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		defer f.Close()
		if e = f.Chmod(0600); e != nil {
			return e
		}
		_, e = f.Write(b)
		return e
	case "catalog-apply":
		if len(args) != 3 {
			return errors.New("usage: catalog-apply PRIVATE_PLAN PRIVATE_APPROVAL")
		}
		p, e := migrationFile(args[1])
		if e != nil {
			return e
		}
		a, e := migrationFile(args[2])
		if e != nil {
			return e
		}
		raw, e := os.ReadFile(p)
		if e != nil {
			return e
		}
		approvalBytes, e := os.ReadFile(a)
		if e != nil {
			return e
		}
		var approval importApproval
		if e = json.Unmarshal(approvalBytes, &approval); e != nil {
			return e
		}
		return applyCatalogPlan(ctx, raw, approval)
	default:
		return errors.New("unknown catalog command")
	}
}

func fixtureDatabaseAllowed(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil {
		return false
	}
	if u.Scheme != "postgres" && u.Scheme != "postgresql" {
		return false
	}
	if u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1" {
		return false
	}
	if u.Path != "/lb" && u.Path != "/lb_test" {
		return false
	}
	for k := range u.Query() {
		if k != "sslmode" {
			return false
		}
	}
	return true
}
