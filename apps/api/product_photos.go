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
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

//go:embed migrations-v5.sql
var productPhotoSQL string

const (
	maxProductPhotos = 6
	maxPhotoBytes    = 5 << 20
	photoRefPrefix   = "/__product-photo/"
	localPhotoStore  = "local"
)

var (
	cloudNamePattern = regexp.MustCompile(`^[a-z0-9_-]+$`)
	photoKeyPattern  = regexp.MustCompile(`^[a-f0-9]{32}$`)
	photoStemJunk    = regexp.MustCompile(`[^a-z0-9-]+`)
	photoRefPattern  = regexp.MustCompile(`(?:src|href)="(/__product-photo/[0-9]+)"`)
	photoSweep       sync.Mutex
	photoSweepBusy   = userErr{409, "photo cleanup is already running. Try again shortly."}
)

type productPhoto struct {
	bytes []byte
	ext   string
}

func photoExtension(data []byte) string {
	return map[string]string{"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}[http.DetectContentType(data)]
}

func readProductSave(w http.ResponseWriter, r *http.Request) (map[string]any, []productPhoto, string, bool) {
	var product map[string]any
	format, _, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if format != "multipart/form-data" {
		valid := read(w, r, &product)
		return product, nil, "", valid
	}
	bad := func(status int, message string) (map[string]any, []productPhoto, string, bool) {
		fail(w, status, message)
		return nil, nil, "", false
	}
	r.Body = http.MaxBytesReader(w, r.Body, (26 << 20))
	if err := r.ParseMultipartForm(1 << 20); err != nil {
		return bad(400, "could not read product photos. Use up to six photos, under 5 MB each and 25 MB total.")
	}
	defer r.MultipartForm.RemoveAll()
	fields := r.MultipartForm.Value
	if len(fields["saveKey"]) != 1 || !photoKeyPattern.MatchString(fields["saveKey"][0]) ||
		len(fields["product"]) != 1 || len(fields["product"][0]) > 1<<20 {
		return bad(400, "invalid product photo save")
	}
	decoder := json.NewDecoder(strings.NewReader(fields["product"][0]))
	decoder.UseNumber()
	if decoder.Decode(&product) != nil || decoder.Decode(new(any)) != io.EOF || product == nil {
		return bad(400, "invalid product details")
	}
	files := r.MultipartForm.File["photos"]
	if len(files) == 0 || len(files) > maxProductPhotos || len(r.MultipartForm.File) != 1 {
		return bad(400, "choose up to six new photos at a time")
	}
	photos := make([]productPhoto, 0, len(files))
	total := 0
	for _, file := range files {
		if file.Size <= 0 || file.Size > maxPhotoBytes {
			return bad(413, "each photo must be under 5 MB")
		}
		stream, err := file.Open()
		if err != nil {
			return bad(400, "a photo could not be opened")
		}
		data, err := io.ReadAll(io.LimitReader(stream, maxPhotoBytes+1))
		stream.Close()
		total += len(data)
		if err != nil || len(data) > maxPhotoBytes || total > 25<<20 {
			return bad(413, "photos must be under 5 MB each and 25 MB total")
		}
		ext := photoExtension(data)
		if ext == "" {
			return bad(400, "choose JPG, PNG, WebP or GIF photos")
		}
		photos = append(photos, productPhoto{data, ext})
	}
	return product, photos, fields["saveKey"][0], true
}

func photoRef(i int) string { return photoRefPrefix + strconv.Itoa(i) }

func replaceProductPhotoRefs(p map[string]any, delivery []string, substitute bool) error {
	used := make([]bool, len(delivery))
	lookup := func(value string) (int, bool) {
		for i := range delivery {
			if value == photoRef(i) {
				used[i] = true
				return i, true
			}
		}
		return 0, false
	}
	for _, item := range p["images"].([]any) {
		image := item.(map[string]any)
		src, _ := image["src"].(string)
		thumb, _ := image["thumb"].(string)
		if i, ok := lookup(src); ok {
			if thumb != "" && thumb != src {
				return userErr{400, "invalid photo thumbnail reference"}
			}
			if substitute {
				image["src"] = delivery[i]
				image["thumb"] = strings.Replace(delivery[i], "/upload/f_auto,q_auto/", "/upload/f_auto,q_auto,w_300/", 1)
			}
		} else if strings.Contains(src, photoRefPrefix) || strings.Contains(thumb, photoRefPrefix) {
			return userErr{400, "unknown product photo reference"}
		}
	}
	desc, _ := p["desc"].(string)
	for _, match := range photoRefPattern.FindAllStringSubmatch(desc, -1) {
		if _, ok := lookup(match[1]); !ok {
			return userErr{400, "unknown description photo reference"}
		}
	}
	if substitute {
		p["desc"] = photoRefPattern.ReplaceAllStringFunc(desc, func(attr string) string {
			ref := photoRefPattern.FindStringSubmatch(attr)[1]
			i, _ := lookup(ref)
			return strings.Replace(attr, ref, delivery[i], 1)
		})
	} else if strings.Contains(photoRefPattern.ReplaceAllString(desc, ""), photoRefPrefix) {
		return userErr{400, "invalid description photo reference"}
	}
	if slices.Contains(used, false) {
		return userErr{400, "remove unused photos before saving"}
	}
	return nil
}

type photoReservation struct {
	id, attempt, storage string
}

func productPhotoNumber(ctx context.Context, tx pgx.Tx, productID int64, p map[string]any, slug string) (string, error) {
	stem := strings.Trim(photoStemJunk.ReplaceAllString(strings.ToLower(slug), "-"), "-")
	if stem == "" || len(stem) > 90 || strings.Contains(slug, "%") {
		stem = fmt.Sprintf("product-%d", productID)
	}
	category := "other"
	for _, item := range p["cats"].([]any) {
		if v := item.(string); nameRe.MatchString(v) && len(v) <= 90 && v != "latest-product" && v != "popular-item" {
			category = v
			break
		}
	}
	var n int64
	if err := tx.QueryRow(ctx, `SELECT nextval('product_photo_numbers')`).Scan(&n); err != nil {
		return "", err
	}
	return fmt.Sprintf("loverbaazar/products/%s/%s-%d", category, stem, n), nil
}

func saveProductPhotos(ctx context.Context, id int64, method string, p map[string]any, slug string, files []productPhoto, key, stockFingerprint string, save func(pgx.Tx, int64) (int64, error)) (int64, error) {
	delivery := make([]string, len(files))
	if err := replaceProductPhotoRefs(p, delivery, false); err != nil {
		return 0, err
	}
	j, _ := json.Marshal(p)
	hash := sha256.New()
	fmt.Fprintf(hash, "%s:%d:%s:%s\n", method, id, stockFingerprint, j)
	for _, file := range files {
		sum := sha256.Sum256(file.bytes)
		hash.Write(sum[:])
	}
	fingerprint := hex.EncodeToString(hash.Sum(nil))
	storage := os.Getenv("CLOUDINARY_CLOUD")
	if os.Getenv("LOCAL_UPLOADS") != "" {
		storage = localPhotoStore
	} else if !cloudNamePattern.MatchString(storage) || os.Getenv("CLOUDINARY_KEY") == "" || os.Getenv("CLOUDINARY_SECRET") == "" {
		return 0, userErr{501, "Cloudinary photo storage is not configured"}
	}
	attempt := token(16)
	reservations := make([]photoReservation, len(files))
	var alreadySaved *int64
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(834927)`); err != nil {
			return err
		}
		var previous string
		var busy bool
		err := tx.QueryRow(ctx, `SELECT fingerprint,expires_at>now(),product_id FROM product_photo_saves WHERE save_key=$1`, key).Scan(&previous, &busy, &alreadySaved)
		if err == nil {
			if previous != fingerprint {
				return userErr{409, "this photo save belongs to different product details"}
			}
			if alreadySaved != nil {
				return nil
			}
			if busy {
				return userErr{409, "this product save is still in progress. Wait a moment and retry."}
			}
		} else if !errors.Is(err, pgx.ErrNoRows) {
			return err
		}
		var exists, duplicate bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM products WHERE id=$1),
			EXISTS(SELECT FROM products WHERE slug=$2 AND id<>$1)`, id, slug).Scan(&exists, &duplicate); err != nil {
			return err
		}
		if duplicate {
			return userErr{409, "another product already uses that URL slug"}
		}
		if method == http.MethodPut && !exists {
			return userErr{404, "product not found"}
		}
		if method == http.MethodPost {
			if err := tx.QueryRow(ctx, `SELECT nextval('product_ids')`).Scan(&id); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(ctx, `INSERT INTO product_photo_saves VALUES($1,$2,$3,now()+interval '2 minutes',NULL)
			ON CONFLICT(save_key) DO UPDATE SET attempt=excluded.attempt,expires_at=excluded.expires_at`,
			key, fingerprint, attempt); err != nil {
			return err
		}
		for i, file := range files {
			publicID, err := productPhotoNumber(ctx, tx, id, p, slug)
			if err != nil {
				return err
			}
			if storage == localPhotoStore {
				publicID = filepath.Base(publicID) + "-" + attempt + "." + file.ext
			}
			reservations[i] = photoReservation{publicID, attempt, storage}
			if _, err := tx.Exec(ctx, `INSERT INTO product_photo_uploads(public_id,attempt,storage) VALUES($1,$2,$3)`, publicID, attempt, storage); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	if alreadySaved != nil {
		return *alreadySaved, nil
	}
	finalized := false
	defer func() {
		if finalized {
			return
		}
		// Use a new context when the browser disconnects. The upload intents already exist.
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		tag, err := db.Exec(cleanup, `UPDATE product_photo_saves SET expires_at=now()
			WHERE save_key=$1 AND attempt=$2 AND product_id IS NULL`, key, attempt)
		if err == nil && tag.RowsAffected() == 1 {
			// Only confirmed successful uploads are eligible for immediate compensation.
			// An ambiguous response remains in the queue until the provider has settled.
			for i, address := range delivery {
				if address != "" {
					_ = clearFailedPhoto(cleanup, reservations[i])
				}
			}
		}
		kickPhotoSweep()
	}()
	for i, photo := range reservations {
		if storage == localPhotoStore {
			delivery[i], err = saveLocalPhoto(photo.id, files[i].bytes)
		} else {
			delivery[i], err = uploadCloudPhoto(ctx, files[i].bytes, photo.id, attempt)
		}
		if err != nil {
			return 0, err
		}
	}
	if err := replaceProductPhotoRefs(p, delivery, true); err != nil {
		return 0, err
	}
	err = pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE product_photo_saves SET product_id=$3,expires_at=now()+interval '7 days'
			WHERE save_key=$1 AND attempt=$2 AND product_id IS NULL AND expires_at>now()`, key, attempt, id)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return userErr{409, "photo save expired. Try saving again."}
		}
		if _, err := save(tx, id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `UPDATE product_photo_uploads SET check_after=NULL WHERE attempt=$1`, attempt)
		return err
	})
	finalized = err == nil
	return id, err
}

func saveLocalPhoto(name string, data []byte) (string, error) {
	dir := os.Getenv("LOCAL_UPLOADS")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", err
	}
	_, writeErr := f.Write(data)
	err = errors.Join(writeErr, f.Close())
	return "/uploads/" + name, err
}

func uploadCloudPhoto(ctx context.Context, file []byte, id, attempt string) (string, error) {
	cloud, key, secret := os.Getenv("CLOUDINARY_CLOUD"), os.Getenv("CLOUDINARY_KEY"), os.Getenv("CLOUDINARY_SECRET")
	if cloud == "" || key == "" || secret == "" {
		return "", userErr{501, "image storage is not configured. Add the Cloudinary keys on Render"}
	}
	folder := strings.TrimSuffix(id, "/"+filepath.Base(id))
	params := map[string]string{"asset_folder": strings.TrimSuffix(folder, "/"), "overwrite": "false", "public_id": id,
		"timestamp": strconv.FormatInt(time.Now().Unix(), 10)}
	if attempt != "" {
		params["context"] = "lb_photo_save=" + attempt
	}
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	form.WriteField("api_key", key)
	form.WriteField("signature", signUpload(params, secret))
	for k, v := range params {
		form.WriteField(k, v)
	}
	part, _ := form.CreateFormFile("file", "upload")
	part.Write(file)
	form.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.cloudinary.com/v1_1/"+cloud+"/image/upload", &body)
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	client := *httpClient
	client.Timeout = 20 * time.Second
	response, err := client.Do(req)
	if err != nil {
		return "", userErr{502, "Cloudinary did not confirm the upload. Your changes are still here; try saving again."}
	}
	defer response.Body.Close()
	var out struct {
		URL      string `json:"secure_url"`
		ID       string `json:"public_id"`
		Existing bool   `json:"existing"`
	}
	if json.NewDecoder(response.Body).Decode(&out) != nil || response.StatusCode/100 != 2 ||
		out.ID != id || cloudImageID(out.URL, cloud) != id || out.Existing {
		return "", userErr{502, "Cloudinary could not save this photo. Your product changes are still here; try saving again."}
	}
	return strings.Replace(out.URL, "/upload/", "/upload/f_auto,q_auto/", 1), nil
}

func cloudImageID(address, cloud string) string {
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "https" || u.Host != "res.cloudinary.com" || u.User != nil {
		return ""
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if len(parts) < 5 || (cloud != "" && parts[0] != cloud) || parts[1] != "image" || parts[2] != "upload" {
		return ""
	}
	for i := 3; i < len(parts)-1; i++ {
		if parts[i] == uploadFolder {
			id := strings.Join(parts[i:], "/")
			return strings.TrimSuffix(id, filepath.Ext(id))
		}
	}
	return ""
}

func photoIdentity(address string) (id, storage string) {
	if filename := localUploadFile(address); filename != "" {
		return filename, localPhotoStore
	}
	u, err := url.Parse(address)
	if err != nil {
		return "", ""
	}
	parts := strings.Split(strings.TrimPrefix(u.Path, "/"), "/")
	if id := cloudImageID(address, parts[0]); id != "" {
		return id, parts[0]
	}
	return "", ""
}

func retirementAddress(id, storage string) string {
	if storage == localPhotoStore {
		return "/uploads/" + id
	}
	return "https://res.cloudinary.com/" + storage + "/image/upload/" + id
}

func retireProductPhotos(ctx context.Context, tx pgx.Tx, previous, next string) error {
	// A photo and its transformed thumbnail represent the same asset.
	refs := func(data string) map[string]string {
		items := make(map[string]string)
		for _, address := range extractImageRefs(data) {
			if id, storage := photoIdentity(address); id != "" {
				needle := id
				if storage == localPhotoStore {
					needle = address
				}
				items[retirementAddress(id, storage)] = needle
			}
		}
		return items
	}
	keep := refs(next)
	for address, needle := range refs(previous) {
		if _, kept := keep[address]; kept {
			continue
		}
		if _, err := tx.Exec(ctx, `INSERT INTO retired_images(url,retired_at)
			VALUES($1,CASE WHEN `+publishedImageInUse+` THEN now() ELSE now()-interval '30 days' + interval '2 minutes' END)
			ON CONFLICT(url) DO UPDATE SET retired_at=excluded.retired_at`, address, needle); err != nil {
			return err
		}
	}
	return nil
}
func scanPhotoReservation(row pgx.CollectableRow) (photoReservation, error) {
	var photo photoReservation
	err := row.Scan(&photo.id, &photo.attempt, &photo.storage)
	return photo, err
}

func removeManagedPhoto(ctx context.Context, photo photoReservation) error {
	if photo.storage != localPhotoStore {
		return destroyOwnedCloudPhoto(ctx, photo)
	}
	dir := os.Getenv("LOCAL_UPLOADS")
	if dir == "" || localUploadFile("/uploads/"+photo.id) == "" {
		return fmt.Errorf("local photo storage is unavailable")
	}
	err := os.Remove(filepath.Join(dir, photo.id))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

func clearFailedPhoto(ctx context.Context, photo photoReservation) error {
	if err := removeManagedPhoto(ctx, photo); err != nil {
		return err
	}
	_, err := db.Exec(ctx, `DELETE FROM product_photo_uploads WHERE public_id=$1 AND attempt=$2 AND check_after IS NOT NULL`, photo.id, photo.attempt)
	return err
}

func destroyOwnedCloudPhoto(ctx context.Context, photo photoReservation) error {
	if photo.storage != os.Getenv("CLOUDINARY_CLOUD") {
		return fmt.Errorf("Cloudinary account changed")
	}
	key, secret := os.Getenv("CLOUDINARY_KEY"), os.Getenv("CLOUDINARY_SECRET")
	if key == "" || secret == "" {
		return fmt.Errorf("Cloudinary credentials unavailable")
	}
	endpoint := "https://api.cloudinary.com/v1_1/" + photo.storage + "/resources/image/upload/" + url.PathEscape(photo.id) + "?context=true"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.SetBasicAuth(key, secret)
	response, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode == 404 {
		return nil
	}
	var stored struct {
		ID      string `json:"public_id"`
		Context struct{ Custom map[string]string }
	}
	if response.StatusCode != 200 || json.NewDecoder(response.Body).Decode(&stored) != nil || stored.ID != photo.id {
		return fmt.Errorf("Cloudinary ownership check failed")
	}
	if stored.Context.Custom["lb_photo_save"] != photo.attempt {
		return nil // a pre-existing asset owns this public ID
	}
	return destroyCloudPhoto(ctx, photo.id)
}

func managedPhotoInUse(ctx context.Context, photo photoReservation) bool {
	address := retirementAddress(photo.id, photo.storage)
	var retained bool
	if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT FROM retired_images WHERE url=$1 AND retired_at>now()-interval '30 days')`, address).Scan(&retained); err != nil || retained {
		return true
	}
	rows, err := db.Query(ctx, `SELECT data::text FROM products WHERE strpos(data::text,$1)>0
		UNION ALL SELECT data::text FROM content WHERE strpos(data::text,$1)>0
		UNION ALL SELECT data::text FROM settings WHERE strpos(data::text,$1)>0
		UNION ALL SELECT payload::text `+publishedImageFilter+` AND strpos(payload::text,$1)>0`, photo.id)
	if err != nil {
		return true
	}
	defer rows.Close()
	for rows.Next() {
		var value string
		if rows.Scan(&value) != nil {
			return true
		}
		for _, ref := range extractImageRefs(value) {
			if id, storage := photoIdentity(ref); id == photo.id && storage == photo.storage {
				return true
			}
		}
	}
	return rows.Err() != nil
}

func sweepProductPhotos(ctx context.Context) (int, error) {
	if !photoSweep.TryLock() {
		return 0, photoSweepBusy
	}
	defer photoSweep.Unlock()
	var removed int
	rows, err := db.Query(ctx, `SELECT public_id,attempt,storage FROM product_photo_uploads
		WHERE check_after<=now() ORDER BY check_after LIMIT 10`)
	if err != nil {
		return 0, err
	}
	retries, err := pgx.CollectRows(rows, scanPhotoReservation)
	if err != nil {
		return 0, err
	}
	for _, photo := range retries {
		if err := clearFailedPhoto(ctx, photo); err != nil {
			log.Print("product photo cleanup will be retried")
			continue
		}
		removed++
	}
	retired, err := db.Query(ctx, `SELECT p.public_id,p.attempt,p.storage FROM product_photo_uploads p
		JOIN retired_images r ON r.url=CASE WHEN p.storage='local' THEN '/uploads/'||p.public_id
			ELSE 'https://res.cloudinary.com/'||p.storage||'/image/upload/'||p.public_id END
		WHERE p.check_after IS NULL AND r.retired_at<=now()-interval '30 days' ORDER BY r.retired_at LIMIT 20`)
	if err != nil {
		return removed, err
	}
	photos, err := pgx.CollectRows(retired, scanPhotoReservation)
	if err != nil {
		return removed, err
	}
	for _, photo := range photos {
		address := retirementAddress(photo.id, photo.storage)
		if managedPhotoInUse(ctx, photo) || removeManagedPhoto(ctx, photo) != nil {
			continue
		}
		err = pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
			if _, err := tx.Exec(ctx, `DELETE FROM retired_images WHERE url=$1`, address); err != nil {
				return err
			}
			_, err := tx.Exec(ctx, `DELETE FROM product_photo_uploads WHERE public_id=$1 AND storage=$2`, photo.id, photo.storage)
			return err
		})
		if err != nil {
			return removed, err
		}
		removed++
	}

	_, err = db.Exec(ctx, `DELETE FROM product_photo_saves WHERE expires_at<now()-interval '1 day'`)
	return removed, err
}

var photoTimer struct {
	sync.Mutex
	timer *time.Timer
	due   time.Time
}

func planNextPhotoSweep(ctx context.Context) {
	var next *time.Time
	err := db.QueryRow(ctx, `SELECT min(due) FROM (
		SELECT check_after AS due FROM product_photo_uploads WHERE check_after>now()
		UNION ALL
		SELECT r.retired_at+interval '30 days' FROM retired_images r
		JOIN product_photo_uploads p ON p.check_after IS NULL AND r.url=CASE WHEN p.storage='local' THEN '/uploads/'||p.public_id
			ELSE 'https://res.cloudinary.com/'||p.storage||'/image/upload/'||p.public_id END
		WHERE r.retired_at>now()-interval '30 days') timers`).Scan(&next)
	if err != nil || next == nil || time.Until(*next) > 12*time.Minute {
		return
	}
	photoTimer.Lock()
	defer photoTimer.Unlock()
	if photoTimer.timer != nil && !next.Before(photoTimer.due) {
		return
	}
	if photoTimer.timer != nil {
		photoTimer.timer.Stop()
	}
	photoTimer.due = *next
	photoTimer.timer = time.AfterFunc(time.Until(*next)+time.Second, func() {
		photoTimer.Lock()
		if photoTimer.due.Equal(*next) {
			photoTimer.timer = nil
		}
		photoTimer.Unlock()
		kickPhotoSweep()
	})
}

func kickPhotoSweep() {
	if dev {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if _, err := sweepProductPhotos(ctx); err != nil && !errors.Is(err, photoSweepBusy) {
			log.Print("product photo cleanup queue could not be read")
		}
		planNextPhotoSweep(ctx)
	}()
}

// The authenticated cleanup button also reports photos retained or waiting for another retry.
func adminPhotoStatus(w http.ResponseWriter, r *http.Request) {
	var pending, retired int
	err := db.QueryRow(r.Context(), `SELECT (SELECT count(*) FROM product_photo_uploads WHERE check_after IS NOT NULL),
		(SELECT count(*) FROM retired_images)`).Scan(&pending, &retired)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]int{"pending": pending, "retired": retired})
}
