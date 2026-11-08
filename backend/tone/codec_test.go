package tone

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"
)

type fixtureCase struct {
	Name     string     `json:"name"`
	Input    string     `json:"input"`
	Mode     string     `json:"mode"`
	LegalSet string     `json:"legal_set"`
	Legal    []string   `json:"legal"`
	Missing  []string   `json:"missing_superscripts"`
	Expected Conversion `json:"expected"`
}

type fixtures struct {
	Synthetic    bool              `json:"synthetic"`
	Superscripts map[string]string `json:"superscripts"`
	Cases        []fixtureCase     `json:"cases"`
}

func loadFixtures(t *testing.T) fixtures {
	t.Helper()
	raw, err := os.ReadFile("testdata/codec_cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var data fixtures
	if err := json.Unmarshal(raw, &data); err != nil {
		t.Fatal(err)
	}
	if !data.Synthetic {
		t.Fatal("fixtures must be explicitly synthetic, not language acceptance evidence")
	}
	return data
}

func TestSyntheticCrossLanguageCases(t *testing.T) {
	data := loadFixtures(t)
	doc, err := Rules()
	if err != nil {
		t.Fatal(err)
	}
	source, err := doc.ToneValueScheme("puxian-dict-reading")
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range data.Cases {
		t.Run(row.Name, func(t *testing.T) {
			legal := row.Legal
			if legal == nil {
				legal = source.ToneValueSets[row.LegalSet]
			}
			keyboard := []string{}
			for digit, char := range data.Superscripts {
				missing := false
				for _, absent := range row.Missing {
					if digit == absent {
						missing = true
					}
				}
				if !missing {
					keyboard = append(keyboard, char)
				}
			}
			var actual Conversion
			if row.Mode == "tone_only" {
				actual = ConvertToneOnly(row.Input, legal, SuperscriptMap(keyboard))
			} else {
				actual = Convert(row.Input, legal, SuperscriptMap(keyboard))
			}
			if !reflect.DeepEqual(actual, row.Expected) {
				t.Fatalf("got %#v; want %#v", actual, row.Expected)
			}
			if actual.Status != Exact && (actual.Text != row.Input || len(actual.Tones) != 0) {
				t.Fatal("non-exact result changed original value or reported partial tones")
			}
			if flattenForTest(actual.Text) != flattenForTest(row.Input) {
				t.Fatal("formatting changed something other than superscript digit notation")
			}
		})
	}
}

func flattenForTest(value string) string {
	var out strings.Builder
	for _, char := range value {
		mapped := false
		for digit, point := range superscriptCodepoints {
			if point == char {
				out.WriteByte(byte('0' + digit))
				mapped = true
				break
			}
		}
		if !mapped {
			out.WriteRune(char)
		}
	}
	return out.String()
}

func TestSuperscriptsComeOnlyFromKeyboard(t *testing.T) {
	data := loadFixtures(t)
	values := []string{}
	for _, char := range data.Superscripts {
		values = append(values, char)
	}
	if got := SuperscriptMap(values); !reflect.DeepEqual(got, data.Superscripts) {
		t.Fatalf("Go Unicode codepoints differ from name-derived Python digits: %v", got)
	}
	got := SuperscriptMap([]string{"a", "3", "⁰", "⁵", "³", "⁵³"})
	want := map[string]string{"0": "⁰", "5": "⁵", "3": "³"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v; want %v", got, want)
	}
	if actual := Convert("a533", []string{"533"}, map[string]string{"5": "X", "3": "³"}); actual.Status != Unsupported || actual.Text != "a533" {
		t.Fatal("untrusted output character was emitted")
	}
}

func TestLegalDeclarationValidation(t *testing.T) {
	for _, invalid := range [][]string{nil, {}, {""}, {"01"}, {"10"}, {"6"}, {"５３"}, {"+53"}, {" 53"}, {"1.3"}, {"1234512"}, make([]string, 65)} {
		if _, err := ValidateLegal(invalid); err == nil {
			t.Fatalf("accepted %v", invalid)
		}
	}
	got, err := ValidateLegal([]string{"53", "0", "533", "53", "111111"})
	if err != nil || !reflect.DeepEqual(got, []string{"53", "0", "533", "111111"}) {
		t.Fatalf("got %v: %v", got, err)
	}
}

func TestRulesFreshAndCategoryRefusal(t *testing.T) {
	doc, err := Rules()
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"missing", "puxian-wendu", "puxian-xiangyin"} {
		if _, err := doc.ToneValueScheme(id); err == nil {
			t.Fatalf("accepted unsupported scheme %s", id)
		}
	}
	doc.Schemes["puxian-dict-reading"].ToneValueSets["putian"][0] = "53"
	fresh, err := Rules()
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Schemes["puxian-dict-reading"].ToneValueSets["putian"][0] == "53" {
		t.Fatal("mutating one document changed the embedded rules")
	}
	raw, err := ruleFiles.ReadFile("data/tone_notation.json")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(fresh)
	if err != nil {
		t.Fatal(err)
	}
	var original, roundtrip any
	if err := json.Unmarshal(raw, &original); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(original, roundtrip) {
		t.Fatal("RuleDocument JSON shape lost source metadata")
	}
}

func TestDamagedLongRunDoesNotRecurseOrPartiallyConvert(t *testing.T) {
	value := "a" + strings.Repeat("1", 20000)
	actual := Convert(value, []string{"1", "11"}, SuperscriptMap([]string{"¹"}))
	if actual.Status != Ambiguous || actual.Text != value || !strings.Contains(actual.Reason, "at_least_4_ways") {
		t.Fatalf("unexpected long-run result %s: %s", actual.Status, actual.Reason)
	}
}

func TestInvalidUTF8IsNeverReplaced(t *testing.T) {
	value := "a\xff533"
	for _, convert := range []func(string, []string, map[string]string) Conversion{Convert, ConvertToneOnly} {
		result := convert(value, []string{"533"}, SuperscriptMap([]string{"⁵", "³"}))
		if result.Text != value || result.Status != Unsupported || result.Reason != "invalid_utf8" {
			t.Fatalf("invalid UTF-8 rewritten: %#v", result)
		}
	}
}
