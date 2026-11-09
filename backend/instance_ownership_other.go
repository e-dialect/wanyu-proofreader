//go:build !darwin && !linux && !freebsd && !openbsd && !netbsd && !dragonfly && !windows

package main

import (
	"errors"
	"os"
)

func tryDataDirectoryFileLock(*os.File) error {
	return errors.New("exclusive data directory ownership is unavailable on this operating system")
}
