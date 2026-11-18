package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func fixturePhoto(t *testing.T, red uint8) []byte {
	t.Helper()
	pixel := image.NewRGBA(image.Rect(0, 0, 2, 2))
	pixel.Set(0, 0, color.RGBA{R: red, A: 255})
	var body bytes.Buffer
	if err := png.Encode(&body, pixel); err != nil {
		t.Fatal(err)
	}
	return body.Bytes()
}

func submitPhotos(t *testing.T, method, path, saveKey string, p M, files ...[]byte) (int, M) {
	t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	data, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	form.WriteField("product", string(data))
	form.WriteField("saveKey", saveKey)
	for _, file := range files {
		part, err := form.CreateFormFile("photos", "fixture.png")
		if err != nil {
			t.Fatal(err)
		}
		part.Write(file)
	}
	form.Close()
	req, _ := http.NewRequest(method, api.URL+"/api/admin/products"+path, &body)
	req.Header.Set("X-Admin-Token", adminKey)
	req.Header.Set("Content-Type", form.FormDataContentType())
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out M
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return res.StatusCode, out
}

func fixturePhotoProduct(slug string) M {
	return M{"name": "Photo fixture", "slug": slug, "price": 1500, "regular": 1500, "stock": 4,
		"images": []M{{"src": photoRef(0), "thumb": photoRef(0), "alt": "Example appliance"}}}
}

func readProductPhoto(t *testing.T, id int64) string {
	t.Helper()
	var address string
	if err := db.QueryRow(bg, `SELECT data#>>'{images,0,src}' FROM products WHERE id=$1`, id).Scan(&address); err != nil {
		t.Fatal(err)
	}
	return address
}

func sweepFixturePhotos(t *testing.T) {
	t.Helper()
	expect(t, "photo cleanup", "POST", "/api/admin/image/cleanup", M{}, true, 200)
}

func TestProductPhotosSaveOnceAndKeepPublishedFiles(t *testing.T) {
	reset(t)
	dir := t.TempDir()
	t.Setenv("LOCAL_UPLOADS", dir)
	p := fixturePhotoProduct("photo-lifecycle")
	p["desc"] = `<p><img src="/__product-photo/1" alt="See detail"></p>`
	first, detail := fixturePhoto(t, 80), fixturePhoto(t, 140)
	key := strings.Repeat("a", 32)
	code, out := submitPhotos(t, "POST", "", key, p, first, detail)
	if code != 200 {
		t.Fatalf("create: %d %v", code, out)
	}
	id := int64(out["id"].(float64))
	old := readProductPhoto(t, id)
	var description string
	if err := db.QueryRow(bg, `SELECT data->>'desc' FROM products WHERE id=$1`, id).Scan(&description); err != nil || strings.Contains(description, photoRefPrefix) || !strings.Contains(description, "/uploads/") {
		t.Fatal("description photo was not replaced", err)
	}
	code, again := submitPhotos(t, "POST", "", key, p, first, detail)
	if code != 200 || again["id"] != out["id"] {
		t.Fatalf("same save did not recover result: %d %v", code, again)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Fatal("retry uploaded another copy")
	}
	release, buildKey, err := frozenRelease(bg, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := finishRelease(bg, release, buildKey, "published", "fixture"); err != nil {
		t.Fatal(err)
	}

	p = fixturePhotoProduct("photo-lifecycle")
	p["stockDelta"] = 1
	delete(p, "stock")
	update := strings.Repeat("b", 32)
	path := "/" + strconv.FormatInt(id, 10)
	for range 2 {
		if code, out = submitPhotos(t, "PUT", path, update, p, fixturePhoto(t, 240)); code != 200 {
			t.Fatalf("update: %d %v", code, out)
		}
	}
	if code, _ = submitPhotos(t, "PUT", path, update, fixturePhotoProduct("changed-details"), fixturePhoto(t, 240)); code != 409 {
		t.Fatalf("reused save key changed product: %d", code)
	}
	var stock int
	db.QueryRow(bg, `SELECT stock FROM products WHERE id=$1`, id).Scan(&stock)
	if stock != 5 {
		t.Fatal("repeated update changed stock twice")
	}
	current := readProductPhoto(t, id)
	expect(t, "delete product", "DELETE", "/api/admin/products"+path, nil, true, 200)
	if _, err := db.Exec(bg, `UPDATE retired_images SET retired_at=now()-interval '31 days'`); err != nil {
		t.Fatal(err)
	}
	sweepFixturePhotos(t)
	if _, err := os.Stat(filepath.Join(dir, localUploadFile(current))); !os.IsNotExist(err) {
		t.Fatal("never-published replacement still exists")
	}
	if _, err := os.Stat(filepath.Join(dir, localUploadFile(old))); err != nil {
		t.Fatal("published rollback photo removed", err)
	}
}

func TestCloudinaryPhotoSaveRecoversPartialUpload(t *testing.T) {
	reset(t)
	t.Setenv("LOCAL_UPLOADS", "")
	t.Setenv("CLOUDINARY_CLOUD", "fixture")
	t.Setenv("CLOUDINARY_KEY", "fixture-key")
	t.Setenv("CLOUDINARY_SECRET", "fixture-secret")
	client := httpClient
	t.Cleanup(func() { httpClient = client })
	stored := make(map[string]string)
	uploads, destroys := 0, 0
	httpClient = &http.Client{Transport: fakeSite(func(req *http.Request) *http.Response {
		resp := func(code int, out any) *http.Response {
			j, _ := json.Marshal(out)
			return &http.Response{StatusCode: code, Body: io.NopCloser(bytes.NewReader(j))}
		}
		if strings.HasSuffix(req.URL.Path, "/image/upload") {
			uploads++
			if err := req.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
				return resp(400, nil)
			}
			id := req.FormValue("public_id")
			if req.FormValue("overwrite") != "false" || !regexp.MustCompile(`^loverbaazar/products/other/photo-rollback-[0-9]+$`).MatchString(id) {
				t.Error("unexpected upload identity or overwrite flag")
			}
			stored[id] = strings.TrimPrefix(req.FormValue("context"), "lb_photo_save=")
			if uploads == 2 {
				return resp(503, nil) // provider wrote the photo but did not confirm it
			}
			return resp(200, M{"secure_url": "https://res.cloudinary.com/fixture/image/upload/v1/" + id + ".png", "public_id": id})
		}
		if strings.Contains(req.URL.Path, "/resources/image/upload/") {
			_, id, _ := strings.Cut(req.URL.Path, "/resources/image/upload/")
			attempt, exists := stored[id]
			if !exists {
				return resp(404, nil)
			}
			return resp(200, M{"public_id": id, "context": M{"custom": M{"lb_photo_save": attempt}}})
		}
		if strings.HasSuffix(req.URL.Path, "/image/destroy") {
			destroys++
			req.ParseForm()
			delete(stored, req.FormValue("public_id"))
			return resp(200, M{"result": "ok"})
		}
		t.Error("unrecognized Cloudinary request")
		return resp(500, nil)
	})}
	p := fixturePhotoProduct("photo-rollback")
	p["desc"] = `<img src="/__product-photo/1">`
	key := strings.Repeat("c", 32)
	first := fixturePhoto(t, 60)
	second := fixturePhoto(t, 200)
	if code, _ := submitPhotos(t, "POST", "", key, p, first, []byte("bad file")); code != 400 || uploads != 0 {
		t.Fatal("invalid files triggered an upload", code, uploads)
	}
	if code, _ := submitPhotos(t, "POST", "", key, p, first, second); code != 502 {
		t.Fatal("provider failure should fail the save", code)
	}
	var products int
	db.QueryRow(bg, `SELECT count(*) FROM products WHERE slug='photo-rollback'`).Scan(&products)
	if products != 0 || destroys != 1 || len(stored) != 1 {
		t.Fatal("failed save persisted product or missed confirmed-photo cleanup", products, destroys, len(stored))
	}
	_, _ = db.Exec(bg, `UPDATE product_photo_uploads SET check_after=now() WHERE check_after IS NOT NULL`)
	sweepFixturePhotos(t)
	if destroys != 2 || len(stored) != 0 {
		t.Fatal("uncertain upload was not recovered")
	}
	if code, out := submitPhotos(t, "POST", "", key, p, first, second); code != 200 {
		t.Fatalf("retry after Cloudinary failure: %d %v", code, out)
	}
}
