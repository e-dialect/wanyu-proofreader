package scheme

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const hinghwaPath = "data/hinghwa_canonical.json"

// loadHinghwa reads the real inventory. Every test below runs against the file
// that ships, not against a fixture written to make the assertions pass: the
// whole point of the file is that its contents are checkable against the source
// it cites, and a parallel fixture would be checkable against nothing.
func loadHinghwa(t *testing.T) *Scheme {
	t.Helper()
	doc, err := LoadScheme(hinghwaPath)
	if err != nil {
		t.Fatalf("LoadScheme(%s): %v", hinghwaPath, err)
	}
	return doc
}

func TestHinghwaSchemeLoadsWithTheDocumentedInventory(t *testing.T) {
	doc := loadHinghwa(t)

	// 声母 15，韵母 44（开尾 19 + 鼻尾 12 + 塞尾 13），声调 7. These three
	// numbers are the whole of what the page publishes, so a wrong count means
	// the extraction silently dropped or duplicated rows.
	if len(doc.Onsets) != 15 {
		t.Errorf("onsets = %d, want 15", len(doc.Onsets))
	}
	if len(doc.Rimes) != 44 {
		t.Errorf("rimes = %d, want 44", len(doc.Rimes))
	}
	if len(doc.Tones) != 7 {
		t.Errorf("tones = %d, want 7", len(doc.Tones))
	}
	if doc.Accent == "" || doc.Name == "" || doc.SchemeID == "" {
		t.Errorf("scheme is not identified: id=%q name=%q accent=%q", doc.SchemeID, doc.Name, doc.Accent)
	}
	if len(doc.Provenance) == 0 {
		t.Error("no provenance, which is the gap #189 was actually blocked on")
	}
}

// The page's own IPA, spot-checked where a plausible transcription error would
// be invisible: ɬ for s and ŋ̍ for the syllabic ng are both unusual enough that
// a file could carry pinyin letters in those slots and still look right.
func TestHinghwaSchemeCarriesTheSourcesOwnIPA(t *testing.T) {
	doc := loadHinghwa(t)
	cases := []struct{ part, notation, ipa string }{
		{"onset", "b", "p"},   // 不送气清音写作 b
		{"onset", "p", "pʰ"},  // 送气靠 -h，靠 ASCII h
		{"onset", "s", "ɬ"},   // 边擦音，不是 s
		{"onset", "ng-", "ŋ"}, // 这一行在页面上带连字符
		{"onset", "", "ʔ/不标"},
		{"rime", "or", "ɒ"}, // ɒ 与 o 在这一页是不同的两行
		{"rime", "o", "o"},
		{"rime", "ng", "ŋ̍"}, // 成音节鼻音
		{"rime", "uh", "uʔ"},
		{"rime", "uang", "uaŋ"},
	}
	for _, c := range cases {
		option, ok := findOption(doc, c.part, c.notation)
		if !ok {
			t.Errorf("%s %q is missing from the inventory", c.part, c.notation)
			continue
		}
		if option.IPA != c.ipa {
			t.Errorf("%s %q ipa = %q, want %q", c.part, c.notation, option.IPA, c.ipa)
		}
	}
}

func TestHinghwaTonesKeepNotationValueAndMarkApart(t *testing.T) {
	doc := loadHinghwa(t)
	// The page prints 调值 and 调符 as one string ("533 gī") and never prints the
	// 调号; the file has to hold all three separately because
	// Adapter.AnnotationSystem has to say which of 调值/调类 a source writes.
	//
	// The marks below are written precomposed (gī = g + U+012B). The source page
	// writes the same seven as g + U+0304 and so on, which renders and diffs
	// identically — so if these two ever disagree the failure message will show
	// two strings that look the same. LoadScheme's NFC check fires first and says
	// which encoding is wrong; this literal is the second line of defence.
	want := []struct{ notation, category, value, mark string }{
		{"1", "阴平", "533", "gī"},
		{"2", "阳平", "13", "gí"},
		{"3", "上声", "453", "gî"},
		{"4", "阴去", "42", "gì"},
		{"5", "阳去", "11", "gĭ"},
		{"6", "阴入", "21", "gĭh"},
		{"7", "阳入", "4", "gíh"},
	}
	if len(doc.Tones) != len(want) {
		t.Fatalf("tones = %d, want %d", len(doc.Tones), len(want))
	}
	for i, expected := range want {
		got := doc.Tones[i]
		if got.Notation != expected.notation || got.Category != expected.category ||
			got.Value != expected.value || got.Mark != expected.mark {
			t.Errorf("tone %d = %s/%s/%s/%s, want %s/%s/%s/%s",
				i, got.Notation, got.Category, got.Value, got.Mark,
				expected.notation, expected.category, expected.value, expected.mark)
		}
	}
}

// The invariant the IPA pivot rests on, stated as a test rather than left inside
// checkOptions: if this ever stops holding for the shipped file, conversion
// through IPA has no defined answer and the file has to be fixed, not the check.
func TestHinghwaIPAIsUniqueInsideEachPart(t *testing.T) {
	doc := loadHinghwa(t)
	for _, part := range []struct {
		name    string
		options []Option
	}{{"onset", doc.Onsets}, {"rime", doc.Rimes}} {
		seen := map[string]string{}
		for _, option := range part.options {
			if previous, ok := seen[option.IPA]; ok {
				t.Errorf("%s %q and %q are both documented as %q",
					part.name, previous, option.Notation, option.IPA)
				continue
			}
			seen[option.IPA] = option.Notation
		}
	}
}

func TestSchemeInventoryDropsTheZeroOnset(t *testing.T) {
	doc := loadHinghwa(t)
	inv := doc.Inventory()
	if len(inv.Onsets) != 14 {
		t.Errorf("Inventory().Onsets = %d entries, want 14: the 15 documented onsets include 零声母, which the engine spells as the empty string", len(inv.Onsets))
	}
	for _, onset := range inv.Onsets {
		if onset == "" {
			t.Fatal("Inventory().Onsets contains the empty string: longestPrefix skips empty options, so this can never match")
		}
	}
	if len(inv.Rimes) != 44 || len(inv.ToneValues) != 7 {
		t.Errorf("Inventory() = %d rimes / %d tone values, want 44 / 7", len(inv.Rimes), len(inv.ToneValues))
	}
}

func TestSchemePronunciationsCoverEverySpelling(t *testing.T) {
	doc := loadHinghwa(t)
	ipa := doc.Pronunciations()
	cases := []struct {
		key    string
		want   string
		absent bool
	}{
		// The zero onset is reached as "onset:" with nothing after the colon —
		// that is what the engine looks up when a syllable has no onset.
		{key: "onset:", want: "ʔ/不标"},
		{key: "onset:s", want: "ɬ"},
		{key: "onset:ng-", want: "ŋ"},
		{key: "rime:ng", want: "ŋ̍"},
		{key: "rime:oeng", want: "œŋ"},
		{key: "rime:orng", want: "ɒŋ"},
		{key: "rime:ieng", want: "iɛŋ"},
		{key: "rime:uoh", want: "uoʔ"},
		{key: "rime:ieo", want: "ieu"},
		{key: "rime:uh", want: "uʔ"},
		{key: "tone:1", want: "533"},
		{key: "tone:7", want: "4"},
		// ng is a rime here, not an onset: 硬 nge5 is onset ng- plus rime e.
		{key: "onset:ng", absent: true},
		{key: "rime:not-a-rime", absent: true},
	}
	for _, c := range cases {
		got, ok := ipa[c.key]
		if c.absent {
			if ok {
				t.Errorf("Pronunciations() has %q = %q, which the inventory does not contain", c.key, got)
			}
			continue
		}
		if !ok || got != c.want {
			t.Errorf("Pronunciations()[%q] = %q (present %v), want %q", c.key, got, ok, c.want)
		}
	}
}

// The negative cases are built by mutating the real file, so a defect added to
// the shipped inventory is the same defect these tests already reject.
func TestSchemeRejectsBrokenFiles(t *testing.T) {
	withOption := func(part string, index int, mutate func(map[string]any)) func(map[string]any) {
		return func(doc map[string]any) {
			options, _ := doc[part].([]any)
			entry, _ := options[index].(map[string]any)
			mutate(entry)
		}
	}
	cases := []struct {
		name   string
		mutate func(map[string]any)
		want   string
	}{
		{"two rimes on one ipa", withOption("rimes", 1, func(o map[string]any) { o["ipa"] = "a" }), "are documented as"},
		{"a rime with no ipa", withOption("rimes", 0, func(o map[string]any) { delete(o, "ipa") }), "has no ipa"},
		{"two rimes on one notation", withOption("rimes", 1, func(o map[string]any) { o["notation"] = "a" }), "duplicate rime notation"},
		{"a rime with no notation", withOption("rimes", 0, func(o map[string]any) { o["notation"] = "" }), "has no notation"},
		{"two zero onsets", withOption("onsets", 1, func(o map[string]any) { o["notation"] = "" }), "more than one onset"},
		{"two tones on one notation", withOption("tones", 1, func(o map[string]any) { o["notation"] = "1" }), "duplicate tone notation"},
		{"a tone with no mark", withOption("tones", 0, func(o map[string]any) { delete(o, "mark") }), "value and mark"},
		{"no provenance", func(doc map[string]any) { doc["provenance"] = []any{} }, "provenance is required"},
		{"a citation with no locator", func(doc map[string]any) {
			doc["provenance"] = []any{map[string]any{"what": "某页"}}
		}, "what and a locator"},
		{"no accent", func(doc map[string]any) { delete(doc, "accent") }, "accent is required"},
		{"a date that is not a date", func(doc map[string]any) { doc["retrieved"] = "2026/10" }, "is not a YYYY-MM-DD date"},
		{"no tones at all", func(doc map[string]any) { doc["tones"] = []any{} }, "tones are all required"},
		// "g" + U+0304 renders exactly like gī and used to be what this file
		// shipped, because the source page writes the decomposed form.
		{"a decomposed tone mark", withOption("tones", 0, func(o map[string]any) { o["mark"] = "g\u0304" }), "is not in Unicode NFC"},
		{"a decomposed onset ipa", withOption("onsets", 0, func(o map[string]any) { o["ipa"] = "a\u0301" }), "is not in Unicode NFC"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := loadMutated(t, c.mutate)
			if err == nil {
				t.Fatal("LoadScheme accepted the file")
			}
			var invalid ErrInvalidScheme
			if !errors.As(err, &invalid) {
				t.Fatalf("error is %T (%v), want ErrInvalidScheme", err, err)
			}
			if !strings.Contains(invalid.Reason, c.want) {
				t.Errorf("reason %q does not mention %q", invalid.Reason, c.want)
			}
		})
	}
}

func loadMutated(t *testing.T, mutate func(map[string]any)) error {
	t.Helper()
	raw, err := os.ReadFile(hinghwaPath)
	if err != nil {
		t.Fatalf("read %s: %v", hinghwaPath, err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("decode %s: %v", hinghwaPath, err)
	}
	mutate(doc)
	patched, err := json.Marshal(doc)
	if err != nil {
		t.Fatalf("encode mutated %s: %v", hinghwaPath, err)
	}
	path := filepath.Join(t.TempDir(), "hinghwa_canonical.json")
	if err := os.WriteFile(path, patched, 0o600); err != nil {
		t.Fatalf("write mutated scheme: %v", err)
	}
	_, loadErr := LoadScheme(path)
	return loadErr
}

func findOption(doc *Scheme, part, notation string) (Option, bool) {
	var options []Option
	switch part {
	case "onset":
		options = doc.Onsets
	case "rime":
		options = doc.Rimes
	}
	for _, option := range options {
		if option.Notation == notation {
			return option, true
		}
	}
	return Option{}, false
}
