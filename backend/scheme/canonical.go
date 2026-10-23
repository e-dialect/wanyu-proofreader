package scheme

import (
	"encoding/json"
	"fmt"
	"golang.org/x/text/unicode/norm"
	"os"
	"time"
)

// Scheme is a documented target scheme: the inventory a reviewer may pick from,
// with the pronunciation documented for each notation. One row follows this
// project's convention rather than the page's own cell — see Option.IPA.
//
// Why this is a document of its own rather than a section of Adapter: #114 §7
// steers conversion through source notation → documented IPA → target notation,
// so both ends need their pronunciation recorded. The adapter holds the source
// end, which differs book by book; the target end is the same everywhere. Folding
// it into each adapter file would mean N copies of one fact, and the copies are
// exactly what drifts.
//
// It is data only. The engine still reads its inventory from Adapter.Canonical
// (see Inventory); pointing an adapter at this file instead is a later step that
// changes no rule semantics, which is why it is not done here — #189 asks for the
// structure and the material, not for a rewrite of the dispatch it just landed.
type Scheme struct {
	SchemaVersion int        `json:"schema_version"`
	SchemeID      string     `json:"scheme_id"`
	Name          string     `json:"name"`
	Accent        string     `json:"accent"`
	Retrieved     string     `json:"retrieved"`
	Note          string     `json:"note,omitempty"`
	Provenance    []Citation `json:"provenance"`
	Onsets        []Option   `json:"onsets"`
	Rimes         []Option   `json:"rimes"`
	Tones         []Tone     `json:"tones"`
}

// Citation is one place the material came from. It is required, not optional:
// what #189 was blocked on was not a missing table but a missing record of where
// the table lives. That is why the plan doc could only say 零材料 while the
// inventory was published all along.
type Citation struct {
	What    string `json:"what"`
	Locator string `json:"locator"`
}

// Option is one notation plus the pronunciation the source documentation gives
// for it. Example is the source's own example word and is carried verbatim,
// including its spacing: a data file that silently tidies its source is a data
// file nobody can check against that source.
type Option struct {
	Notation string `json:"notation"`
	// IPA is the documented pronunciation, and it is what a source segment is
	// matched against — one value, not the page's cell wherever the two differ.
	//
	// Exactly one row differs. 零声母's cell is "ʔ/不标", an either/or written for a
	// reader, and no source book writes that string; used as a match key it hits
	// neither the glottal stop nor an onset a book leaves unmarked (the page's
	// 不标), so every syllable without an onset — most of them in 莆仙 — would fall
	// to UNSUPPORTED. That row carries this project's own convention ∅ instead and
	// keeps the page's cell in Note. It is the one place in the file where the
	// machine value is not the source's: 一处有说明的归一化，不是照抄。
	IPA     string `json:"ipa"`
	Example string `json:"example,omitempty"`
	Note    string `json:"note,omitempty"`
}

// Tone is one tone class. Notation is the 调号, Value the 调值, Mark the 调符 —
// 莆仙 sources use all three, and Adapter.AnnotationSystem has to declare which
// of the first two a book is writing, so they are kept apart here too rather than
// flattened into the single string most pages print.
type Tone struct {
	Notation string `json:"notation"`
	Category string `json:"category"`
	Value    string `json:"value"`
	Mark     string `json:"mark"`
	Example  string `json:"example,omitempty"`
	Note     string `json:"note,omitempty"`
}

// ErrInvalidScheme marks a target-scheme file that cannot be trusted. Same
// contract as ErrInvalidRule: refuse to load rather than half-enable a scheme,
// because a partially loaded inventory would make stage 6 reject valid syllables.
type ErrInvalidScheme struct{ Reason string }

func (e ErrInvalidScheme) Error() string { return "invalid canonical scheme: " + e.Reason }

// LoadScheme reads and validates one target-scheme file. Like LoadAdapter there
// is no default path: the caller decides where the material lives.
func LoadScheme(path string) (*Scheme, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read canonical scheme %s: %w", path, err)
	}
	doc := &Scheme{}
	if err := json.Unmarshal(raw, doc); err != nil {
		return nil, ErrInvalidScheme{Reason: fmt.Sprintf("%s: %v", path, err)}
	}
	if err := doc.validate(); err != nil {
		return nil, err
	}
	return doc, nil
}

func (s *Scheme) validate() error {
	switch {
	case s.SchemaVersion != 1:
		return ErrInvalidScheme{Reason: fmt.Sprintf("schema_version %d is not supported", s.SchemaVersion)}
	case s.SchemeID == "" || s.Name == "":
		return ErrInvalidScheme{Reason: "scheme_id and name are required"}
	case s.Accent == "":
		// 莆仙 is not one accent, and an inventory documented for one of them
		// silently applied to another is worse than no inventory.
		return ErrInvalidScheme{Reason: "accent is required: an inventory is only valid for the accent it was documented for"}
	case s.Retrieved == "":
		return ErrInvalidScheme{Reason: "retrieved is required"}
	}
	if _, err := time.Parse("2006-01-02", s.Retrieved); err != nil {
		return ErrInvalidScheme{Reason: fmt.Sprintf("retrieved %q is not a YYYY-MM-DD date", s.Retrieved)}
	}
	if len(s.Provenance) == 0 {
		return ErrInvalidScheme{Reason: "provenance is required: an unsourced inventory is what #189 was blocked on"}
	}
	for _, item := range s.Provenance {
		if item.What == "" || item.Locator == "" {
			return ErrInvalidScheme{Reason: "every provenance entry needs a what and a locator"}
		}
	}
	if len(s.Onsets) == 0 || len(s.Rimes) == 0 || len(s.Tones) == 0 {
		return ErrInvalidScheme{Reason: "onsets, rimes and tones are all required"}
	}
	// The zero onset is the one option allowed to have no notation, and only one
	// of them: a rime or tone cannot be empty because splitSyllables requires a
	// non-empty rime before it will read a tone at all.
	if err := checkOptions("onset", s.Onsets, true); err != nil {
		return err
	}
	if err := checkOptions("rime", s.Rimes, false); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, tone := range s.Tones {
		if tone.Notation == "" || tone.Category == "" || tone.Value == "" || tone.Mark == "" {
			return ErrInvalidScheme{Reason: fmt.Sprintf("tone %q needs a notation, category, value and mark", tone.Notation)}
		}
		if err := requireNFC("tone "+tone.Notation+" mark", tone.Mark); err != nil {
			return err
		}
		if seen[tone.Notation] {
			return ErrInvalidScheme{Reason: "duplicate tone notation " + tone.Notation}
		}
		seen[tone.Notation] = true
		// Only the notation must be unique. Two tone classes sharing one contour
		// is a real possibility in these sources, and rejecting it would be this
		// package inventing a constraint the material does not have.
	}
	return nil
}

// requireNFC holds the notations and pronunciations to one encoding.
//
// A tone mark is a letter plus a diacritic, and Unicode gives two ways to write
// that: precomposed (ī, U+012B) or letter plus combining macron (i + U+0304).
// They render identically and diff identically but compare unequal — which is how
// this file first shipped, because the source page uses the decomposed form and
// everything typed from it looked right. Same hazard for the vertical line in ŋ̍.
//
// Adapter.validate normalises user-entered exception values for the same reason;
// here the file itself is the reviewed artifact, so a form that would have to be
// rewritten before it can be compared is refused rather than silently fixed.
// Prose fields are exempt: nothing ever compares them for equality.
func requireNFC(where, value string) error {
	if norm.NFC.String(value) != value {
		return ErrInvalidScheme{Reason: where + " is not in Unicode NFC: " + value +
			" has an encoding that looks the same but compares unequal"}
	}
	return nil
}

// checkOptions enforces what the file itself has to satisfy: one notation per
// part, and at most one unwritten notation, only where the engine can spell one.
//
// A repeated pronunciation is deliberately not one of them. Two notations
// documented with the same reading is a real possibility in these sources, and a
// source segment resolved through IPA then has two equally defensible targets —
// which is the situation #114 §5 gives AMBIGUOUS to, with the candidates kept for
// a reviewer to settle. Refusing the file here would not remove that ambiguity,
// only hide it: the scheme a reviewer most needs to see is exactly the one with a
// homophone in it. So the collision is left in the data and answered with a list
// (see Pivot), and the rule layer decides.
func checkOptions(part string, options []Option, allowZero bool) error {
	notations := map[string]bool{}
	empty := 0
	for _, option := range options {
		if option.Notation == "" {
			if !allowZero {
				return ErrInvalidScheme{Reason: part + " " + option.IPA + " has no notation"}
			}
			if empty++; empty > 1 {
				return ErrInvalidScheme{Reason: "more than one " + part + " has an empty notation"}
			}
		} else if notations[option.Notation] {
			return ErrInvalidScheme{Reason: "duplicate " + part + " notation " + option.Notation}
		}
		notations[option.Notation] = true
		if err := requireNFC(part+" "+option.Notation+" notation", option.Notation); err != nil {
			return err
		}
		if err := requireNFC(part+" "+option.Notation+" ipa", option.IPA); err != nil {
			return err
		}
		if option.IPA == "" {
			return ErrInvalidScheme{Reason: part + " " + option.Notation +
				" has no ipa: the documented pronunciation is the point of this file"}
		}
	}
	return nil
}

// Inventory is the shape Adapter.Canonical wants, so the target end can move
// into an adapter without touching the engine.
//
// The zero onset is dropped, not omitted by accident: the engine spells it as the
// empty string and never looks it up (convert.go's longestPrefix skips empty
// options and legal skips an empty onset), so listing it would make the inventory
// disagree with how syllables are actually parsed.
func (s *Scheme) Inventory() Inventory {
	inv := Inventory{Onsets: []string{}, Rimes: []string{}, ToneValues: []string{}}
	for _, option := range s.Onsets {
		if option.Notation != "" {
			inv.Onsets = append(inv.Onsets, option.Notation)
		}
	}
	for _, option := range s.Rimes {
		inv.Rimes = append(inv.Rimes, option.Notation)
	}
	for _, tone := range s.Tones {
		inv.ToneValues = append(inv.ToneValues, tone.Notation)
	}
	return inv
}

// Pronunciations returns the reading documented for each notation, keyed
// "part:notation", for onsets and rimes. The empty onset is included under
// "onset:" so the map answers for every syllable the inventory can spell.
//
// Tones are not in here, and Tone.Value is not a key anywhere. A tone's 调值 is
// one scheme's record of a 调类 rather than a shared match value — 阴平 is
// documented as 533 in one source, 544 in another and 33 in a third — so matching
// on it would refuse the sources that differ, which is the case the conversion is
// supposed to carry. The tone correspondence is 调号 → 调类 → 调号, and the two
// fields to read for it are Tone.Category and Tone.Notation; a source's own
// numbering is interpreted by that source's 说明 before it reaches this file.
func (s *Scheme) Pronunciations() map[string]string {
	out := make(map[string]string, len(s.Onsets)+len(s.Rimes))
	for _, option := range s.Onsets {
		out["onset:"+option.Notation] = option.IPA
	}
	for _, option := range s.Rimes {
		out["rime:"+option.Notation] = option.IPA
	}
	return out
}

// Pivot is the shape conversion actually needs: documented IPA → the target
// notations that spell it, keyed "part:ipa". It is the second arrow of #114 §7's
// source notation → documented IPA → target notation, read from the target end,
// and it is where the zero onset has to be answered — a source that marks no
// onset lands on ∅ through its own adapter, and ∅ is what the empty notation was
// documented as.
//
// The value is a list rather than one notation because checkOptions lets two
// notations share a reading; when they do, which one is right is the reviewer's
// question, and returning the first would turn AMBIGUOUS into an EXACT that
// nobody actually checked. Every list in the inventory that ships today holds one
// entry — that is a fact about this file, not an invariant of the loader.
func (s *Scheme) Pivot() map[string][]string {
	out := make(map[string][]string, len(s.Onsets)+len(s.Rimes))
	add := func(part string, option Option) {
		key := part + ":" + option.IPA
		out[key] = append(out[key], option.Notation)
	}
	for _, option := range s.Onsets {
		add("onset", option)
	}
	for _, option := range s.Rimes {
		add("rime", option)
	}
	return out
}

// ToneNotationsByCategory is the third arrow's lookup: a source adapter says
// which 调类 its number means, and this answers which target 调号 spells that
// class. It returns a list with the same reasoning as Pivot — a source class the
// target happens to write two ways is AMBIGUOUS, not a reason to pick one.
//
// Tone.Value appears nowhere in the key. 阴平 is documented as 533, 544 and 33 by
// different sources; matching the source's contour against this file's contour
// would refuse exactly the sources the conversion exists to carry. The source's
// own 凡例 is where a number becomes a class, and SourceTone.Category is where
// this engine reads that answer.
func (s *Scheme) ToneNotationsByCategory() map[string][]string {
	out := make(map[string][]string, len(s.Tones))
	for _, tone := range s.Tones {
		out[tone.Category] = append(out[tone.Category], tone.Notation)
	}
	return out
}
