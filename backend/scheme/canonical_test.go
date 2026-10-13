package scheme

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
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
	// The three names are pinned rather than merely non-empty because they answer
	// three different questions and are easy to conflate: the id is the repo's
	// (#189's working name, referenced by adapter files), the name is the page's
	// own 定名, and the accent is what neither of the other two tells you —
	// 「莆仙话拼音」 reads as covering 莆仙, while the page says 莆田城里口音.
	if doc.SchemeID != "puxian-xiangyin" {
		t.Errorf("scheme_id = %q, want puxian-xiangyin", doc.SchemeID)
	}
	if doc.Name != "莆仙话拼音" {
		t.Errorf("name = %q, want the page's own 定名 莆仙话拼音", doc.Name)
	}
	if doc.Accent != "莆田城里口音" {
		t.Errorf("accent = %q, want 莆田城里口音", doc.Accent)
	}
	if len(doc.Provenance) == 0 {
		t.Error("no provenance, which is the gap #189 was actually blocked on")
	}
}

// #189 asks for the target side's basis to name the page, its 定名, its 口径 and
// the date it was read. Splitting the id from the name is what makes the missing
// half visible: a scheme called 莆仙话拼音 with no accent would be applied to
// 仙游 idioms it was never documented for.
func TestHinghwaProvenancePointsAtThePageThatNamesIt(t *testing.T) {
	doc := loadHinghwa(t)
	var locales string
	for _, item := range doc.Provenance {
		locales += item.What + " " + item.Locator + "\n"
	}
	for _, want := range []string{"https://hinghwa.cn/pinyin", "莆仙话拼音", "莆田城里口音"} {
		if !strings.Contains(locales, want) {
			t.Errorf("provenance never mentions %q", want)
		}
	}
	if doc.Retrieved == "" {
		t.Error("retrieved is empty, so a reader cannot tell which revision of the page this is")
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
		// 零声母 is the one cell the file does not copy: the page prints the
		// either/or "ʔ/不标", and the machine value is this project's ∅. The page's
		// own cell is checked where it is kept — in that row's note.
		{"onset", "", "∅"},
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

// Not a loader invariant — checkOptions now accepts a repeated reading on purpose
// — but a fact about the file that ships, and one conversion leans on: while every
// reading has a single notation, resolving a source segment through IPA gives one
// target and needs no reviewer. If this fails, the inventory gained a homophone:
// Pivot answers with two candidates and the failure message is the notice, not a
// defect to repair.
func TestHinghwaIPAIsUniqueInsideEachPart(t *testing.T) {
	doc := loadHinghwa(t)
	for _, part := range []struct {
		name    string
		options []Option
	}{{"onset", doc.Onsets}, {"rime", doc.Rimes}} {
		seen := map[string]string{}
		for _, option := range part.options {
			if previous, ok := seen[option.IPA]; ok {
				t.Errorf("%s %q and %q are both documented as %q, so Pivot answers with a list of two here",
					part.name, previous, option.Notation, option.IPA)
				continue
			}
			seen[option.IPA] = option.Notation
		}
	}
}

// The page prints 零声母's IPA as "ʔ/不标", an either/or written for a reader: no
// source book writes that string. As the value a source segment is resolved
// through it matches neither ʔ nor an onset left unmarked, so every syllable
// without an onset — most of them in 莆仙 — would be refused. The file therefore
// records this project's own convention ∅ as the machine value and keeps the
// page's cell in the note, and this test is the whole of that bargain: the machine
// answers for ∅, the display string is not a key, the page's cell is still
// readable, and the glottal stop the page describes survives everywhere it is a
// segment rather than a category.
func TestHinghwaZeroOnsetUsesTheProjectConvention(t *testing.T) {
	doc := loadHinghwa(t)
	zero, ok := findOption(doc, "onset", "")
	if !ok {
		t.Fatal("the zero onset is missing from the inventory")
	}
	if zero.IPA != "∅" {
		t.Errorf("zero onset ipa = %q, want the project's ∅: the page's cell is a display string, not a reading", zero.IPA)
	}
	// Keeping the cell is what makes a normalized value acceptable at all: the
	// page's own text has to be readable here, next to the value that replaced it.
	if !strings.Contains(zero.Note, "ʔ/不标") {
		t.Errorf("the zero onset's note no longer carries the page's own cell %q: %q", "ʔ/不标", zero.Note)
	}
	pivot := doc.Pivot()
	if got, ok := pivot["onset:∅"]; !ok || !slices.Equal(got, []string{""}) {
		t.Errorf("Pivot()[onset:∅] = %q (present %v), want the empty notation: ∅ is what the unwritten onset is documented as",
			got, ok)
	}
	// The display string is exactly what must not be a key: if it ever becomes one,
	// the machine value has been reshaped to quote the page instead of to be used.
	if got, ok := pivot["onset:ʔ/不标"]; ok {
		t.Errorf("Pivot() answers for the page's display string ʔ/不标 (= %q); it is a cell, not a reading", got)
	}
	// And no other part inherits ∅: there is no unwritten rime.
	if got, ok := pivot["rime:∅"]; ok {
		t.Errorf("Pivot()[rime:∅] = %q, want no such key", got)
	}
	// Normalizing the onset is not a global ʔ replacement. In these cells ʔ is a
	// segment — the 塞尾 half of the 韵母 table — and it stays one.
	for _, notation := range []string{"ah", "oh", "uh", "uoh"} {
		option, ok := findOption(doc, "rime", notation)
		if !ok {
			t.Fatalf("rime %q is missing from the inventory", notation)
		}
		if !strings.HasSuffix(option.IPA, "ʔ") {
			t.Errorf("rime %q ipa = %q, want a glottal-stop coda kept: the zero onset's normalization must not reach the rimes",
				notation, option.IPA)
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
		// that is what the engine looks up when a syllable has no onset — and its
		// reading is this project's ∅, not the page's display cell.
		{key: "onset:", want: "∅"},
		{key: "onset:s", want: "ɬ"},
		{key: "onset:ng-", want: "ŋ"},
		{key: "rime:ng", want: "ŋ̍"},
		{key: "rime:oeng", want: "œŋ"},
		{key: "rime:orng", want: "ɒŋ"},
		{key: "rime:ieng", want: "iɛŋ"},
		{key: "rime:uoh", want: "uoʔ"},
		{key: "rime:ieo", want: "ieu"},
		{key: "rime:uh", want: "uʔ"},
		// Tones are not in this map at all. A 调值 is one source's record of a
		// 调类, not a value two sources can be matched on — 阴平 is 533 in one, 544
		// in another — so the correspondence is read off Tones by category instead
		// (see TestHinghwaToneCategoriesNameTheToneNotations).
		{key: "tone:1", absent: true},
		{key: "tone:533", absent: true},
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
	for key := range ipa {
		if strings.HasPrefix(key, "tone:") {
			t.Errorf("Pronunciations() carries %q: Tone.Value is not a shared match key", key)
		}
	}
}

// 调类 is the join key of the tone half of the conversion: a source's own 调号 or
// 调值 is interpreted by that source's 说明 and resolved to a 调类, and the 调类
// names the target 调号 here. Written as a table rather than a presence check
// because the seven rows are the page's own division — a slipped row would still
// leave seven of them, and would silently answer for the wrong tone class.
func TestHinghwaToneCategoriesNameTheToneNotations(t *testing.T) {
	doc := loadHinghwa(t)
	want := map[string]string{
		"阴平": "1", "阳平": "2", "上声": "3", "阴去": "4",
		"阳去": "5", "阴入": "6", "阳入": "7",
	}
	if len(doc.Tones) != len(want) {
		t.Fatalf("tones = %d, want %d", len(doc.Tones), len(want))
	}
	seen := map[string]string{}
	for _, tone := range doc.Tones {
		if got, ok := want[tone.Category]; !ok || got != tone.Notation {
			t.Errorf("调类 %q maps to 调号 %q, want %q", tone.Category, tone.Notation, want[tone.Category])
		}
		// Same standing as TestHinghwaIPAIsUniqueInsideEachPart: a fact about the
		// file, not a rule checkOptions enforces. A repeated 调类 would put two
		// target 调号 behind one key, which is a candidate list, not a defect.
		if previous, ok := seen[tone.Category]; ok {
			t.Errorf("调类 %q is used by both 调号 %q and %q, so it no longer names one target",
				tone.Category, previous, tone.Notation)
		}
		seen[tone.Category] = tone.Notation
	}
}

// The same relation read the way conversion reads it, in both directions: every
// candidate Pivot names has to be a notation Pronunciations knows, spelled the way
// Pronunciations spells it, and every notation has to be reachable from Pivot. A
// segment that resolves one way and not the other is a dead rule waiting to be
// written into an adapter.
//
// The two counts agree because this file documents each reading once. With a
// homophone Pivot would hold the shorter map, with a list of two on that key —
// which is what TestSchemeLoadsWhenTwoNotationsShareAReading pins down.
func TestSchemePivotInvertsPronunciations(t *testing.T) {
	doc := loadHinghwa(t)
	reached := map[string]bool{}
	for key, notations := range doc.Pivot() {
		part, form, _ := strings.Cut(key, ":")
		for _, notation := range notations {
			if got := doc.Pronunciations()[part+":"+notation]; got != form {
				t.Errorf("Pivot() sends %q to %s %q, but Pronunciations() says that notation is %q",
					key, part, notation, got)
			}
			reached[part+":"+notation] = true
		}
	}
	for key := range doc.Pronunciations() {
		if !reached[key] {
			t.Errorf("Pronunciations() has %q, which Pivot() never answers with", key)
		}
	}
	if got, want := len(doc.Pivot()), len(doc.Pronunciations()); got != want {
		t.Errorf("Pivot() = %d keys, Pronunciations() = %d: they agree only while no reading is shared", got, want)
	}
}

// The loader's side of that decision, and the reason it is a decision rather than
// an oversight: a scheme whose material really does document one reading twice is
// not a broken file. Refusing it would not remove the ambiguity — it would keep
// the scheme out of the repository, where no reviewer ever sees it — so the file
// loads and Pivot answers with both candidates for the rule layer to weigh.
func TestSchemeLoadsWhenTwoNotationsShareAReading(t *testing.T) {
	// b and p are the first two onsets; giving p the reading of b makes them a
	// homophone pair without inventing a row.
	doc := loadMutatedScheme(t, func(doc map[string]any) {
		options, _ := doc["onsets"].([]any)
		entry, _ := options[1].(map[string]any)
		entry["ipa"] = "p"
	})
	if got := doc.Pivot()["onset:p"]; !slices.Equal(got, []string{"b", "p"}) {
		t.Errorf("Pivot()[onset:p] = %q, want both candidates in file order: neither is more correct than the other", got)
	}
	if got := doc.Pronunciations()["onset:b"]; got != "p" {
		t.Errorf("Pronunciations()[onset:b] = %q, want p", got)
	}
	// The count is the whole shape of it: two spellings, one reading, so the
	// reverse map is one key shorter than the forward one.
	if got, want := len(doc.Pivot()), len(doc.Pronunciations())-1; got != want {
		t.Errorf("Pivot() = %d keys, want %d: one shared reading collapses two notations into one key", got, want)
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
		// The notation side of the same guard. Without this case, deleting the
		// requireNFC call on the notation leaves the whole table green — the ipa
		// half of the guard keeps every other row reachable — so the notation half
		// was an untested promise.
		{"a decomposed rime notation", withOption("rimes", 0, func(o map[string]any) { o["notation"] = "a\u0301" }), "is not in Unicode NFC"},
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

func writeMutated(t *testing.T, mutate func(map[string]any)) string {
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
	return path
}

// loadMutated is for the files that must be refused: the caller only ever wants
// the error.
func loadMutated(t *testing.T, mutate func(map[string]any)) error {
	t.Helper()
	_, loadErr := LoadScheme(writeMutated(t, mutate))
	return loadErr
}

// loadMutatedScheme is the other half — a mutation the loader must accept. Keeping
// both means an "allowed" case is written the same way as a rejected one, so the
// difference between them is the rule and not the fixture.
func loadMutatedScheme(t *testing.T, mutate func(map[string]any)) *Scheme {
	t.Helper()
	doc, err := LoadScheme(writeMutated(t, mutate))
	if err != nil {
		t.Fatalf("LoadScheme refused a file it must accept: %v", err)
	}
	return doc
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
