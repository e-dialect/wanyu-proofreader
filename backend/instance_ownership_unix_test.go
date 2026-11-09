//go:build darwin || linux || freebsd || openbsd || netbsd || dragonfly

package main

import (
	"testing"

	"golang.org/x/sys/unix"
)

func TestDataDirectoryOwnershipCloseOnExec(t *testing.T) {
	owner := &dataDirectoryOwnership{}
	if err := owner.acquire(t.TempDir()); err != nil {
		t.Fatal(err)
	}
	defer owner.release()
	flags, err := unix.FcntlInt(owner.file.Fd(), unix.F_GETFD, 0)
	if err != nil {
		t.Fatal(err)
	}
	if flags&unix.FD_CLOEXEC == 0 {
		t.Fatal("PocketBase execve replacement must release the old process lock")
	}
}
