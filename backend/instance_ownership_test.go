package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

func TestDataDirectoryOwnershipExcludesLiveOwnerAndRetainsLockFile(t *testing.T) {
	dir := t.TempDir()
	first, second := &dataDirectoryOwnership{}, &dataDirectoryOwnership{}
	t.Cleanup(func() { _ = first.release(); _ = second.release() })
	if err := first.acquire(dir); err != nil {
		t.Fatal(err)
	}
	if err := first.acquire(dir); err != nil {
		t.Fatalf("same App rebootstrap must retain its lock: %v", err)
	}
	if err := second.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatalf("second owner must be refused: %v", err)
	}
	if err := first.acquire(t.TempDir()); err == nil {
		t.Fatal("a live owner cannot silently switch directories")
	}
	independent := &dataDirectoryOwnership{}
	if err := independent.acquire(t.TempDir()); err != nil {
		t.Fatalf("different test/deployment directory must remain independent: %v", err)
	}
	if err := independent.release(); err != nil {
		t.Fatal(err)
	}
	if err := first.release(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, dataDirectoryLockName)); err != nil {
		t.Fatal("release must not unlink the ownership inode", err)
	}
	if err := second.acquire(dir); err != nil {
		t.Fatalf("an unlocked, stale file is not a stale PID lock: %v", err)
	}
}

func TestDataDirectoryOwnershipRefusesSymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(t.TempDir(), "unrelated")
	if err := os.WriteFile(target, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, dataDirectoryLockName)); err != nil {
		t.Skipf("symlinks unavailable on this test host: %v", err)
	}
	owner := &dataDirectoryOwnership{}
	t.Cleanup(func() { _ = owner.release() })
	if err := owner.acquire(dir); err == nil {
		t.Fatal("must refuse a symlink instead of locking unrelated files")
	}
	if data, err := os.ReadFile(target); err != nil || string(data) != "unchanged" {
		t.Fatal("unrelated file changed", err)
	}
}

func ownershipTestApp(t *testing.T, dir string) core.App {
	t.Helper()
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: dir})
	owner := registerDataDirectoryOwnership(app)
	t.Cleanup(func() {
		app.OnTerminate().Unbind("ownershipTerminationVeto")
		app.OnBootstrapClear().Unbind("ownershipClearVeto")
		_ = app.OnTerminate().Trigger(&core.TerminateEvent{App: app}, func(e *core.TerminateEvent) error {
			return e.App.ClearBootstrap()
		})
		_ = owner.release()
	})
	return app
}

func TestDataDirectoryOwnershipCleansPostBootstrapFailure(t *testing.T) {
	dir := t.TempDir()
	app := ownershipTestApp(t, dir)
	failure := errors.New("synthetic post-bootstrap failure")
	app.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		return failure
	})
	if err := app.Bootstrap(); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if !appDatabasesClosed(app) || app.Store().Get(dataDirectoryOwnerKey) != false {
		t.Fatal("post-bootstrap failure must close its DBs before releasing ownership")
	}
	other := &dataDirectoryOwnership{}
	defer other.release()
	if err := other.acquire(dir); err != nil {
		t.Fatal("successfully cleaned failed startup retained its lock", err)
	}
}

func TestDataDirectoryOwnershipKeepsFailedCleanupOwned(t *testing.T) {
	dir := t.TempDir()
	app := ownershipTestApp(t, dir)
	failure := errors.New("synthetic post-bootstrap failure")
	veto := errors.New("synthetic bootstrap cleanup veto")
	app.OnBootstrapClear().Bind(&hook.Handler[*core.BootstrapEvent]{
		Id: "ownershipClearVeto", Func: func(*core.BootstrapEvent) error { return veto },
	})
	app.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		return failure
	})
	if err := app.Bootstrap(); !errors.Is(err, failure) || !errors.Is(err, veto) {
		t.Fatalf("must preserve both failures: %v", err)
	}
	if !app.IsBootstrapped() || app.Store().Get(dataDirectoryOwnerKey) != false {
		t.Fatal("test requires open DBs but no recovery authority after failure")
	}
	other := &dataDirectoryOwnership{}
	defer other.release()
	if err := other.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatal("failed cleanup released a still-open database", err)
	}
	if err := app.OnTerminate().Trigger(&core.TerminateEvent{App: app}, func(e *core.TerminateEvent) error {
		return e.App.ClearBootstrap()
	}); !errors.Is(err, veto) {
		t.Fatal(err)
	}
	if err := other.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatal("vetoed termination released database ownership", err)
	}
}

func TestDataDirectoryOwnershipKeepsPartiallyInitializedDataOwned(t *testing.T) {
	dir := t.TempDir()
	failure := errors.New("synthetic auxiliary database initialization failure")
	var opened []*dbx.DB
	app := core.NewBaseApp(core.BaseAppConfig{
		DataDir: dir,
		DBConnect: func(path string) (*dbx.DB, error) {
			if filepath.Base(path) == "auxiliary.db" {
				return nil, failure
			}
			db, err := core.DefaultDBConnect(path)
			if err == nil {
				opened = append(opened, db)
			}
			return db, err
		},
	})
	owner := registerDataDirectoryOwnership(app)
	t.Cleanup(func() {
		// PocketBase ClearBootstrap is a no-op for this partial state.
		// Test teardown owns and closes the actual injected connections.
		for _, db := range opened {
			_ = db.Close()
		}
		_ = owner.release()
	})
	if err := app.Bootstrap(); !errors.Is(err, failure) {
		t.Fatal(err)
	}
	if app.IsBootstrapped() || app.ConcurrentDB() == nil || appDatabasesClosed(app) {
		t.Fatal("test requires a real data-only partial initialization")
	}
	if _, err := app.ConcurrentDB().NewQuery("SELECT 1").Execute(); err != nil {
		t.Fatal("partial initialization must still have a live DB builder", err)
	}
	other := &dataDirectoryOwnership{}
	defer other.release()
	if err := other.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatal("partial bootstrap released live data ownership", err)
	}
	if err := app.OnTerminate().Trigger(&core.TerminateEvent{App: app}, func(e *core.TerminateEvent) error {
		return e.App.ClearBootstrap()
	}); err != nil {
		t.Fatal(err)
	}
	if err := other.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatal("partial termination must not confuse IsBootstrapped=false with closed DBs", err)
	}
}

func TestDataDirectoryOwnershipPrecedesBootstrapAndReleasesOnFailure(t *testing.T) {
	dir := t.TempDir()
	owner := &dataDirectoryOwnership{}
	if err := owner.acquire(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = owner.release() })
	app := ownershipTestApp(t, dir)
	reachedDatabase := false
	failure := errors.New("synthetic later bootstrap failure")
	app.OnBootstrap().Bind(&hook.Handler[*core.BootstrapEvent]{
		Id: "ownershipLaterBootstrap", Priority: math.MinInt + 2,
		Func: func(e *core.BootstrapEvent) error {
			reachedDatabase = true
			return failure
		},
	})
	if err := app.Bootstrap(); !errors.Is(err, errDataDirectoryInUse) || reachedDatabase {
		t.Fatalf("must reject before database/recovery hooks: %v; reached=%v", err, reachedDatabase)
	}
	if app.Store().Get(dataDirectoryOwnerKey) != false {
		t.Fatal("a rejected instance cannot claim startup recovery authority")
	}
	_ = owner.release()
	if err := app.Bootstrap(); !errors.Is(err, failure) || !reachedDatabase {
		t.Fatalf("expected injected later failure: %v", err)
	}
	if app.Store().Get(dataDirectoryOwnerKey) != false {
		t.Fatal("failed bootstrap retained recovery authority")
	}
	if err := owner.acquire(dir); err != nil {
		t.Fatalf("failed bootstrap leaked the OS lock: %v", err)
	}
}

func TestDataDirectoryOwnershipKeepsVetoedAndFailedRestartInstanceOwned(t *testing.T) {
	dir := t.TempDir()
	app := ownershipTestApp(t, dir)
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	other := &dataDirectoryOwnership{}
	t.Cleanup(func() { _ = other.release() })
	veto := errors.New("synthetic termination veto")
	app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
		Id: "ownershipTerminationVeto", Priority: math.MinInt + 1,
		Func: func(*core.TerminateEvent) error { return veto },
	})
	if err := app.OnTerminate().Trigger(&core.TerminateEvent{App: app}); !errors.Is(err, veto) {
		t.Fatal(err)
	}
	if err := other.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatal("a still-running instance lost ownership after veto", err)
	}
	app.OnTerminate().Unbind("ownershipTerminationVeto")
	err := app.OnTerminate().Trigger(&core.TerminateEvent{App: app, IsRestart: true}, func(e *core.TerminateEvent) error {
		if err := e.App.ClearBootstrap(); err != nil {
			return err
		}
		if err := e.App.Bootstrap(); err != nil {
			return err
		}
		return veto // execve failed; PocketBase reboots the original App.
	})
	if !errors.Is(err, veto) || app.Store().Get(dataDirectoryOwnerKey) != true {
		t.Fatal("failed restart must keep/reacquire recovery authority", err)
	}
	if err = other.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatal("failed restart released the original live instance lock", err)
	}
	if err = app.OnTerminate().Trigger(&core.TerminateEvent{App: app}, func(e *core.TerminateEvent) error {
		return e.App.ClearBootstrap()
	}); err != nil {
		t.Fatal(err)
	}
	if app.Store().Get(dataDirectoryOwnerKey) != false {
		t.Fatal("normal shutdown retained recovery authority")
	}
	if err = other.acquire(dir); err != nil {
		t.Fatal("normal shutdown did not release ownership", err)
	}
}

func TestDataDirectoryOwnershipSubprocess(t *testing.T) {
	if os.Getenv("FANGJI_TEST_INSTANCE_OWNER") != "1" {
		return
	}
	owner := &dataDirectoryOwnership{}
	if err := owner.acquire(os.Getenv("FANGJI_TEST_INSTANCE_OWNER_DIR")); err != nil {
		t.Fatal(err)
	}
	defer owner.release()
	fmt.Println("ownership-ready")
	_, _ = io.Copy(io.Discard, os.Stdin)
}

func TestDataDirectoryOwnershipCrashReleasesWithoutDeletingFile(t *testing.T) {
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestDataDirectoryOwnershipSubprocess$", "-test.count=1")
	cmd.Env = append(os.Environ(), "FANGJI_TEST_INSTANCE_OWNER=1", "FANGJI_TEST_INSTANCE_OWNER_DIR="+dir)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	running := true
	defer func() {
		if running {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	ready, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || strings.TrimSpace(ready) != "ownership-ready" {
		t.Fatalf("child did not acquire ownership: %q %v", ready, err)
	}
	other := &dataDirectoryOwnership{}
	defer other.release()
	if err = other.acquire(dir); !errors.Is(err, errDataDirectoryInUse) {
		t.Fatal("live child did not exclude a second owner", err)
	}
	if err = cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err = cmd.Wait(); err == nil {
		t.Fatal("expected the owned child to be killed")
	}
	running = false
	if _, err = os.Stat(filepath.Join(dir, dataDirectoryLockName)); err != nil {
		t.Fatal("crash should leave the inode, not a reusable saved PID", err)
	}
	if err = other.acquire(dir); err != nil {
		t.Fatal("OS did not release ownership after the process exited", err)
	}
}
