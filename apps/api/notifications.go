package main

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
)

//go:embed migrations-v4.sql
var notificationSQL string
var notificationDrain sync.Mutex

type mailPayload struct {
	To            []string
	Subject, Text string
}

func ownerMailRecipients() []string {
	addresses := os.Getenv("ADMIN_EMAIL")
	if strings.TrimSpace(addresses) == "" {
		addresses = os.Getenv("SHOP_EMAIL")
	}
	seen := map[string]bool{}
	var result []string
	for _, value := range strings.Split(addresses, ",") {
		address := strings.ToLower(strings.TrimSpace(value))
		if emailRe.MatchString(address) && !seen[address] && len(result) < 5 {
			seen[address] = true
			result = append(result, address)
		}
	}
	return result
}

func orderMailEnabled() bool {
	mode := os.Getenv("APP_ENV")
	return !dev && mode != "local" && mode != "preview"
}

func queueOrderMail(ctx context.Context, tx pgx.Tx, orderID int64, to, name string, site map[string]any, bill receipt) error {
	if !orderMailEnabled() {
		return nil
	}
	owner := mailPayload{Subject: fmt.Sprintf("New order %s: ৳%d", bill.number, bill.total),
		Text: fmt.Sprintf("Order %s was placed. Open Orders in the shop admin for fulfillment details.", bill.number)}
	ownerJSON, _ := json.Marshal(owner)
	if _, err := tx.Exec(ctx, `INSERT INTO order_notifications(order_id,kind,payload) VALUES($1,'owner',$2::jsonb)`, orderID, string(ownerJSON)); err != nil {
		return err
	}
	if to != "" && os.Getenv("CUSTOMER_ORDER_EMAIL") != "false" {
		shop, _ := site["name"].(string)
		phone, _ := site["phone"].(string)
		customer := mailPayload{To: []string{to}, Subject: fmt.Sprintf("Your %s order %s", shop, bill.number),
			Text: customerMail(name, shop, phone, bill.text())}
		customerJSON, _ := json.Marshal(customer)
		_, err := tx.Exec(ctx, `INSERT INTO order_notifications(order_id,kind,payload) VALUES($1,'customer',$2::jsonb)`, orderID, string(customerJSON))
		return err
	}
	return nil
}

func configuredMail() bool {
	return os.Getenv("BREVO_KEY") != "" && emailRe.MatchString(strings.TrimSpace(os.Getenv("SHOP_EMAIL")))
}

func reserveMailBudget(ctx context.Context, tx pgx.Tx, count int) (bool, error) {
	limit, err := strconv.Atoi(os.Getenv("ORDER_EMAIL_DAILY_LIMIT"))
	if err != nil || limit < 1 || limit > 240 {
		limit = 240
	}
	result, err := tx.Exec(ctx, `INSERT INTO notification_daily_budget(day,recipients)
		SELECT (now() AT TIME ZONE 'UTC')::date,$1::integer WHERE $1::integer<=$2::integer
		ON CONFLICT(day) DO UPDATE SET recipients=notification_daily_budget.recipients+excluded.recipients
		WHERE notification_daily_budget.recipients+excluded.recipients<=$2::integer`, count, limit)
	return result.RowsAffected() == 1, err
}

type queuedMail struct {
	ID       int64
	Kind     string
	Attempts int
	Message  mailPayload
}

func claimMail(ctx context.Context, requested int64, uncertain bool) (queuedMail, error) {
	var job queuedMail
	err := pgx.BeginFunc(ctx, db, func(tx pgx.Tx) error {
		// An interrupted send may have reached Brevo. Require provider-log review before replay.
		if _, e := tx.Exec(ctx, `UPDATE order_notifications SET state='uncertain',outcome='interrupted'
			WHERE state='sending' AND updated_at<now()-interval '2 minutes'`); e != nil {
			return e
		}
		var payload []byte
		e := tx.QueryRow(ctx, `SELECT id,kind,payload,attempts FROM order_notifications
			WHERE attempts<3 AND
			  (($1=0 AND state IN ('pending','failed') AND next_attempt<=now()) OR
			   (id=$1 AND (state IN ('pending','failed') OR ($2 AND state='uncertain'))))
			ORDER BY next_attempt,id LIMIT 1 FOR UPDATE SKIP LOCKED`, requested, uncertain).
			Scan(&job.ID, &job.Kind, &payload, &job.Attempts)
		if errors.Is(e, pgx.ErrNoRows) {
			return nil
		}
		if e != nil {
			return e
		}
		if e := json.Unmarshal(payload, &job.Message); e != nil {
			return e
		}
		if job.Kind == "owner" {
			job.Message.To = ownerMailRecipients()
		}
		if len(job.Message.To) == 0 {
			_, e = tx.Exec(ctx, `UPDATE order_notifications SET state='failed',outcome='recipient_missing',next_attempt=now()+interval '1 hour',updated_at=now() WHERE id=$1`, job.ID)
			job.ID = 0
			return e
		}
		allowed, e := reserveMailBudget(ctx, tx, len(job.Message.To))
		if e != nil {
			return e
		}
		if !allowed {
			_, e = tx.Exec(ctx, `UPDATE order_notifications SET outcome='local_quota',next_attempt=now()+interval '1 hour',updated_at=now() WHERE id=$1`, job.ID)
			job.ID = 0
			return e
		}
		_, e = tx.Exec(ctx, `UPDATE order_notifications SET attempts=attempts+1,state='sending',updated_at=now() WHERE id=$1`, job.ID)
		job.Attempts++
		return e
	})
	return job, err
}

func deliverMail(ctx context.Context, message mailPayload, tag string) (state, outcome string, automatic bool) {
	to := make([]map[string]string, 0, len(message.To))
	for _, address := range message.To {
		to = append(to, map[string]string{"email": address})
	}
	payload := map[string]any{
		"sender": map[string]string{"email": strings.TrimSpace(os.Getenv("SHOP_EMAIL"))},
		"to":     to, "subject": message.Subject, "textContent": message.Text, "tags": []string{tag},
	}
	if replyTo := strings.TrimSpace(os.Getenv("SHOP_REPLY_TO")); emailRe.MatchString(replyTo) {
		payload["replyTo"] = map[string]string{"email": replyTo}
	}
	b, _ := json.Marshal(payload)
	req, _ := http.NewRequestWithContext(ctx, "POST", "https://api.brevo.com/v3/smtp/email", bytes.NewReader(b))
	req.Header.Set("api-key", os.Getenv("BREVO_KEY"))
	req.Header.Set("Content-Type", "application/json")
	res, err := httpClient.Do(req)
	if err != nil {
		return "uncertain", "network", false
	}
	defer res.Body.Close()
	switch {
	case res.StatusCode == 201:
		return "accepted", "brevo_accepted", false
	case res.StatusCode == 429:
		return "failed", "provider_quota", true
	case res.StatusCode >= 500 || res.StatusCode == 408:
		return "uncertain", "provider_unavailable", false
	default:
		return "failed", "provider_rejected", false
	}
}

func sendQueuedMail(ctx context.Context, requested int64, uncertain bool) (bool, error) {
	job, err := claimMail(ctx, requested, uncertain)
	if err != nil || job.ID == 0 {
		return false, err
	}
	sendCtx, cancel := context.WithTimeout(ctx, 12*time.Second)
	state, outcome, automatic := deliverMail(sendCtx, job.Message, mailTag(job.ID))
	cancel()
	_, err = db.Exec(ctx, `UPDATE order_notifications SET state=$2,outcome=$3,
		next_attempt=CASE WHEN $4 THEN now()+interval '30 minutes' ELSE 'infinity'::timestamptz END,
		payload=CASE WHEN $2='accepted' THEN '{}'::jsonb ELSE payload END,updated_at=now()
		WHERE id=$1 AND state='sending' AND attempts=$5`, job.ID, state, outcome, automatic, job.Attempts)
	log.Printf("order_mail kind=%s state=%s outcome=%s", job.Kind, state, outcome)
	return true, err
}

func mailTag(id int64) string { return fmt.Sprintf("lb-order-mail-%d", id) }

func kickOrderMail() {
	if !orderMailEnabled() || !configuredMail() || !notificationDrain.TryLock() {
		return
	}
	go func() {
		defer notificationDrain.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Second)
		defer cancel()
		for i := 0; i < 8; i++ {
			sent, err := sendQueuedMail(ctx, 0, false)
			if err != nil {
				log.Print("order_mail event=queue_error")
				return
			}
			if !sent {
				return
			}
		}
	}()
}

func adminNotifications(w http.ResponseWriter, r *http.Request) {
	rows, err := jsonRows(r.Context(), `SELECT jsonb_build_object(
		'id',n.id,'order',o.number,'kind',n.kind,'state',CASE WHEN n.state='sending' AND n.updated_at<now()-interval '2 minutes' THEN 'uncertain' ELSE n.state END,
		'attempts',n.attempts,'outcome',n.outcome,'updatedAt',n.updated_at)
		FROM order_notifications n JOIN orders o ON o.id=n.order_id
		ORDER BY (n.state='accepted'),n.updated_at DESC,n.id DESC LIMIT 100`)
	if err != nil {
		oops(w, err)
		return
	}
	var daily int
	err = db.QueryRow(r.Context(), `SELECT coalesce((SELECT recipients FROM notification_daily_budget WHERE day=(now() AT TIME ZONE 'UTC')::date),0)`).Scan(&daily)
	if err != nil {
		oops(w, err)
		return
	}
	ok(w, map[string]any{"enabled": orderMailEnabled() && configuredMail(), "today": daily, "notifications": rows, "testConfigured": configuredMail() && emailRe.MatchString(os.Getenv("BREVO_TEST_EMAIL"))})
}

func adminRetryNotification(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil || id < 1 {
		fail(w, 400, "invalid notification ID")
		return
	}
	var in struct{ VerifiedMissing bool }
	if !read(w, r, &in) {
		return
	}
	if !orderMailEnabled() || !configuredMail() {
		fail(w, 409, "order email is disabled or its sender is unconfigured")
		return
	}
	sent, err := sendQueuedMail(r.Context(), id, in.VerifiedMissing)
	if err != nil {
		oops(w, err)
		return
	}
	if !sent {
		fail(w, 409, "notification cannot be retried. Check its state, attempts, recipient and quota.")
		return
	}
	done(w)
}

func adminTestNotification(w http.ResponseWriter, r *http.Request) {
	to := os.Getenv("BREVO_TEST_EMAIL")
	if dev || !configuredMail() || !emailRe.MatchString(to) {
		fail(w, 409, "configure a controlled BREVO_TEST_EMAIL and verified sender first")
		return
	}
	allowed := false
	err := pgx.BeginFunc(r.Context(), db, func(tx pgx.Tx) error {
		var err error
		allowed, err = reserveMailBudget(r.Context(), tx, 1)
		return err
	})
	if err != nil {
		oops(w, err)
		return
	}
	if !allowed {
		fail(w, 429, "daily email budget reached")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	state, outcome, _ := deliverMail(ctx, mailPayload{To: []string{to}, Subject: "LoverBaazar notification test", Text: "This is a delivery test. It contains no order or customer data."}, "lb-admin-test")
	if state != "accepted" {
		fail(w, 502, "Brevo test result: "+outcome+". Check the transactional log before retrying.")
		return
	}
	done(w)
}
