package main

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sync"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/hook"
)

const dataDirectoryOwnerKey = "fangjiDataDirectoryOwner"
const dataDirectoryLockName = ".fangji-instance.lock"

var errDataDirectoryInUse = errors.New("data directory is already owned by another backend instance")

// Hold an OS lock, not a saved PID or an operator-provided assertion. Never
// unlink its path: removing a locked file would let a second inode be locked.
// The OS releases ownership on a crash; OpenFile uses close-on-exec so a
// PocketBase execve restart can acquire it again in the replacement process.
type dataDirectoryOwnership struct {
	mu   sync.Mutex
	file *os.File
	dir  string
}

func (o *dataDirectoryOwnership) acquire(dir string) error {
	o.mu.Lock()
	defer o.mu.Unlock()
	absolute, err := filepath.Abs(dir)
	if err != nil {
		return err
	}
	if o.file != nil {
		if o.dir != absolute {
			return errors.New("cannot change data directory while its ownership lock is held")
		}
		return nil
	}
	if err = os.MkdirAll(absolute, 0o700); err != nil {
		return err
	}
	path := filepath.Join(absolute, dataDirectoryLockName)
	if info, statErr := os.Lstat(path); statErr == nil && !info.Mode().IsRegular() {
		return errors.New("data directory ownership lock must be a regular file")
	} else if statErr != nil && !os.IsNotExist(statErr) {
		return statErr
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	failed := true
	defer func() {
		if failed {
			_ = f.Close()
		}
	}()
	opened, err := f.Stat()
	if err != nil {
		return err
	}
	current, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !opened.Mode().IsRegular() || !current.Mode().IsRegular() || !os.SameFile(opened, current) {
		return errors.New("data directory ownership lock changed while opening")
	}
	if err = tryDataDirectoryFileLock(f); err != nil {
		return fmt.Errorf("data directory ownership: %w", err)
	}
	o.file, o.dir = f, absolute
	failed = false
	return nil
}

func (o *dataDirectoryOwnership) release() error {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.file == nil {
		return nil
	}
	f := o.file
	o.file, o.dir = nil, ""
	return f.Close()
}

func appDatabasesClosed(app core.App) bool {
	// IsBootstrapped requires both data and aux. It is false when only one
	// database initialized, which does not prove that the other is closed.
	return app.ConcurrentDB() == nil && app.NonconcurrentDB() == nil &&
		app.AuxConcurrentDB() == nil && app.AuxNonconcurrentDB() == nil
}

func registerDataDirectoryOwnership(app core.App) *dataDirectoryOwnership {
	owner := &dataDirectoryOwnership{}
	app.Store().Set(dataDirectoryOwnerKey, false)
	app.OnBootstrap().Bind(&hook.Handler[*core.BootstrapEvent]{
		Id: "fangjiDataDirectoryOwnership", Priority: math.MinInt + 1,
		Func: func(e *core.BootstrapEvent) error {
			if err := owner.acquire(e.App.DataDir()); err != nil {
				return err
			}
			e.App.Store().Set(dataDirectoryOwnerKey, true)
			if err := e.Next(); err != nil {
				e.App.Store().Set(dataDirectoryOwnerKey, false)
				// A later hook can fail after opening the DBs, and PocketBase
				// does not automatically clean up that failed bootstrap.
				cleanupErr := e.App.ClearBootstrap()
				if appDatabasesClosed(e.App) {
					return errors.Join(err, cleanupErr, owner.release())
				}
				// Cleanup may be vetoed or initialization may be partial.
				// Keep the OS lock until real termination/process exit.
				return errors.Join(err, cleanupErr)
			}
			return nil
		},
	})
	app.OnTerminate().Bind(&hook.Handler[*core.TerminateEvent]{
		Id: "fangjiDataDirectoryOwnership", Priority: math.MinInt,
		Func: func(e *core.TerminateEvent) error {
			err := e.Next()
			// A failed execve restart can rebootstrap the same App. Its lock
			// must remain held; a successful execve releases it in the kernel.
			// Also keep ownership if termination was vetoed before DB cleanup.
			if !e.IsRestart && appDatabasesClosed(e.App) {
				e.App.Store().Set(dataDirectoryOwnerKey, false)
				err = errors.Join(err, owner.release())
			}
			return err
		},
	})
	return owner
}
