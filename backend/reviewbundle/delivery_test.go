package reviewbundle

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func syntheticDelivery() DeliverySnapshot {
	return DeliverySnapshot{Project: "synthetic-project", ImportJob: "synthetic-job", ResultOf: "rb-synthetic", SourceSystem: "xiangsheng-jihe", SourceID: "synthetic-lexicon", SourceVersion: "v1", RightsRef: "src-synthetic", Recipient: "synthetic-consumer", Purpose: "public_display", SelectionRef: "D-synthetic-1", SelectionRule: "合成数据；整批已核查的采用范围", SelectionConfirmedBy: "synthetic-D-reviewer", SelectionAuthority: "manual_handoff_pending_315", Operator: "synthetic-operator", Reviewer: "synthetic-reviewer", Version: 1, Expected: ScopeCounts{1, 1, 1}, Database: ScopeCounts{1, 1, 1}, Declarations: []Declaration{{EntryID: "e3", Scope: "pending", Reason: "rights_gate"}, {EntryID: "e1", Scope: "adopted"}, {EntryID: "e2", Scope: "excluded", Reason: "unknown"}}, Entries: []ResultEntry{{EntryID: "e1", ReviewedFields: []ReviewedField{{Field: "词条", Value: "合成样例甲", Decision: "confirmed", Provenance: "proofread_round:2"}}}}}
}

func TestDeliveryReplayAndDeterminism(t *testing.T) {
	s := syntheticDelivery()
	stamp := "2026-10-18T00:00:00Z"
	before := append([]Declaration(nil), s.Declarations...)
	a, err := BuildDelivery(s, stamp)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, s.Declarations) {
		t.Fatal("builder mutated caller's snapshot")
	}
	s.Declarations[0], s.Declarations[2] = s.Declarations[2], s.Declarations[0]
	b, err := BuildDelivery(s, stamp)
	if err != nil || !bytes.Equal(a, b) {
		t.Fatalf("unstable order: %v", err)
	}
	for _, pin := range []string{Digest(a), strings.ToUpper(Digest(a)), strings.ToUpper(Digest(a)[:20]) + Digest(a)[20:]} {
		replayed, _, err := ReplayDelivery(a, pin)
		if err != nil || !bytes.Equal(replayed, a) {
			t.Fatalf("offline replay with hexadecimal case %q: %v", pin, err)
		}
	}
	_, snapshot, err := ReplayDelivery(a, Digest(a))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Database != s.Database {
		t.Fatal("counts lost")
	}
	report, err := ValidateZip(a)
	if err != nil || !report.OK || report.SchemaVersion != SchemaResult || report.EntryCount != len(s.Entries) {
		t.Fatalf("#182 contract: %+v %v", report, err)
	}
	files, _, _ := loadZipFiles(a)
	if !bytes.Contains(files["delivery.json"], []byte(`"release_decision":"human_required"`)) {
		t.Fatal("human decision missing")
	}
	if bytes.Contains(files["results.jsonl"], []byte("e2")) || bytes.Contains(files["results.jsonl"], []byte("e3")) {
		t.Fatal("outside content leaked")
	}
	// Canonical replay under a normalized timestamp is byte-identical; only the
	// manifest timestamp and checksums derived from it change across wall clocks.
	c, err := BuildDelivery(s, "2026-10-19T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	cf, _, _ := loadZipFiles(c)
	for _, name := range []string{"delivery.json", "results.jsonl"} {
		if !bytes.Equal(files[name], cf[name]) {
			t.Fatalf("unexpected time-dependent file: %s", name)
		}
	}
	// Optional public fixture. Generated only by an explicit validation command.
	if target := os.Getenv("DELIVERY_SYNTHETIC_SAMPLE"); target != "" {
		if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, a, 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestDeliveryEveryArchiveByteIsPinned(t *testing.T) {
	data, err := BuildDelivery(syntheticDelivery(), "2026-10-18T00:00:00Z")
	if err != nil {
		t.Fatal(err)
	}
	pin := Digest(data)
	for i := range data {
		data[i] ^= 1
		_, _, err := ReplayDelivery(data, pin)
		data[i] ^= 1
		if err == nil || !strings.Contains(err.Error(), "未写入任何数据") {
			t.Fatalf("byte %d accepted: %v", i, err)
		}
	}
	// Re-pin a semantically corrupted member: archive hash alone is not validation.
	files, _, _ := loadZipFiles(data)
	files["delivery.json"] = bytes.Replace(files["delivery.json"], []byte(`"human_required"`), []byte(`"publishable"`), 1)
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, name := range []string{"checksums.sha256", "delivery.json", "manifest.json", "results.jsonl"} {
		w, _ := zw.Create(name)
		_, _ = w.Write(files[name])
	}
	_ = zw.Close()
	if _, _, err := ReplayDelivery(out.Bytes(), Digest(out.Bytes())); err == nil {
		t.Fatal("re-pinned inconsistent sidecar accepted")
	}
}

func TestDeliveryRefusesMissingHumansAndFalseCounts(t *testing.T) {
	for _, name := range []string{"operator", "reviewer", "selection", "counts", "scope", "reason", "source", "previous", "field"} {
		t.Run(name, func(t *testing.T) {
			s := syntheticDelivery()
			switch name {
			case "operator":
				s.Operator = ""
			case "reviewer":
				s.Reviewer = " "
			case "selection":
				s.SelectionConfirmedBy = ""
			case "counts":
				s.Expected.Adopted++
			case "scope":
				s.Declarations[1].Scope = "excluded"
			case "reason":
				s.Declarations[0].Reason = ""
			case "source":
				s.SourceVersion = ""
			case "previous":
				s.Version = 2
			case "field":
				s.Entries[0].ReviewedFields = nil
			}
			if _, err := BuildDelivery(s, "2026-10-18T00:00:00Z"); err == nil {
				t.Fatalf("invalid %s accepted", name)
			}
		})
	}
}

func TestDeliveryChangesDescribeResend(t *testing.T) {
	previous := syntheticDelivery()
	current := syntheticDelivery()
	current.Entries[0].ReviewedFields[0].Value = "合成修正"
	current.Entries = append(current.Entries, ResultEntry{EntryID: "new"})
	current.Declarations[0].Scope = "excluded"
	current.SourceVersion = "v2"
	got := CompareDelivery(previous, current)
	want := DeliveryChanges{Added: 1, Changed: 1, ScopeChanged: 1, SourceChanged: true}
	if got != want {
		t.Fatalf("changes: %+v want %+v", got, want)
	}
	current.Entries = nil
	if got := CompareDelivery(previous, current); got.Removed != len(previous.Entries) {
		t.Fatalf("removed: %+v", got)
	}
}
