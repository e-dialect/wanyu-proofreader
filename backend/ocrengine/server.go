package ocrengine

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

type Recognizer func(context.Context, string, int, string) (Result, error)

// Handler accepts material only with the internal secret. No filesystem path,
// executable name, URL, shell argument or model path is supplied by clients.
func Handler(secret string, timeout time.Duration, recognize Recognizer) http.Handler {
	busy := make(chan struct{}, 1)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/healthz" {
			w.WriteHeader(http.StatusOK)
			return
		}
		if r.Method != "POST" || r.URL.Path != "/v1/recognize" {
			http.NotFound(w, r)
			return
		}
		if len(secret) < 32 || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+secret)) != 1 {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		page, err := strconv.Atoi(r.URL.Query().Get("page"))
		language := r.URL.Query().Get("language")
		if err != nil || page < 1 || page > 100000 || (language != "eng" && language != "chi_sim" && language != "chi_sim+eng") {
			http.Error(w, "unsupported options", 400)
			return
		}
		select {
		case busy <- struct{}{}:
			defer func() { <-busy }()
		default:
			http.Error(w, "worker busy", http.StatusServiceUnavailable)
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		file, err := os.CreateTemp("", "ocr-input-*.pdf")
		if err != nil {
			http.Error(w, "temporary storage unavailable", 503)
			return
		}
		defer os.Remove(file.Name())
		body := http.MaxBytesReader(w, r.Body, MaxPDFBytes)
		_, copyErr := io.Copy(file, body)
		closeErr := file.Close()
		if copyErr != nil || closeErr != nil {
			http.Error(w, "invalid or oversized input", http.StatusRequestEntityTooLarge)
			return
		}
		result, err := recognize(ctx, file.Name(), page, language)
		if err != nil {
			if errors.Is(err, ErrScannedUnsupported) {
				w.Header().Set("X-OCR-Error", "OCR_SCANNED_UNSUPPORTED")
				http.Error(w, "native PDF text required; scanned rare-character safety is not qualified", http.StatusUnprocessableEntity)
				return
			}
			status := http.StatusUnprocessableEntity
			if ctx.Err() != nil {
				status = http.StatusGatewayTimeout
			}
			http.Error(w, "local recognition failed", status)
			return
		}
		encoded, err := json.Marshal(result)
		if err != nil || len(encoded) > MaxOutputBytes {
			http.Error(w, "output budget exceeded", 422)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write(encoded)
	})
}
