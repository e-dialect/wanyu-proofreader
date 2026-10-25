// delivery-replay verifies and reconstructs an E delivery without a W database.
package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"

	"fangji/backend/reviewbundle"
)

func main() {
	if len(os.Args) != 4 {
		fmt.Fprintln(os.Stderr, "用法：delivery-replay 包.zip 已独立记录的SHA256 重放输出.zip")
		os.Exit(2)
	}
	data, err := readReplayArchive(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	out, snapshot, err := reviewbundle.ReplayDelivery(data, os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = writeReplayOutput(os.Args[3], out); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Printf("重放一致：%d 条采用正文，来源 %s/%s/%s；发布仍须人工决定。\n", len(snapshot.Entries), snapshot.SourceSystem, snapshot.SourceID, snapshot.SourceVersion)
}

const maxReplayArchiveBytes = 20 << 20

func readReplayArchive(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if info.Size() > maxReplayArchiveBytes {
		return nil, fmt.Errorf("交付包超过 20 MiB。")
	}
	// Keep the read bounded even if the input grows after Stat.
	data, err := io.ReadAll(io.LimitReader(f, maxReplayArchiveBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxReplayArchiveBytes {
		return nil, fmt.Errorf("交付包超过 20 MiB。")
	}
	return data, nil
}

func writeReplayOutput(path string, data []byte) error {
	// CreateTemp uses 0600. Replacing the destination keeps an existing file's
	// permissive mode (or a symlink target) from receiving the replayed contents.
	f, err := os.CreateTemp(filepath.Dir(path), ".delivery-replay-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}
