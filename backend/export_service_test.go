package main

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
)

func TestProjectExportOptions(t *testing.T) {
	for _, raw := range []string{"format=zip", "format=csv&format=jsonl", "status=importing", "status=x' OR 1=1", "quality_state=gold", "since=2026-10-18", "include_withheld=true", "quality_state=withheld", "limit=2"} {
		q, _ := url.ParseQuery(raw)
		if _, err := parseProjectExportOptions(q, []string{"approved", "pending", "importing"}); err == nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	q, _ := url.ParseQuery("format=jsonl&status=approved&quality_state=withheld&include_withheld=1&since=2026-10-18T01:02:03%2B08:00")
	o, err := parseProjectExportOptions(q, []string{"approved"})
	if err != nil || o.Since != "2026-10-17T17:02:03Z" {
		t.Fatalf("options %+v %v", o, err)
	}
	where, params := projectExportWhere("synthetic", o)
	if !strings.Contains(where, "{:project}") || strings.Contains(where, "synthetic") || params["since"] != "2026-10-17 17:02:03.000Z" {
		t.Fatalf("unsafe filter %s %v", where, params)
	}
	o.Since = "2026-10-18T00:00:00.000000001Z"
	_, params = projectExportWhere("synthetic", o)
	if params["since"] != "2026-10-18 00:00:00.001Z" {
		t.Fatal("sub-millisecond lower bound rounded down")
	}
}

func TestExportPlainOriginalIsNotReplacedByUnfinishedProofread(t *testing.T) {
	_, collection, _ := exportFixture(t, 0, 0)
	page := core.NewRecord(collection)
	page.Set("status", "claimed")
	page.Set("ocr_text", "原始合成文本")
	page.Set("proofread_text", "尚未完成的合成修改")
	value, _ := exportRowObject(page).get("内容")
	if value != "原始合成文本" {
		t.Fatal("unfinished result replaced original")
	}
}

func exportFixture(t *testing.T, n, width int) (*pocketbase.PocketBase, *core.Collection, *core.Record) {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ResetBootstrapState() })
	collection := core.NewBaseCollection("pages")
	for _, name := range strings.Split(projectExportSelect, ",") {
		if name == "id" {
			continue
		}
		if containsStr([]string{"page_number", "pdf_page", "proofread_round", "proofread_count"}, name) {
			collection.Fields.Add(&core.NumberField{Name: name})
		} else {
			collection.Fields.Add(&core.TextField{Name: name})
		}
	}
	collection.Fields.Add(&core.TextField{Name: "project"}, &core.TextField{Name: "updated"})
	collection.Indexes = []string{"CREATE UNIQUE INDEX idx_fixture_page ON pages (project,page_number)"}
	if err := app.Save(collection); err != nil {
		t.Fatal(err)
	}
	projectCollection := core.NewBaseCollection("projects")
	projectCollection.Fields.Add(&core.TextField{Name: "name"}, &core.TextField{Name: "column_roles_json"})
	project := core.NewRecord(projectCollection)
	project.Id = "syntheticproj001"
	project.Set("name", "合成导出")
	project.Set("column_roles_json", `{"词条":"headword"}`)
	data, _ := json.Marshal(map[string]string{"词条": "𢶀𠮷a̤̍合成样例", "释义": strings.Repeat("synthetic", width)})
	db := app.NonconcurrentDB().(*dbx.DB)
	if err := db.Transactional(func(tx *dbx.Tx) error {
		for i := 0; i < n; i++ {
			_, err := tx.NewQuery(`INSERT INTO pages (id,project,page_number,pdf_page,status,quality_state,ocr_row_json,proofread_row_json,row_headers_json,source_system,source_id,source_version,proofread_round) VALUES ({:id},{:project},{:number},{:number},'approved','candidate',{:data},{:data},'[' || '"词条","释义"' || ']','synthetic','fixture','v1',1)`).Bind(dbx.Params{"id": fmt.Sprintf("%015d", i+1), "project": project.Id, "number": i + 1, "data": string(data)}).Execute()
			if err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return app, collection, project
}

func TestProjectExportSnapshotAndEncoding(t *testing.T) {
	app, collection, project := exportFixture(t, 3, 2)
	db := app.ConcurrentDB().(*dbx.DB)
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	o := projectExportOptions{Format: "csv"}
	where, params := projectExportWhere(project.Id, o)
	m, err := inspectProjectExport(context.Background(), tx, collection, project, o, where, params)
	if err != nil {
		t.Fatal(err)
	}
	// Concurrent changes after the initial scan must not leak into the body or
	// alter the count/header/Content-Length computed from this read snapshot.
	if _, err := app.DB().NewQuery("UPDATE pages SET proofread_row_json='{}' WHERE page_number=1").Execute(); err != nil {
		t.Fatal(err)
	}
	var text strings.Builder
	if err := writeProjectExport(context.Background(), &text, tx, collection, where, params, m); err != nil {
		t.Fatal(err)
	}
	counter := &exportByteCounter{}
	if err := writeProjectExport(context.Background(), counter, tx, collection, where, params, m); err != nil {
		t.Fatal(err)
	}
	if counter.Bytes != int64(text.Len()) {
		t.Fatal("wrong declared byte length")
	}
	rows, err := csv.NewReader(strings.NewReader(strings.TrimPrefix(text.String(), "\uFEFF"))).ReadAll()
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != m.ExportedCount+1 || rows[0][1] != "field:词条" || rows[1][1] != "𢶀𠮷a̤̍合成样例" {
		t.Fatalf("snapshot/encoding broken: %v", rows)
	}
	for _, row := range rows[1:] {
		var meta projectExportMetadata
		if err := json.Unmarshal([]byte(row[len(row)-1]), &meta); err != nil || meta.ExportedCount != len(rows)-1 || meta.Sampling || meta.Extrapolatable {
			t.Fatal("dishonest metadata")
		}
	}
}

// Optional reproducible performance evidence against a real PocketBase database.
// Historical buffered server export and new streaming export read the same rows;
// browser heap evidence is measured separately, not conflated with Go heap.
func TestProjectExportScaleEvidence(t *testing.T) {
	output := os.Getenv("EXPORT_MEASURE_PATH")
	if output == "" {
		t.Skip("set EXPORT_MEASURE_PATH to collect 12k-row evidence")
	}
	app, collection, project := exportFixture(t, 12000, 256)
	type result struct {
		Mode          string `json:"mode"`
		Rows          int    `json:"rows"`
		Bytes         int64  `json:"bytes"`
		ElapsedMS     int64  `json:"elapsed_ms"`
		PeakHeapDelta uint64 `json:"peak_heap_delta_bytes"`
	}
	measure := func(mode string, fn func() (int, int64, error)) result {
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)
		var peak atomic.Uint64
		peak.Store(before.HeapAlloc)
		done := make(chan struct{})
		stopped := make(chan struct{})
		go func() {
			defer close(stopped)
			ticker := time.NewTicker(time.Millisecond)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-ticker.C:
					var m runtime.MemStats
					runtime.ReadMemStats(&m)
					for old := peak.Load(); m.HeapAlloc > old; old = peak.Load() {
						if peak.CompareAndSwap(old, m.HeapAlloc) {
							break
						}
					}
				}
			}
		}()
		start := time.Now()
		count, size, err := fn()
		elapsed := time.Since(start)
		close(done)
		<-stopped
		if err != nil {
			t.Fatal(err)
		}
		r := result{Mode: mode, Rows: count, Bytes: size, ElapsedMS: elapsed.Milliseconds(), PeakHeapDelta: peak.Load() - before.HeapAlloc}
		t.Logf("%+v", r)
		return r
	}
	legacy := measure("legacy_buffered_server", func() (int, int64, error) {
		pages, err := app.FindRecordsByFilter("pages", "project = {:project}", "page_number,id", 200000, 0, dbx.Params{"project": project.Id})
		if err != nil {
			return 0, 0, err
		}
		rows := make([]exportedRow, 0, len(pages))
		headers := []string{}
		for _, page := range pages {
			row := exportRowObject(page)
			var saved []string
			_ = json.Unmarshal([]byte(page.GetString("row_headers_json")), &saved)
			for _, key := range orderedRowHeaders(saved, row) {
				if !containsStr(headers, key) {
					headers = append(headers, key)
				}
			}
			rows = append(rows, exportedRow{pageNumber: strconv.Itoa(page.GetInt("pdf_page")), rowObj: row})
		}
		body := buildCSVText(append([]string{"PDF页码"}, headers...), headers, rows)
		size := int64(len(body))
		runtime.KeepAlive(pages)
		runtime.KeepAlive(rows)
		runtime.KeepAlive(body)
		return len(pages), size, nil
	})
	stream := measure("snapshot_streamed_csv_three_passes", func() (int, int64, error) {
		tx, err := app.ConcurrentDB().(*dbx.DB).BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
		if err != nil {
			return 0, 0, err
		}
		defer tx.Rollback()
		o := projectExportOptions{Format: "csv"}
		where, params := projectExportWhere(project.Id, o)
		m, err := inspectProjectExport(context.Background(), tx, collection, project, o, where, params)
		if err != nil {
			return 0, 0, err
		}
		counter := &exportByteCounter{}
		if err = writeProjectExport(context.Background(), counter, tx, collection, where, params, m); err != nil {
			return 0, 0, err
		}
		err = writeProjectExport(context.Background(), io.Discard, tx, collection, where, params, m)
		return m.ExportedCount, counter.Bytes, err
	})
	if legacy.Rows != stream.Rows || stream.Rows <= 10000 {
		t.Fatal("scale fixture not comparable")
	}
	data, _ := json.MarshalIndent(map[string]any{"dataset": "synthetic only; identical database rows", "metric": "Go HeapAlloc high-water sampled every 1 ms after GC; delta over per-run baseline", "results": []result{legacy, stream}}, "", "  ")
	if err := os.WriteFile(output, append(data, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
}
