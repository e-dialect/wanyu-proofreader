package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/labstack/echo/v5"
	"github.com/pocketbase/pocketbase/core"
)

func TestTrustedClientIPExtractor(t *testing.T) {
	extractor, err := trustedClientIPExtractor("172.18.0.0/16")
	if err != nil {
		t.Fatalf("create extractor: %v", err)
	}

	tests := []struct {
		name       string
		remoteAddr string
		forwarded  string
		want       string
	}{
		{
			name:       "direct client cannot spoof forwarding header",
			remoteAddr: "203.0.113.10:49152",
			forwarded:  "198.51.100.77",
			want:       "203.0.113.10",
		},
		{
			name:       "trusted proxy supplies client address",
			remoteAddr: "172.18.0.4:49152",
			forwarded:  "198.51.100.21",
			want:       "198.51.100.21",
		},
		{
			name:       "rightmost untrusted hop wins",
			remoteAddr: "172.18.0.4:49152",
			forwarded:  "192.0.2.5, 198.51.100.22, 172.18.0.3",
			want:       "198.51.100.22",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			router := echo.New()
			router.IPExtractor = extractor
			request := httptest.NewRequest("GET", "/", nil)
			request.RemoteAddr = test.remoteAddr
			request.Header.Set(echo.HeaderXForwardedFor, test.forwarded)
			context := router.NewContext(request, httptest.NewRecorder())
			if got := context.RealIP(); got != test.want {
				t.Fatalf("RealIP() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestTrustedClientIPExtractorRejectsInvalidConfiguration(t *testing.T) {
	for _, raw := range []string{"not-a-cidr", "172.18.0.0/16,"} {
		if _, err := trustedClientIPExtractor(raw); err == nil {
			t.Fatalf("trustedClientIPExtractor(%q) unexpectedly succeeded", raw)
		}
	}
}

func TestTrustedClientIPExtractorDefaultsToDirectPeer(t *testing.T) {
	extractor, err := trustedClientIPExtractor("")
	if err != nil {
		t.Fatalf("create direct extractor: %v", err)
	}
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "203.0.113.11:49152"
	request.Header.Set(echo.HeaderXForwardedFor, "198.51.100.99")
	if got := extractor(request); got != "203.0.113.11" {
		t.Fatalf("direct extractor = %q, want %q", got, "203.0.113.11")
	}
}

func TestNativeAccountRateLimitUsesTrustedClientIP(t *testing.T) {
	service, app := newExternalIdentityTestService(t)
	user, _, err := service.resolveOrCreateUser("mock", "native-rate-limit")
	if err != nil {
		t.Fatal(err)
	}
	token, err := user.NewAuthToken()
	if err != nil {
		t.Fatal(err)
	}

	app.Settings().TrustedProxy = core.TrustedProxyConfig{Headers: []string{trustedClientIPHeader}}
	app.Settings().RateLimits = core.RateLimitsConfig{
		Enabled: true,
		Rules: []core.RateLimitRule{
			{Label: "*:authRefresh", Duration: 60, MaxRequests: 30},
		},
	}
	h := accountTestRouter(t, app)

	refresh := func(peer, forwarded, header string, want int) {
		t.Helper()
		r := httptest.NewRequest(http.MethodPost, "/api/collections/users/auth-refresh", nil)
		r.RemoteAddr = peer
		r.Header.Set("Authorization", token)
		r.Header.Set(echo.HeaderXForwardedFor, forwarded)
		r.Header.Set(trustedClientIPHeader, header)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != want {
			t.Fatalf("native refresh status = %d, want %d", w.Code, want)
		}
	}
	for range 30 {
		refresh("172.18.0.4:49152", "198.51.100.21", "", http.StatusOK)
	}
	refresh("172.18.0.4:49153", "198.51.100.21", "198.51.100.22", http.StatusTooManyRequests)
	refresh("172.18.0.4:49154", "198.51.100.22", "", http.StatusOK)
	refresh("198.51.100.21:49155", "198.51.100.22", "198.51.100.22", http.StatusTooManyRequests)
}
