package main

import (
	"log"
	"net/http"
	"regexp"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

var requestIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
var checkoutCounts [6]atomic.Uint64
var apiStarted = time.Now()

func observeRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Request-ID")
		if r.Header.Get("X-Origin-Secret") == "" || !requestIDPattern.MatchString(id) {
			id = token(16)
		}
		w.Header().Set("X-Request-ID", id)
		at := time.Now()
		res := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		func() {
			defer func() {
				if incident := recover(); incident != nil {
					if incident == http.ErrAbortHandler {
						panic(incident)
					}
					log.Printf("api_panic request_id=%s", id)
					if res.Status() == 0 {
						fail(res, 500, "something went wrong, please call us")
					}
				}
			}()
			next.ServeHTTP(res, r)
		}()
		code := res.Status()
		route := chi.RouteContext(r.Context()).RoutePattern()
		if route == "/api/checkout" {
			group := code / 100
			if group >= 2 && group <= 5 {
				checkoutCounts[group].Add(1)
			}
		}
		if code >= 500 || code == 429 {
			log.Printf("api_failure request_id=%s route=%q status=%d ms=%d", id, route, code, time.Since(at).Milliseconds())
		}
	})
}

func adminOperations(w http.ResponseWriter, r *http.Request) {
	ok(w, map[string]any{
		"version": releaseVersion, "startedAt": apiStarted,
		"ready": stockSnap.Load() != nil && catalogSnap.Load() != nil && storefrontSnap.Load() != nil,
		"checkoutResponses": map[string]uint64{
			"2xx": checkoutCounts[2].Load(), "4xx": checkoutCounts[4].Load(), "5xx": checkoutCounts[5].Load(),
		},
	})
}
