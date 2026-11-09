//go:build capacityprobe

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"runtime/pprof"
	"strings"
	"sync"
	"time"

	"github.com/dop251/goja"
	"github.com/pocketbase/pocketbase/core"
)

// Only explicitly opted-in test builds can write profiles. The caller creates
// a private, nonce-marked directory; no arbitrary data dir or HTTP endpoint is
// accepted. Profiles contain stacks/allocation sizes, never application values.
func capacityProbeDirectory(root, nonce string) (string, error) {
	if root == "" && nonce == "" {
		return "", nil
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(nonce) || !filepath.IsAbs(root) {
		return "", errors.New("invalid capacity probe opt-in")
	}
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		return "", errors.New("capacity probe directory must be private")
	}
	resolved, err := filepath.EvalSymlinks(root)
	if err != nil || resolved != filepath.Clean(root) {
		return "", errors.New("capacity probe directory must not contain symlinks")
	}
	marker := filepath.Join(root, ".capacity-probe-nonce")
	markerInfo, err := os.Lstat(marker)
	if err != nil || !markerInfo.Mode().IsRegular() || markerInfo.Mode().Perm() != 0600 || markerInfo.Size() != 32 {
		return "", errors.New("invalid capacity probe marker")
	}
	value, err := os.ReadFile(marker)
	if err != nil || string(value) != nonce {
		return "", errors.New("capacity probe nonce mismatch")
	}
	return root, nil
}

func capacityProbeRoute(path string) string {
	switch {
	case strings.HasSuffix(path, "/claim"):
		return "claim"
	case strings.HasSuffix(path, "/submit"):
		return "submit"
	case strings.HasSuffix(path, "/arbitrate"):
		return "arbitrate"
	case strings.HasSuffix(path, "/tasks/reviewed"):
		return "reviewed"
	case strings.HasSuffix(path, "/column-roles"):
		return "column_roles"
	case strings.HasSuffix(path, "/field-error-summary"):
		return "field_summary"
	case strings.HasSuffix(path, "/proofreading-queues"):
		return "queues"
	case strings.HasSuffix(path, "/project-insights"):
		return "project_insights"
	case strings.HasSuffix(path, "/pages"):
		return "pages"
	default:
		return "other"
	}
}

func registerCapacityProbe(app core.App) {
	app.OnServe().BindFunc(func(e *core.ServeEvent) error {
		root, err := capacityProbeDirectory(os.Getenv("FANGJI_CAPACITY_PROFILE_DIR"), os.Getenv("FANGJI_CAPACITY_PROFILE_NONCE"))
		if err != nil {
			return err
		}
		if root == "" {
			return e.Next()
		}
		dir := filepath.Join(root, fmt.Sprintf("server-%d", os.Getpid()))
		if err = os.Mkdir(dir, 0700); err != nil {
			return err
		}
		cpu, err := os.OpenFile(filepath.Join(dir, "cpu.pprof"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		if err = pprof.StartCPUProfile(cpu); err != nil {
			cpu.Close()
			return err
		}
		javascript, err := os.OpenFile(filepath.Join(dir, "javascript.pprof"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			pprof.StopCPUProfile()
			cpu.Close()
			return err
		}
		if err = goja.StartProfile(javascript); err != nil {
			javascript.Close()
			pprof.StopCPUProfile()
			cpu.Close()
			return err
		}
		// Goja measures execution/wait time, not CPU time; keep a separate profile.
		runtime.SetBlockProfileRate(1000000)
		runtime.SetMutexProfileFraction(10)
		write := func(name string) {
			f, err := os.OpenFile(filepath.Join(dir, name+".pprof"), os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0600)
			if err == nil {
				defer f.Close()
				_ = pprof.Lookup(name).WriteTo(f, 0)
			}
		}
		stop := make(chan struct{})
		done := make(chan struct{})
		var once sync.Once
		go func() {
			defer close(done)
			t := time.NewTicker(30 * time.Second)
			defer t.Stop()
			for {
				select {
				case <-stop:
					return
				case <-t.C:
					write("heap")
					write("allocs")
				}
			}
		}()
		app.OnTerminate().BindFunc(func(t *core.TerminateEvent) error {
			once.Do(func() {
				close(stop)
				<-done
				pprof.StopCPUProfile()
				goja.StopProfile()
				javascript.Close()
				cpu.Close()
				write("heap")
				write("allocs")
				write("block")
				write("mutex")
				runtime.SetBlockProfileRate(0)
				runtime.SetMutexProfileFraction(0)
			})
			return t.Next()
		})
		e.Router.BindFunc(func(c *core.RequestEvent) error {
			var result error
			pprof.Do(c.Request.Context(), pprof.Labels("route", capacityProbeRoute(c.Request.URL.Path)), func(ctx context.Context) { c.Request = c.Request.WithContext(ctx); result = c.Next() })
			return result
		})
		return e.Next()
	})
}
