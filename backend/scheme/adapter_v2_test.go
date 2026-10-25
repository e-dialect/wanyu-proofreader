package scheme

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

func loadTargetScheme(t *testing.T) *Scheme {
	t.Helper()
	target, err := LoadScheme(filepath.Join("data", "hinghwa_canonical.json"))
	if err != nil {
		t.Fatalf("LoadScheme: %v", err)
	}
	return target
}

func loadV2(t *testing.T, name string) *Adapter {
	t.Helper()
	adapter, err := LoadAdapterWithScheme(filepath.Join("testdata", name), loadTargetScheme(t))
	if err != nil {
		t.Fatalf("LoadAdapterWithScheme(%s): %v", name, err)
	}
	return adapter
}

// writeAdapterV2 mutates the known-good v2 fixture so each rejection case below
// differs from a loadable file in exactly one way.
func writeAdapterV2(t *testing.T, mutate func(map[string]interface{})) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", "adapter_v2_synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := map[string]interface{}{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	mutate(doc)
	path := filepath.Join(t.TempDir(), "adapter_v2.json")
	out, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, out, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func sourceRows(doc map[string]interface{}, part string) []interface{} {
	source := doc["source"].(map[string]interface{})
	return source[part].([]interface{})
}

func TestLoadAdapterRefusesV2WithoutTargetScheme(t *testing.T) {
	_, err := LoadAdapter(filepath.Join("testdata", "adapter_v2_synthetic.json"))
	if err == nil {
		t.Fatal("LoadAdapter loaded a v2 file; the second arrow needs the target scheme")
	}
	if !strings.Contains(err.Error(), "LoadAdapterWithScheme") {
		t.Fatalf("the refusal must name the entry point that can load it, got %v", err)
	}
}

func TestLoadAdapterWithSchemeIgnoresTargetForV1(t *testing.T) {
	adapter, err := LoadAdapterWithScheme(filepath.Join("testdata", "adapter_synthetic.json"), loadTargetScheme(t))
	if err != nil {
		t.Fatalf("a v1 file must still load through the two-argument entry point: %v", err)
	}
	if adapter.SchemaVersion != 1 {
		t.Fatalf("schema version = %d, want 1", adapter.SchemaVersion)
	}
	if result := Convert("pa533", adapter); result.CanonicalPronunciation != "be533" {
		t.Fatalf("v1 conversion changed: %+v", result)
	}
}

func TestV2RefusesRulesThatCouldNeverFire(t *testing.T) {
	_, err := LoadAdapterWithScheme(
		filepath.Join("testdata", "adapter_v2_unreachable_rewrite.json"),
		loadTargetScheme(t),
	)
	if err == nil || !strings.Contains(err.Error(), "can never match") {
		t.Fatalf("an unreachable context rule must be refused at load time, got %v", err)
	}
}

func TestV2Rejections(t *testing.T) {
	target := loadTargetScheme(t)
	cases := []struct {
		name   string
		mutate func(map[string]interface{})
		want   string
	}{
		{
			name: "target mismatch",
			mutate: func(doc map[string]interface{}) {
				doc["canonical_scheme_id"] = "some-other-scheme"
			},
			want: "does not match the supplied target scheme",
		},
		{
			name: "second copy of the target inventory",
			mutate: func(doc map[string]interface{}) {
				doc["canonical"] = map[string]interface{}{
					"onsets": []interface{}{"b"}, "rimes": []interface{}{"a"}, "tone_values": []interface{}{"1"},
				}
			},
			want: "second copy",
		},
		{
			name: "v1 direct mapping",
			mutate: func(doc map[string]interface{}) {
				doc["segment_map"] = []interface{}{}
			},
			want: "no segment_map",
		},
		{
			name: "production citing a fixture",
			mutate: func(doc map[string]interface{}) {
				doc["rule_status"] = "production"
				doc["rule_status_basis"] = "synthetic: declared production for the test"
			},
			want: "cannot cite a fixture",
		},
		{
			name: "production without provenance",
			mutate: func(doc map[string]interface{}) {
				doc["rule_status"] = "production"
				doc["rule_status_basis"] = "a real citation, not synthetic"
				doc["provenance"] = []interface{}{}
			},
			want: "needs provenance",
		},
		{
			name: "tone with no class and no reason",
			mutate: func(doc map[string]interface{}) {
				rows := sourceRows(doc, "tones")
				row := rows[6].(map[string]interface{}) // t-4, which has a category
				row["category"] = ""
			},
			want: "missing_category_reason",
		},
		{
			name: "zero onset inferred rather than registered",
			mutate: func(doc map[string]interface{}) {
				rows := sourceRows(doc, "onsets")
				row := rows[6].(map[string]interface{}) // o-zero
				row["ipa"] = "ʔ"
			},
			want: "must be ∅",
		},
		{
			name: "duplicate source notation",
			mutate: func(doc map[string]interface{}) {
				source := doc["source"].(map[string]interface{})
				source["onsets"] = append(source["onsets"].([]interface{}), map[string]interface{}{
					"id": "o-b-again", "notation": "b", "ipa": "p", "basis": "synthetic",
				})
			},
			want: "duplicate source onset notation",
		},
		{
			name: "one reading declared two ways",
			mutate: func(doc map[string]interface{}) {
				source := doc["source"].(map[string]interface{})
				rows := source["onsets"].([]interface{})
				rows[0].(map[string]interface{})["candidates"] = []interface{}{"p", "pʰ"}
			},
			want: "cannot also declare ipa",
		},
		{
			name: "correspondence without a basis",
			mutate: func(doc map[string]interface{}) {
				rows := doc["ipa_correspondences"].([]interface{})
				rows[0].(map[string]interface{})["basis"] = ""
			},
			want: "needs a basis",
		},
		{
			name: "context rule that names no neighbour",
			mutate: func(doc map[string]interface{}) {
				doc["context_rules"] = []interface{}{map[string]interface{}{
					"id": "x-blank", "rewrite_onset_ipa": "k", "basis": "synthetic",
				}}
			},
			want: "names no neighbour",
		},
		{
			name: "context rule whose neighbour is only whitespace",
			mutate: func(doc map[string]interface{}) {
				doc["context_rules"] = []interface{}{map[string]interface{}{
					"id": "x-blank-neighbour", "when_onset": " \t", "rewrite_onset_ipa": "k", "basis": "synthetic",
				}}
			},
			want: "names no neighbour",
		},
		{
			name: "context rule that only rewrites whitespace",
			mutate: func(doc map[string]interface{}) {
				doc["context_rules"] = []interface{}{map[string]interface{}{
					"id": "x-blank-rewrite", "when_onset": "k", "rewrite_onset_ipa": " ", "basis": "synthetic",
				}}
			},
			want: "rewrites nothing",
		},
		{
			name: "exception whose pronunciation is only whitespace",
			mutate: func(doc map[string]interface{}) {
				doc["exceptions"] = []interface{}{map[string]interface{}{
					"id": "e-blank", "source_pronunciation": "  ", "canonical_pronunciation": "lah7",
					"status": "REVIEWED", "basis": "synthetic",
				}}
			},
			want: "every exception needs an id and a source_pronunciation",
		},
		{
			name: "exception the target cannot spell",
			mutate: func(doc map[string]interface{}) {
				doc["exceptions"] = []interface{}{map[string]interface{}{
					"id": "e-bad", "source_pronunciation": "lɑk4", "canonical_pronunciation": "zzz",
					"status": "EXACT", "basis": "synthetic",
				}}
			},
			want: "not a syllable the target scheme can spell",
		},
		{
			name: "unknown annotation system",
			mutate: func(doc map[string]interface{}) {
				doc["annotation_system"] = "tone_contour"
			},
			want: "tone_category",
		},
		{
			name: "unknown schema version",
			mutate: func(doc map[string]interface{}) {
				doc["schema_version"] = 3
			},
			want: "schema_version 3 is not supported",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := LoadAdapterWithScheme(writeAdapterV2(t, tc.mutate), target)
			if err == nil {
				t.Fatal("the file loaded; it must be refused")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

func TestV2NormalizesSourceIPA(t *testing.T) {
	// The rime is rewritten to the decomposed form a hand transcription produces
	// (o + U+0302). Load must normalise it; the input is the precomposed form.
	path := writeAdapterV2(t, func(doc map[string]interface{}) {
		for _, row := range sourceRows(doc, "rimes") {
			entry := row.(map[string]interface{})
			if entry["id"] == "r-o-circ" {
				entry["notation"] = "ô"
			}
		}
	})
	adapter, err := LoadAdapterWithScheme(path, loadTargetScheme(t))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if _, ok := adapter.v2.rimeIPA["ô"]; !ok {
		t.Fatalf("decomposed source notation did not normalise to NFC: %v", adapter.Source.Rimes)
	}
}

func TestV2NormalizesExceptionSourceLikeItsInput(t *testing.T) {
	// The rule is written by hand with the blanks a copy-paste leaves behind. Its
	// key has to be the string convertV2 looks up, or the row loads and never
	// matches, and the machine rules quietly overrule the human conclusion.
	path := writeAdapterV2(t, func(doc map[string]interface{}) {
		rows := doc["exceptions"].([]interface{})
		rows[0].(map[string]interface{})["source_pronunciation"] = "  lɑk4  "
	})
	adapter, err := LoadAdapterWithScheme(path, loadTargetScheme(t))
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, input := range []string{"lɑk4", " lɑk4 "} {
		result := Convert(input, adapter)
		if result.Status != Reviewed || result.CanonicalPronunciation != "lah7" {
			t.Fatalf("%q: status = %s, canonical = %q; the exception was unreachable", input, result.Status, result.CanonicalPronunciation)
		}
	}
}

func TestToneNotationsByCategory(t *testing.T) {
	target := loadTargetScheme(t)
	got := target.ToneNotationsByCategory()
	for category, notation := range map[string]string{
		"阴平": "1", "阳平": "2", "上声": "3", "阴去": "4", "阳去": "5", "阴入": "6", "阳入": "7",
	} {
		if !slices.Equal(got[category], []string{notation}) {
			t.Fatalf("%s = %v, want [%s]", category, got[category], notation)
		}
	}
}
