//go:build capacityprobe

package main

import (
	"bytes"
	"compress/gzip"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCapacityProbeRequiresPrivateNonceDirectory(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	nonce := strings.Repeat("a", 32)
	if _, err = capacityProbeDirectory(root, nonce); err == nil {
		t.Fatal("missing marker accepted")
	}
	marker := filepath.Join(root, ".capacity-probe-nonce")
	if err = os.WriteFile(marker, []byte(nonce), 0600); err != nil {
		t.Fatal(err)
	}
	if got, err := capacityProbeDirectory(root, nonce); err != nil || got != root {
		t.Fatalf("valid opt-in: %s %v", got, err)
	}
	if _, err = capacityProbeDirectory(root, strings.Repeat("b", 32)); err == nil {
		t.Fatal("wrong nonce accepted")
	}
	if err = os.Chmod(root, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err = capacityProbeDirectory(root, nonce); err == nil {
		t.Fatal("public directory accepted")
	}
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(t.TempDir(), "alias")
	if err = os.Symlink(root, alias); err != nil {
		t.Fatal(err)
	}
	if _, err = capacityProbeDirectory(alias, nonce); err == nil {
		t.Fatal("directory symlink accepted")
	}
	if err = os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(root, "other")
	if err = os.WriteFile(target, []byte(nonce), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(target, marker); err != nil {
		t.Fatal(err)
	}
	if _, err = capacityProbeDirectory(root, nonce); err == nil {
		t.Fatal("marker symlink accepted")
	}
	if got, err := capacityProbeDirectory("", ""); err != nil || got != "" {
		t.Fatal("disabled probe rejected")
	}
	if capacityProbeRoute("/api/fangji/projects/private-id/claim?token=x") != "other" {
		t.Fatal("route should only categorize paths")
	}
}

func TestCapacityProbePrivateFilesAndNoPublicEndpoint(t *testing.T) {
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chmod(root, 0700); err != nil {
		t.Fatal(err)
	}
	nonce := strings.Repeat("c", 32)
	if err = os.WriteFile(filepath.Join(root, ".capacity-probe-nonce"), []byte(nonce), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FANGJI_CAPACITY_PROFILE_DIR", root)
	t.Setenv("FANGJI_CAPACITY_PROFILE_NONCE", nonce)
	_, app := newExternalIdentityTestService(t)
	registerCapacityProbe(app)
	router, err := apis.NewRouter(app)
	if err != nil {
		t.Fatal(err)
	}
	if err = app.OnServe().Trigger(&core.ServeEvent{App: app, Router: router}); err != nil {
		t.Fatal(err)
	}
	mux, err := router.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/debug/pprof/", "/debug/pprof/heap", "/debug/pprof/profile", "/api/fangji/debug/pprof"} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path+"?token=PROFILE_PRIVATE_SENTINEL", nil)
		request.Header.Set("Authorization", "PROFILE_PRIVATE_SENTINEL")
		mux.ServeHTTP(response, request)
		if response.Code != 404 {
			t.Fatalf("exposed profile endpoint %s: %d", path, response.Code)
		}
	}
	if err = app.OnTerminate().Trigger(&core.TerminateEvent{App: app}); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join(root, "server-*", "*.pprof"))
	if err != nil || len(files) != 6 {
		t.Fatalf("profile output count: %d %v", len(files), err)
	}
	for _, file := range files {
		info, err := os.Stat(file)
		if err != nil || info.Mode().Perm() != 0600 {
			t.Fatalf("non-private profile %s", file)
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		reader, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(decoded, []byte("PROFILE_PRIVATE_SENTINEL")) {
			t.Fatal("profile included request values")
		}
	}
}
