package scheme

import (
	"slices"
	"testing"
)

func TestV2ConvertsThroughBothArrows(t *testing.T) {
	adapter := loadV2(t, "adapter_v2_synthetic.json")
	cases := []struct {
		input      string
		status     Status
		canonical  string
		candidates []string
		trace      []string
		note       string
	}{
		{
			input: "bɑk4", status: Exact, canonical: "bah7",
			trace: []string{"source_to_ipa:o-b", "source_to_ipa:r-ak", "source_to_ipa:t-4"},
			note:  "source notation → documented IPA → target notation",
		},
		{
			input: "dou453", status: Exact, canonical: "dou3",
			note: "the 凡例 example rime ɔu",
		},
		{
			input: "bɑk4dou453", status: Exact, canonical: "bah7dou3",
			note: "two syllables, each through both arrows",
		},
		{
			input: "ou453", status: Exact, canonical: "ou3",
			note: "the adapter registers its zero onset; the engine does not infer ∅",
		},
		{
			input: "kha533", status: Exact, canonical: "ka1",
			trace: []string{"source_to_ipa:o-kh", "source_to_ipa:r-a", "source_to_ipa:t-533", "ipa_to_target:c-kh"},
			note:  "ASCII kh reaches target kʰ only through a basis-bearing correspondence",
		},
		{
			input: "ko533", status: Exact, canonical: "go1",
			trace: []string{"source_to_ipa:o-k", "source_to_ipa:r-o", "source_to_ipa:t-533", "ipa_to_target:c-o"},
			note:  "a rime correspondence on the second arrow",
		},
		{
			input: "kɑk4", status: Exact, canonical: "kah7",
			trace: []string{"source_to_ipa:o-k", "source_to_ipa:r-ak", "source_to_ipa:t-4", "source_to_ipa:x-k-ak"},
			note:  "a context rule rewrites the source IPA, then the pivot runs",
		},
		{
			input: "lɑk4", status: Reviewed, canonical: "lah7",
			trace: []string{"exception:e-1"},
			note:  "a human conclusion outranks both arrows",
		},
		{
			input: "phɑk4", status: Ambiguous, candidates: []string{"b", "p"},
			note: "a source one-to-many reading answers with target spellings",
		},
		{
			input: "be533", status: Ambiguous, candidates: []string{"e", "ae"},
			note: "the same on the rime side",
		},
		{
			input: "ba0", status: Unsupported,
			note: "a tone with no category declines instead of matching a target contour",
		},
		{
			input: "ma533", status: Unsupported,
			note: "an unregistered source onset is a parse failure on the first arrow",
		},
	}
	for _, tc := range cases {
		t.Run(tc.input, func(t *testing.T) {
			// Repeated so a map-iteration-dependent result would show up here.
			for range 5 {
				result := Convert(tc.input, adapter)
				if result.Status != tc.status {
					t.Fatalf("status = %s, want %s (%s; trace %v)", result.Status, tc.status, tc.note, result.Trace)
				}
				if result.CanonicalPronunciation != tc.canonical {
					t.Fatalf("canonical = %q, want %q (%s; trace %v)", result.CanonicalPronunciation, tc.canonical, tc.note, result.Trace)
				}
				if !slices.Equal(result.Candidates, tc.candidates) {
					t.Fatalf("candidates = %v, want %v (%s)", result.Candidates, tc.candidates, tc.note)
				}
				if tc.trace != nil && !slices.Equal(result.Trace, tc.trace) {
					t.Fatalf("trace = %v, want %v (%s)", result.Trace, tc.trace, tc.note)
				}
				if tc.status != Exact && tc.status != Reviewed && result.CanonicalPronunciation != "" {
					t.Fatalf("%s carried a value: %q", tc.status, result.CanonicalPronunciation)
				}
			}
		})
	}
}

func TestV2DeclineReasonsNameTheirArrow(t *testing.T) {
	adapter := loadV2(t, "adapter_v2_synthetic.json")
	cases := map[string]string{
		"ba0":   "decline:source_to_ipa:missing_tone_category",
		"ma533": "decline:source_to_ipa:source_parse_failed",
	}
	for input, want := range cases {
		result := Convert(input, adapter)
		if len(result.Trace) == 0 || result.Trace[len(result.Trace)-1] != want {
			t.Fatalf("%s: last trace = %v, want %s", input, result.Trace, want)
		}
	}
}

func TestV2ToneCategoryIsNotComparedByValue(t *testing.T) {
	adapter := loadV2(t, "adapter_v2_tone_category.json")
	// The source writes 调类 4 = 阳平. The target's Tone.Value "4" belongs to
	// 阳入 (notation 7); matching on the value would answer 7 or nothing at all.
	result := Convert("ba4", adapter)
	if result.Status != Exact || result.CanonicalPronunciation != "ba2" {
		t.Fatalf("tone class 4 must land on target notation 2: %+v", result)
	}
}
func TestV2ZeroOnsetRowCanBeAbsent(t *testing.T) {
	path := writeAdapterV2(t, func(doc map[string]interface{}) {
		source := doc["source"].(map[string]interface{})
		rows := source["onsets"].([]interface{})
		kept := rows[:0]
		for _, row := range rows {
			if row.(map[string]interface{})["id"] != "o-zero" {
				kept = append(kept, row)
			}
		}
		source["onsets"] = kept
	})
	adapter, err := LoadAdapterWithScheme(path, loadTargetScheme(t))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	result := Convert("ou453", adapter)
	if result.Status != Unsupported {
		t.Fatalf("status = %s, want UNSUPPORTED", result.Status)
	}
	if got := result.Trace[len(result.Trace)-1]; got != "decline:source_to_ipa:zero_onset_row_absent" {
		t.Fatalf("last trace = %s", got)
	}
}

func TestV2ConflictingRewritesAreAmbiguous(t *testing.T) {
	adapter := loadV2(t, "adapter_v2_rewrite_conflict.json")
	result := Convert("ka1", adapter)
	if result.Status != Ambiguous {
		t.Fatalf("status = %s, want AMBIGUOUS", result.Status)
	}
	if result.CanonicalPronunciation != "" {
		t.Fatalf("an ambiguous rewrite carried a value: %q", result.CanonicalPronunciation)
	}
	if got := result.Trace[len(result.Trace)-1]; got != "decline:source_to_ipa:source_rewrite_conflict" {
		t.Fatalf("last trace = %s", got)
	}
}

// An ambiguous answer that only exists because of an equivalence has to name
// that equivalence. #189 locates the records a rule change affects by rule id,
// so an AMBIGUOUS result whose candidate reached the target through c-kh and
// whose trace omits c-kh would hide every record the change breaks.
func TestV2AmbiguousCandidatesKeepTheirCorrespondenceInTheTrace(t *testing.T) {
	path := writeAdapterV2(t, func(doc map[string]interface{}) {
		for _, row := range sourceRows(doc, "onsets") {
			entry := row.(map[string]interface{})
			if entry["id"] == "o-many" {
				// "ph" is documented as either ASCII kh or plain p.
				entry["candidates"] = []interface{}{"kh", "p"}
			}
		}
	})
	adapter, err := LoadAdapterWithScheme(path, loadTargetScheme(t))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	result := Convert("phɑk4", adapter)
	if result.Status != Ambiguous {
		t.Fatalf("status = %s, want AMBIGUOUS", result.Status)
	}
	if !slices.Equal(result.Candidates, []string{"k", "b"}) {
		t.Fatalf("candidates = %v, want [k b]", result.Candidates)
	}
	if !slices.Contains(result.Trace, "ipa_to_target:c-kh") {
		t.Fatalf("trace = %v, want it to carry ipa_to_target:c-kh", result.Trace)
	}
}

// A correspondence that offers several documented readings must not be narrowed
// to the one branch this target can spell: the surviving spelling is a guess
// between readings, so it cannot be EXACT.
func TestV2PartiallyExpressibleCorrespondenceIsNotExact(t *testing.T) {
	path := writeAdapterV2(t, func(doc map[string]interface{}) {
		rows := doc["ipa_correspondences"].([]interface{})
		for _, row := range rows {
			entry := row.(map[string]interface{})
			if entry["id"] == "c-kh" {
				delete(entry, "to")
				// ɡ has no target onset; only kʰ does.
				entry["candidates"] = []interface{}{"kʰ", "ɡ"}
			}
		}
	})
	adapter, err := LoadAdapterWithScheme(path, loadTargetScheme(t))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	result := Convert("kha533", adapter)
	if result.Status != Ambiguous {
		t.Fatalf("status = %s, want AMBIGUOUS; a branch the target cannot spell is not a unique answer", result.Status)
	}
	if result.CanonicalPronunciation != "" {
		t.Fatalf("carried a value: %q", result.CanonicalPronunciation)
	}
	if !slices.Equal(result.Candidates, []string{"k"}) {
		t.Fatalf("candidates = %v, want [k]", result.Candidates)
	}
	if !slices.Contains(result.Trace, "ipa_to_target:c-kh") {
		t.Fatalf("trace = %v, want it to carry ipa_to_target:c-kh", result.Trace)
	}
	if got := result.Trace[len(result.Trace)-1]; got != "decline:ipa_to_target:correspondence_candidate_not_expressible" {
		t.Fatalf("last trace = %s", got)
	}
}
