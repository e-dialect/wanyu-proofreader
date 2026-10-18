package scheme

import (
	"path/filepath"
	"strings"
	"testing"
)

// The 凡例 in this repository can support exactly one kind of real registration:
// the handful of pinyin↔IPA pairs printed in its own examples. Everything else
// the dictionary says is in an appendix that was not supplied, and 文读字汇 has
// no IPA column at all. These tests pin the boundary — the file must load, reach
// the first arrow, and then decline at the tone class rather than borrow the
// target scheme's same-looking contour.
func loadPartialReal(t *testing.T) *Adapter {
	t.Helper()
	adapter, err := LoadAdapterWithScheme(
		filepath.Join("data", "source", "puxian-dict-preface.json"),
		loadTargetScheme(t),
	)
	if err != nil {
		t.Fatalf("the registered part of 凡例 must load: %v", err)
	}
	return adapter
}

func TestPartialRealRegistrationStaysTestOnly(t *testing.T) {
	adapter := loadPartialReal(t)
	if adapter.SchemaVersion != AdapterSchemaV2 {
		t.Fatalf("schema version = %d, want %d", adapter.SchemaVersion, AdapterSchemaV2)
	}
	if adapter.MayDriveRealJobs() {
		t.Fatal("a partial registration must not be eligible for real jobs")
	}
	if adapter.v2.coverage == "" {
		t.Fatal("a partial registration has to say what it covers")
	}
}

func TestPartialRealRegistrationDoesNotInventMappings(t *testing.T) {
	adapter := loadPartialReal(t)
	if got := adapter.v2.onsetIPA["k"].IPA; got != "kh" {
		t.Fatalf("the 凡例 writes ASCII kh; the registration must not turn it into kʰ, got %q", got)
	}
	if len(adapter.v2.correspondences) != 0 {
		t.Fatalf("no correspondence has a documented basis yet, got %v", adapter.v2.correspondences)
	}
	for _, tone := range adapter.Source.ToneValues {
		if adapter.v2.toneClass[tone] != "" {
			t.Fatalf("tone %s was assigned a class the 凡例 does not give", tone)
		}
		if adapter.v2.toneMissing[tone] == "" {
			t.Fatalf("tone %s has no class and no recorded reason", tone)
		}
	}
	// The dictionary's full correspondence table is in an appendix this
	// repository does not have, so the inventory is the four documented
	// syllables and nothing more.
	if len(adapter.Source.Onsets) != 4 || len(adapter.Source.Rimes) != 3 || len(adapter.Source.ToneValues) != 3 {
		t.Fatalf("inventory grew beyond the 凡例 examples: %+v", adapter.Source)
	}
}

func TestPartialRealRegistrationDeclinesAtTheMissingToneClass(t *testing.T) {
	adapter := loadPartialReal(t)
	for _, input := range []string{"bɑk4dou453", "kô21lou453"} {
		result := Convert(input, adapter)
		if result.Status != Unsupported {
			t.Fatalf("%s: status = %s, want UNSUPPORTED", input, result.Status)
		}
		if result.CanonicalPronunciation != "" {
			t.Fatalf("%s carried a value: %q", input, result.CanonicalPronunciation)
		}
		if got := result.Trace[len(result.Trace)-1]; got != "decline:source_to_ipa:missing_tone_category" {
			t.Fatalf("%s: last trace = %s", input, got)
		}
		// The trace proves it reached the first arrow and stopped there: a
		// source segment is named, no target-side rule is.
		joined := strings.Join(result.Trace, ",")
		if !strings.Contains(joined, "source_to_ipa:") {
			t.Fatalf("%s did not reach the source arrow: %v", input, result.Trace)
		}
		if strings.Contains(joined, "ipa_to_target:") {
			t.Fatalf("%s ran the second arrow although the tone class is unknown: %v", input, result.Trace)
		}
	}
}
