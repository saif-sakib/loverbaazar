package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

func migrationReset(t *testing.T) {
	reset(t)
	t.Setenv("APP_ENV", "local")
	t.Setenv("MIGRATION_MAINTENANCE", "1")
	if _, e := db.Exec(bg, `TRUNCATE catalog_imported,catalog_import_batches; UPDATE catalog_migration_gate SET phase='prelaunch' WHERE id=1`); e != nil {
		t.Fatal(e)
	}
}
func migrationRecord(id float64) importRecord {
	return importRecord{Kind: "product", Key: "301", Expected: "absent", Value: map[string]any{"id": id, "slug": "হাঁড়ি", "name": "Fixture cookware", "sku": "SKU-FIXTURE", "price": float64(1250), "regular": float64(1500), "stock": float64(3), "active": true, "inStock": true, "cats": []any{}, "tags": []any{}, "images": []any{map[string]any{"src": "https://res.cloudinary.com/fixture/image/upload/fixture.png"}}, "attrs": []any{}}}
}
func approvedPlan(t *testing.T, records []importRecord) ([]byte, importApproval) {
	t.Helper()
	snapshot, err := migrationSnapshot(bg)
	if err != nil {
		t.Fatal(err)
	}
	raw, e := json.Marshal(importPlan{TargetHash: snapshot["target_hash"].(string), SettingsHash: snapshot["settings_hash"].(string), Version: 1, Origin: "https://shop.example", SourceDigest: strings.Repeat("a", 64), Records: records})
	if e != nil {
		t.Fatal(e)
	}
	return raw, importApproval{PlanHash: hashTok(string(raw)), Owner: "Fixture owner", ApprovedAt: time.Now()}
}
func TestCatalogMigrationRerunCompareAndSwapAndTombstones(t *testing.T) {
	migrationReset(t)
	record := migrationRecord(301)
	if _, e := db.Exec(bg, `SELECT setval('product_ids',10000123,true)`); e != nil {
		t.Fatal(e)
	}
	raw, approval := approvedPlan(t, []importRecord{record})
	if e := applyCatalogPlan(bg, raw, approval); e != nil {
		t.Fatal(e)
	}
	if e := applyCatalogPlan(bg, raw, approval); e != nil {
		t.Fatalf("same batch rerun: %v", e)
	}
	var nextID int64
	if e := db.QueryRow(bg, `SELECT nextval('product_ids')`).Scan(&nextID); e != nil {
		t.Fatal(e)
	}
	if nextID < 10000124 {
		t.Fatal("migration rewound product identities")
	}
	if stockOf(t, 301) != 3 {
		t.Fatal("rerun changed stock")
	}
	snapshot, e := migrationSnapshot(bg)
	if e != nil {
		t.Fatal(e)
	}
	for _, r := range snapshot["records"].([]importRecord) {
		if r.Kind == "product" && r.Key == "301" {
			record.Expected = r.Hash
		}
	}
	record.Value["stock"] = float64(5)
	updated, updateApproval := approvedPlan(t, []importRecord{record})
	db.Exec(bg, `UPDATE products SET stock=stock-1 WHERE id=301`)
	if e := applyCatalogPlan(bg, updated, updateApproval); e == nil {
		t.Fatal("stale plan overwrote a stock change")
	}
	if stockOf(t, 301) != 2 {
		t.Fatal("stock changed on failed plan")
	}
	db.Exec(bg, `DELETE FROM products WHERE id=301`)
	record.Expected = "absent"
	record.Value["name"] = "Do not resurrect"
	deleted, deletedApproval := approvedPlan(t, []importRecord{record})
	if e := applyCatalogPlan(bg, deleted, deletedApproval); e == nil {
		t.Fatal("resurrected removed imported record")
	}
}
func TestCatalogMigrationClosesPermanentlyOnFirstOrder(t *testing.T) {
	migrationReset(t)
	code, _ := call(t, nil, "POST", "/api/checkout", order(nil, M{"id": 1, "qty": 1}), false)
	if code != 200 {
		t.Fatal(code)
	}
	raw, approval := approvedPlan(t, []importRecord{migrationRecord(301)})
	if e := applyCatalogPlan(bg, raw, approval); e == nil {
		t.Fatal("post-sale migration was accepted")
	}
	db.Exec(bg, `TRUNCATE orders CASCADE`)
	if e := applyCatalogPlan(bg, raw, approval); e == nil {
		t.Fatal("deleting orders reopened migration")
	}
}
func TestCatalogMigrationAllOrNothingAndApproval(t *testing.T) {
	migrationReset(t)
	first := migrationRecord(301)
	second := migrationRecord(302)
	second.Key = "302" // Same slug makes the second insert fail.
	raw, approval := approvedPlan(t, []importRecord{first, second})
	if e := applyCatalogPlan(bg, raw, approval); e == nil {
		t.Fatal("duplicate slug accepted")
	}
	var exists bool
	db.QueryRow(bg, `SELECT EXISTS(SELECT 1 FROM products WHERE id=301)`).Scan(&exists)
	if exists {
		t.Fatal("failed batch left partial product")
	}
	approval.PlanHash = "wrong"
	if e := applyCatalogPlan(bg, raw, approval); e == nil {
		t.Fatal("changed plan accepted")
	}
	t.Setenv("APP_ENV", "production")
	raw, approval = approvedPlan(t, []importRecord{first})
	if e := applyCatalogPlan(bg, raw, approval); e == nil {
		t.Fatal("production migration accepted")
	}
}
func TestCatalogMigrationRejectsMissingLists(t *testing.T) {
	migrationReset(t)
	r := migrationRecord(301)
	delete(r.Value, "cats")
	raw, approval := approvedPlan(t, []importRecord{r})
	if e := applyCatalogPlan(context.Background(), raw, approval); e == nil {
		t.Fatal("invalid product accepted")
	}
}
func TestSeedDoesNotInventInventoryFromAvailability(t *testing.T) {
	migrationReset(t)
	path := t.TempDir() + "/products.json"
	data := `[{"id":401,"slug":"unknown","name":"Unknown","price":100,"regular":100,"inStock":true,"cats":[],"tags":[],"images":[],"attrs":[]},{"id":402,"slug":"known","name":"Known","price":200,"regular":200,"stock":7,"cats":[],"tags":[],"images":[],"attrs":[]}]`
	if e := os.WriteFile(path, []byte(data), 0600); e != nil {
		t.Fatal(e)
	}
	if e := seed(bg, path, ""); e != nil {
		t.Fatal(e)
	}
	var active bool
	db.QueryRow(bg, `SELECT active FROM products WHERE id=401`).Scan(&active)
	if stockOf(t, 401) != 0 || active {
		t.Fatal("availability became sellable invented stock")
	}
	if stockOf(t, 402) != 7 {
		t.Fatal("explicit quantity was lost")
	}
}

func TestQuarantinedProductsCannotBeActivatedFromAdmin(t *testing.T) {
	migrationReset(t)
	db.Exec(bg, `UPDATE products SET active=false,data=data||'{"migrationBlocked":true,"migrationIssues":["unsupported-options"]}'::jsonb WHERE id=1`)
	if code, _ := call(t, nil, "PATCH", "/api/admin/products/1", M{"active": true}, true); code != 409 {
		t.Fatalf("quarantined activation: %d", code)
	}
	if code, _ := call(t, nil, "PUT", "/api/admin/products/1", M{"name": "Fixture", "slug": "p1", "price": 1000, "regular": 1000, "migrationBlocked": true, "active": true}, true); code != 400 {
		t.Fatalf("quarantined full save: %d", code)
	}
	for _, raw := range []string{"postgres://user:pass@remote.example/lb", "postgres://user@127.0.0.1/lb?host=remote.example"} {
		if fixtureDatabaseAllowed(raw) {
			t.Fatal("remote fixture seeding allowed")
		}
	}
}

func TestCatalogMigrationBindsShopPolicySettings(t *testing.T) {
	migrationReset(t)
	raw, approval := approvedPlan(t, []importRecord{migrationRecord(301)})
	db.Exec(bg, `UPDATE settings SET data=data||'{"minOrder":900}'::jsonb WHERE key='live'`)
	if e := applyCatalogPlan(bg, raw, approval); e == nil {
		t.Fatal("commercial settings changed after review but migration accepted")
	}
}

func TestCatalogMigrationUsesActualLegacyQuantityForRelativeCorrection(t *testing.T) {
	migrationReset(t)
	if _, e := db.Exec(bg, `UPDATE products SET stock=1500000000 WHERE id=1`); e != nil {
		t.Fatal(e)
	}
	snapshot, e := migrationSnapshot(bg)
	if e != nil {
		t.Fatal(e)
	}
	record := migrationRecord(1)
	record.Key = "1"
	record.Value["stock"] = float64(5)
	for _, r := range snapshot["records"].([]importRecord) {
		if r.Kind == "product" && r.Key == "1" {
			record.Expected = r.Hash
		}
	}
	raw, approval := approvedPlan(t, []importRecord{record})
	if e := applyCatalogPlan(bg, raw, approval); e != nil {
		t.Fatal(e)
	}
	if stockOf(t, 1) != 5 {
		t.Fatal("relative correction did not use the real current quantity")
	}
}
