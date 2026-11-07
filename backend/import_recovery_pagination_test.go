package main

import (
	"io"
	"log"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

func TestRecoverySharedQueuePreservesImportConversionPDFOrder(t *testing.T) {
	s, jobs := recoveryPagingService(t)
	var want []string
	for i, mode := range []string{"skip_invalid", "bundle", "skip_invalid", "bundle"} {
		job := core.NewRecord(jobs)
		job.Set("mode", mode)
		job.Set("status", "queued")
		if i == 2 {
			job.Set("status", "inspecting")
		}
		job.Set("created", time.Date(2026, 11, 1, i, 0, 0, 0, time.UTC))
		if err := s.app.Save(job); err != nil {
			t.Fatal(err)
		}
		want = append(want, job.Id)
	}
	for i, name := range []string{"conversion_jobs", "project_files"} {
		collection, _ := s.app.FindCollectionByNameOrId(name)
		job := core.NewRecord(collection)
		job.Set("status", "processing")
		job.Set("created", time.Date(2026, 11, 2, i, 0, 0, 0, time.UTC))
		if err := s.app.Save(job); err != nil {
			t.Fatal(err)
		}
		want = append(want, job.Id)
	}
	previousLog := log.Writer()
	log.SetOutput(io.Discard)
	defer log.SetOutput(previousLog)
	const repetitions = 100
	var reversed int
	var first []string
	for range repetitions {
		service := newImportService(s.app)
		service.queue = make(chan importWork, 1) // Exercise actual admission backpressure.
		done := make(chan struct{})
		go func() { service.recoverPendingWork(); close(done) }()
		got := make([]string, 0, len(want))
		for range want {
			select {
			case work := <-service.queue:
				got = append(got, work.id)
			case <-time.After(5 * time.Second):
				t.Fatal("recovery did not admit the complete shared-queue backlog")
			}
		}
		<-done
		service.imageCancel()
		for index := range want {
			if got[index] != want[index] {
				reversed++
				if first == nil {
					first = got
				}
				break
			}
		}
	}
	if reversed != 0 {
		t.Fatalf("shared recovery reordered import→conversion→PDF in %d/%d runs; first=%v want=%v", reversed, repetitions, first, want)
	}
}

func recoveryPagingService(t *testing.T) (*importService, *core.Collection) {
	t.Helper()
	s, jobs := newOCRTestService(t)
	jobs.Fields.Add(&core.DateField{Name: "created"})
	if err := s.app.Save(jobs); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"conversion_jobs", "project_files"} {
		collection := core.NewBaseCollection(name)
		collection.Fields.Add(&core.TextField{Name: "status"}, &core.DateField{Name: "created"})
		if err := s.app.Save(collection); err != nil {
			t.Fatal(err)
		}
	}
	return s, jobs
}

func TestRecoveryKeysetDoesNotSkipChangingStatusOrTimestampTies(t *testing.T) {
	s, jobs := recoveryPagingService(t)
	for i := 0; i < 7; i++ {
		job := core.NewRecord(jobs)
		job.Set("status", "queued")
		job.Set("created", "2026-11-01 00:00:00Z")
		if i == 6 {
			job.Set("created", "2026-11-02 00:00:00Z")
		}
		if err := s.app.Save(job); err != nil {
			t.Fatal(err)
		}
	}
	seen := map[string]bool{}
	count, err := s.walkPendingWork("import_jobs", `status="queued"`, 2, func(job *core.Record) {
		if seen[job.Id] {
			t.Fatalf("repeated cursor record: %s", job.Id)
		}
		seen[job.Id] = true
		// A real worker removes completed records from the recovery predicate.
		job.Set("status", "completed")
		if err := s.app.Save(job); err != nil {
			t.Fatal(err)
		}
	})
	if err != nil || count != 7 || len(seen) != 7 {
		t.Fatalf("keyset lost records as workers progressed: count=%d seen=%d err=%v", count, len(seen), err)
	}
}

func TestRecoveryReadsBeyondFormerTenThousandLimit(t *testing.T) {
	s, _ := recoveryPagingService(t)
	if _, err := s.app.DB().NewQuery(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<10001)
		INSERT INTO import_jobs (id,status,mode,created)
		SELECT printf('job%012d',n),'queued','skip_invalid','2026-11-01 00:00:00Z' FROM seq`).Execute(); err != nil {
		t.Fatal(err)
	}
	lastSeen := false
	count, err := s.walkPendingWork("import_jobs", `status="queued"`, 250, func(job *core.Record) {
		if job.Id == "job000000010001" {
			lastSeen = true
		}
	})
	if err != nil || count != 10001 || !lastSeen {
		t.Fatalf("persisted backlog truncated: count=%d last=%v err=%v", count, lastSeen, err)
	}
}

func TestRecoveryOCRAdmissionDoesNotWaitForFullCSVQueue(t *testing.T) {
	s, jobs := recoveryPagingService(t)
	s.ocrQueue = make(chan importWork, 1)
	for _, mode := range []string{"skip_invalid", "skip_invalid", "ocr"} {
		job := core.NewRecord(jobs)
		job.Set("mode", mode)
		job.Set("status", "queued")
		job.Set("created", "2026-11-01 00:00:00Z")
		if err := s.app.Save(job); err != nil {
			t.Fatal(err)
		}
	}
	s.queue <- importWork{kind: "sentinel"} // All CSV admission is blocked.
	done, drain := make(chan struct{}), make(chan struct{})
	go func() { s.recoverPendingWork(); close(done) }()
	consumerDone := make(chan struct{})
	go func() {
		defer close(consumerDone)
		<-drain
		for range 3 {
			<-s.queue
		}
	}()
	t.Cleanup(func() { close(drain); <-consumerDone; <-done })
	select {
	case work := <-s.ocrQueue:
		if work.kind != "ocr" {
			t.Fatalf("wrong independent queue work: %+v", work)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("full CSV queue prevented OCR recovery admission")
	}
}
