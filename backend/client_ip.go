package main

import (
	"fmt"
	"net"
	"os"
	"strings"

	"github.com/labstack/echo/v5"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

const trustedClientIPHeader = "X-Fangji-Client-IP"

// registerTrustedClientIP configures a single, application-wide source of
// client addresses before any route handles traffic. Forwarding headers are
// accepted only when the immediate peer belongs to an explicitly trusted
// proxy range; direct clients cannot spoof their rate-limit identity.
func registerTrustedClientIP(app core.App) {
	app.OnServe().BindFunc(func(event *core.ServeEvent) error {
		rawCIDRs := strings.TrimSpace(os.Getenv("TRUSTED_PROXY_CIDRS"))
		extractor, err := trustedClientIPExtractor(rawCIDRs)
		if err != nil {
			return fmt.Errorf("configure trusted proxy IP extraction: %w", err)
		}
		event.Router.Bind(&hook.Handler[*core.RequestEvent]{
			Priority: apis.DefaultLoadAuthTokenMiddlewarePriority - 1,
			Func: func(e *core.RequestEvent) error {
				ip := extractor(e.Request)
				e.Set("fangjiClientIP", ip)
				// PocketBase's native limiter reads its configured proxy header.
				// Replace all incoming values before any native middleware sees it.
				e.Request.Header.Set(trustedClientIPHeader, ip)
				return e.Next()
			},
		})
		return event.Next()
	})
}

func trustedClientIPExtractor(rawCIDRs string) (echo.IPExtractor, error) {
	if strings.TrimSpace(rawCIDRs) == "" {
		return echo.ExtractIPDirect(), nil
	}
	options := []echo.TrustOption{
		echo.TrustLoopback(false),
		echo.TrustLinkLocal(false),
		echo.TrustPrivateNet(false),
	}
	for _, rawCIDR := range strings.Split(rawCIDRs, ",") {
		cidr := strings.TrimSpace(rawCIDR)
		if cidr == "" {
			return nil, fmt.Errorf("empty TRUSTED_PROXY_CIDRS entry")
		}
		_, network, err := net.ParseCIDR(cidr)
		if err != nil {
			return nil, fmt.Errorf("invalid TRUSTED_PROXY_CIDRS entry %q", cidr)
		}
		options = append(options, echo.TrustIPRange(network))
	}
	return echo.ExtractIPFromXFFHeader(options...), nil
}
