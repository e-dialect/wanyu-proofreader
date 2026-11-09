package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"log/slog"
	"math"
	"net/http"
	"os"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
	"github.com/pocketbase/pocketbase/tools/router"
)

type operationWriter struct{}

func (operationWriter) Write(p []byte) (int, error) { return log.Writer().Write(p) }

var operationLogger = slog.New(slog.NewJSONHandler(operationWriter{}, &slog.HandlerOptions{
	ReplaceAttr: func(groups []string, attr slog.Attr) slog.Attr {
		if len(groups) == 0 && attr.Key == slog.TimeKey {
			attr.Key = "ts"
		}
		return attr
	},
}))
var safeRequestID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,80}$`)
var telemetryID = regexp.MustCompile(`^[A-Za-z0-9._:-]{1,80}$`)
var safeOperationErrorCode = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,79}$`)

func writeOperation(level, component, event string, fields map[string]any) {
	attrs := []any{"component", component, "event", event, "build_sha", commit}
	for key, value := range fields {
		if value != nil && value != "" {
			attrs = append(attrs, key, value)
		}
	}
	severity := slog.LevelInfo
	if level == "warn" {
		severity = slog.LevelWarn
	}
	if level == "error" {
		severity = slog.LevelError
	}
	operationLogger.Log(context.Background(), severity, event, attrs...)
}

type measuredResponse struct {
	http.ResponseWriter
	bytes int64
}

func (r *measuredResponse) Write(p []byte) (int, error) {
	n, err := r.ResponseWriter.Write(p)
	r.bytes += int64(n)
	return n, err
}
func (r *measuredResponse) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func registerObservability(app core.App, importer *importService) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		// PocketBase's default activity logger persists the raw URI, referrer and
		// error details into logs.db. Replace that request logger (not system or
		// business logs) so file tokens and search text cannot enter a second sink.
		e.Router.Unbind(apis.DefaultActivityLoggerMiddlewareId)
		e.Router.Bind(&hook.Handler[*core.RequestEvent]{Id: "fangjiOperationLogger", Priority: apis.DefaultActivityLoggerMiddlewarePriority, Func: func(c *core.RequestEvent) error {
			if c.Request.Method == http.MethodGet && strings.HasPrefix(c.Request.URL.Path, "/api/realtime") {
				return c.Next()
			}
			started := time.Now()
			requestID := ensureRequestID(c)
			writer := &measuredResponse{ResponseWriter: c.Response}
			c.Response = writer
			err := c.Next()
			status := c.Status()
			if status == 0 {
				status = http.StatusOK
				if err != nil {
					status = http.StatusInternalServerError
					var apiErr *router.ApiError
					if errors.As(err, &apiErr) {
						status = apiErr.Status
					}
				}
			}
			pattern := c.Request.Pattern
			if pattern == "" {
				pattern = "unmatched"
			}
			errorCode := ""
			if err != nil {
				var apiErr *router.ApiError
				if errors.As(err, &apiErr) {
					errorCode, _ = apiErr.Data["reasonCode"].(string)
				}
				if !safeOperationErrorCode.MatchString(errorCode) {
					errorCode = "HTTP_" + strconv.Itoa(status)
				}
			}
			writeOperation("info", "http", "http_completed", map[string]any{"request_id": requestID, "route_template": pattern, "method": c.Request.Method, "status": status, "duration_ms": float64(time.Since(started).Microseconds()) / 1000, "response_bytes": writer.bytes, "error_code": errorCode})
			return err
		}})
		limiter := &telemetryLimiter{buckets: map[string]telemetryBucket{}}
		e.Router.POST("/api/fangji/telemetry/web-vitals", func(c *core.RequestEvent) error {
			if os.Getenv("FANGJI_TELEMETRY_ENABLED") != "1" {
				return apis.NewNotFoundError("此实例未启用体验指标。", nil)
			}
			if !limiter.allow(c.Auth.Id, time.Now()) {
				c.Response.Header().Set("Retry-After", "60")
				return router.NewApiError(429, "上报过于频繁。", nil)
			}
			var body struct {
				Metrics []vitalSample `json:"metrics"`
			}
			decoder := json.NewDecoder(c.Request.Body)
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&body); err != nil || len(body.Metrics) == 0 || len(body.Metrics) > 20 {
				return apis.NewBadRequestError("指标批次无效。", nil)
			}
			if decoder.Decode(new(any)) != io.EOF {
				return apis.NewBadRequestError("指标批次只能包含一个对象。", nil)
			}
			for _, metric := range body.Metrics {
				if !metric.valid() {
					return apis.NewBadRequestError("指标字段无效。", nil)
				}
			}
			for _, metric := range body.Metrics {
				writeOperation("info", "browser", "web_vital", map[string]any{"sample": metric})
			}
			return c.NoContent(http.StatusNoContent)
		}).Bind(apis.RequireAuth("users"), apis.BodyLimit(16*1024))
		ctx, cancel := context.WithCancel(context.Background())
		app.OnTerminate().BindFunc(func(t *core.TerminateEvent) error { cancel(); return t.Next() })
		go func() {
			ticker := time.NewTicker(30 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-ctx.Done():
					return
				case <-ticker.C:
					var memory runtime.MemStats
					runtime.ReadMemStats(&memory)
					writeOperation("info", "runtime", "runtime_sample", map[string]any{
						"heap_bytes": memory.HeapAlloc, "heap_sys_bytes": memory.HeapSys, "heap_inuse_bytes": memory.HeapInuse,
						"heap_released_bytes": memory.HeapReleased, "runtime_sys_bytes": memory.Sys,
						"go_memory_limit_bytes": debug.SetMemoryLimit(-1), "gomaxprocs": runtime.GOMAXPROCS(0),
						"db_pools": databasePoolSamples(app), "goroutines": runtime.NumGoroutine(),
						"queue_length": len(importer.queue), "ocr_queue_length": len(importer.ocrQueue), "image_queue_length": len(importer.imageQueue),
					})
				}
			}
		}()
		return e.Next()
	})
}

type vitalSample struct {
	SchemaVersion  int     `json:"schemaVersion"`
	BuildSHA       string  `json:"buildSha"`
	PageViewID     string  `json:"pageViewId"`
	MetricID       string  `json:"metricId"`
	Name           string  `json:"name"`
	Value          float64 `json:"value"`
	NavigationType string  `json:"navigationType"`
	EntryRoute     string  `json:"entryRoute"`
	ViewportClass  string  `json:"viewportClass"`
}

func (v vitalSample) valid() bool {
	return v.SchemaVersion == 1 && telemetryID.MatchString(v.BuildSHA) && telemetryID.MatchString(v.PageViewID) && telemetryID.MatchString(v.MetricID) &&
		(v.Name == "LCP" || v.Name == "INP" || v.Name == "CLS" || v.Name == "workspace_ready" || v.Name == "editor_ready" || v.Name == "source_visible" || v.Name == "submit_ack") &&
		!math.IsNaN(v.Value) && !math.IsInf(v.Value, 0) && v.Value >= 0 && v.Value <= 86400000 &&
		telemetryID.MatchString(v.EntryRoute) && (v.ViewportClass == "desktop" || v.ViewportClass == "mobile") &&
		(v.NavigationType == "navigate" || v.NavigationType == "reload" || v.NavigationType == "back-forward" || v.NavigationType == "back-forward-cache" || v.NavigationType == "prerender" || v.NavigationType == "restore" || v.NavigationType == "business")
}

type telemetryBucket struct {
	since time.Time
	count int
}
type telemetryLimiter struct {
	mu      sync.Mutex
	buckets map[string]telemetryBucket
}

func (l *telemetryLimiter) allow(id string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for key, bucket := range l.buckets {
		if now.Sub(bucket.since) >= time.Minute {
			delete(l.buckets, key)
		}
	}
	b := l.buckets[id]
	if b.count == 0 {
		if len(l.buckets) >= 10000 {
			return false
		}
		b.since = now
	}
	if b.count >= 6 {
		return false
	}
	b.count++
	l.buckets[id] = b
	return true
}
