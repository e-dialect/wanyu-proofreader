package main

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestReadReplayArchiveLimit(t *testing.T) {
	path := filepath.Join(t.TempDir(), "archive.zip")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(maxReplayArchiveBytes + 1); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if data, err := readReplayArchive(path); err == nil || data != nil {
		t.Fatalf("oversized archive accepted: %d bytes, %v", len(data), err)
	}
	if err := os.Truncate(path, maxReplayArchiveBytes); err != nil {
		t.Fatal(err)
	}
	if data, err := readReplayArchive(path); err != nil || len(data) != maxReplayArchiveBytes {
		t.Fatalf("boundary rejected: %d bytes, %v", len(data), err)
	}
}

func TestWriteReplayOutputReplacesWithPrivateFile(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "existing"}[existing], func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "result.zip")
			if existing {
				if err := os.WriteFile(path, []byte("previous longer contents"), 0644); err != nil {
					t.Fatal(err)
				}
			}
			want := []byte("replay")
			if err := writeReplayOutput(path, want); err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, want) {
				t.Fatalf("output: %q, %v", got, err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
				t.Fatalf("output mode: %o, want 600", info.Mode().Perm())
			}
			files, err := os.ReadDir(dir)
			if err != nil || len(files) != 1 {
				t.Fatalf("temporary files remain: %v, %v", files, err)
			}
		})
	}
}

func TestWriteReplayOutputFailurePreservesDestination(t *testing.T) {
	dir := t.TempDir()
	dest := filepath.Join(dir, "existing-directory")
	if err := os.Mkdir(dest, 0700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(dest, "marker")
	if err := os.WriteFile(marker, []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := writeReplayOutput(dest, []byte("replay")); err == nil {
		t.Fatal("replacing directory succeeded")
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "keep" {
		t.Fatalf("destination changed: %q, %v", data, err)
	}
	if files, err := os.ReadDir(dir); err != nil || len(files) != 1 {
		t.Fatalf("temporary files remain: %v, %v", files, err)
	}
}
