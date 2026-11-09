package main

import (
	"errors"
	"math"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

var errUnsafeDevelopmentMode = errors.New("PocketBase --dev=true is disabled: raw SQL and email logs can expose account secrets; use --dev=false (hooksWatch remains independent)")

func registerBootstrapPrivacy(app core.App) {
	app.OnBootstrap().Bind(&hook.Handler[*core.BootstrapEvent]{
		Id: "fangjiBootstrapPrivacy", Priority: math.MinInt,
		Func: func(e *core.BootstrapEvent) error {
			// Check the initialized app, not a partial command-line parse. This
			// precedes opening databases, system migrations and mailer setup.
			if e.App.IsDev() {
				return errUnsafeDevelopmentMode
			}
			return e.Next()
		},
	})
}
