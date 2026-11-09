package main

import (
	"context"
	"errors"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

func TestBootstrapPrivacyRejectsBeforeOpeningData(t *testing.T) {
	for _, dev := range []bool{true, false} {
		dir := filepath.Join(t.TempDir(), "unopened-data")
		app := core.NewBaseApp(core.BaseAppConfig{IsDev: dev, DataDir: dir})
		registerBootstrapPrivacy(app)
		entered := false
		app.OnBootstrap().Bind(&hook.Handler[*core.BootstrapEvent]{Priority: math.MinInt + 1, Func: func(e *core.BootstrapEvent) error {
			entered = true
			return e.Next()
		}})
		err := app.Bootstrap()
		if dev {
			if !errors.Is(err, errUnsafeDevelopmentMode) || entered || app.IsBootstrapped() {
				t.Fatalf("unsafe bootstrap proceeded: err=%v entered=%v bootstrapped=%v", err, entered, app.IsBootstrapped())
			}
			if _, statErr := os.Stat(dir); !os.IsNotExist(statErr) {
				t.Fatalf("unsafe bootstrap created data directory: %v", statErr)
			}
		} else {
			if err != nil || !entered || !app.IsBootstrapped() {
				t.Fatalf("private bootstrap failed: err=%v entered=%v", err, entered)
			}
			if _, err := os.Stat(filepath.Join(dir, "data.db")); err != nil {
				t.Fatal(err)
			}
			if err := app.ResetBootstrapState(); err != nil {
				t.Fatal(err)
			}
		}
	}
}

func TestBootstrapPrivacyCLIRejectsExplicitDev(t *testing.T) {
	for _, flags := range [][]string{
		{"serve", "--http=127.0.0.1:0", "--dev=true"},
		{"serve", "--dev=true", "--http", "127.0.0.1:0"},
	} {
		dir := filepath.Join(t.TempDir(), "unopened-data")
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		args := append([]string{"-test.run=^TestBootstrapPrivacyCLIHelper$", "--"}, flags...)
		args = append(args, "--dir="+dir, "--hooksWatch=false")
		command := exec.CommandContext(ctx, os.Args[0], args...)
		command.Env = append(os.Environ(), "FANGJI_TEST_PRIVACY_CLI=1")
		output, err := command.CombinedOutput()
		cancel()
		if err == nil || !strings.Contains(string(output), errUnsafeDevelopmentMode.Error()) {
			t.Fatalf("CLI did not reject explicit dev mode: err=%v output=%s", err, output)
		}
		if _, err := os.Stat(dir); !os.IsNotExist(err) {
			t.Fatalf("CLI opened data before privacy rejection: %v", err)
		}
	}
}

func TestBootstrapPrivacyCLIHelper(t *testing.T) {
	if os.Getenv("FANGJI_TEST_PRIVACY_CLI") != "1" {
		return
	}
	for i, value := range os.Args {
		if value == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			main()
			return
		}
	}
	t.Fatal("missing CLI arguments")
}
