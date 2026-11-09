package main

import (
	"bytes"
	"context"
	"errors"
	"os"
	"testing"
	"time"
)

func TestCancelledPDFWorkDoesNotParseOrPublish(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := buildTaskPDFContext(ctx, bytes.NewReader(renderingTestPDF()), 1, 2, "test", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("trim cancellation: %v", err)
	}
	if _, err := watermarkTaskPDFContext(ctx, bytes.NewReader(renderingTestPDF()), "test"); !errors.Is(err, context.Canceled) {
		t.Fatalf("watermark cancellation: %v", err)
	}
	if _, err := validatePDFStructureContext(ctx, bytes.NewReader(renderingTestPDF())); !errors.Is(err, context.Canceled) {
		t.Fatalf("validation cancellation: %v", err)
	}
	dir := t.TempDir()
	if err := splitPDFPagesContext(ctx, bytes.NewReader(renderingTestPDF()), dir, pdfBookBudget); !errors.Is(err, context.Canceled) {
		t.Fatalf("split cancellation: %v", err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatal("cancelled split published files")
	}
}

func TestPreviewDeadlineIncludesWaitingForCacheLock(t *testing.T) {
	pdfCacheMu.Lock()
	defer pdfCacheMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := (&importService{}).cachedTaskPDFContext(ctx, nil, pdfPreviewDescriptor{})
	if !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > time.Second {
		t.Fatalf("lock ignored deadline: %v", err)
	}
}
