package scheme

import (
	"encoding/json"
	"fmt"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// AdapterSchemaV2 is #189's contract: a source notation is registered with the
// IPA its own 凡例 documents, and conversion asks the target scheme — which
// carries its own documented IPA — to spell that IPA. The two ends are separate
// mappings on purpose: the owner's 2026-10-07 steering rejected giving the v1
// Segment{from,to} row an IPA field, because a row that holds both ends at once
// cannot tell "this book never documented that segment" from "the target scheme
// cannot spell it".
const AdapterSchemaV2 = 2

// Provenance is where one source rule came from. It is deliberately separate
// from the target scheme's Citation list: a source file has to say which book,
// which edition and which pages, because the reader checking it owns the book,
// not the website.
type Provenance struct {
	What    string `json:"what"`
	Locator string `json:"locator"`
}

// SourceSegment is one source notation and the IPA its 凡例 documents. IPA and
// Candidates are mutually exclusive: several documented readings are a real
// outcome, and the engine answers them with AMBIGUOUS instead of picking one.
type SourceSegment struct {
	ID         string   `json:"id"`
	Notation   string   `json:"notation"`
	IPA        string   `json:"ipa,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
	Basis      string   `json:"basis"`
	Example    string   `json:"example,omitempty"`
	Note       string   `json:"note,omitempty"`
}

// SourceTone is a source tone number or contour. Category is the shared key the
// target side answers with, and it is the only thing conversion may use:
// matching on a documented 调值 instead would refuse the sources whose 阴平 is
// 544 or 33, which is exactly the case this layer exists to carry.
//
// A file that knows its tones but not their classes is allowed to say so, and
// then has to say why. That is the state of the two 凡例 in this repository
// today: both mark tones, neither prints a 调值→调类 table.
type SourceTone struct {
	ID                    string `json:"id"`
	Notation              string `json:"notation"`
	Category              string `json:"category,omitempty"`
	MissingCategoryReason string `json:"missing_category_reason,omitempty"`
	Basis                 string `json:"basis"`
	Example               string `json:"example,omitempty"`
	Note                  string `json:"note,omitempty"`
}

type SourceInventoryV2 struct {
	Onsets []SourceSegment `json:"onsets"`
	Rimes  []SourceSegment `json:"rimes"`
	Tones  []SourceTone    `json:"tones"`
}

// SourceContextRule rewrites the source IPA — not the target notation — when a
// documented neighbour is present. That ordering is the steering's: context
// decides how a source notation is read, and the target side is then a lookup.
type SourceContextRule struct {
	ID              string `json:"id"`
	WhenOnset       string `json:"when_onset,omitempty"`
	WhenRime        string `json:"when_rime,omitempty"`
	RewriteOnsetIPA string `json:"rewrite_onset_ipa,omitempty"`
	RewriteRimeIPA  string `json:"rewrite_rime_ipa,omitempty"`
	Basis           string `json:"basis"`
}

// IPACorrespondence is the steering's explicit escape hatch: two documented IPA
// strings that the material itself says are the same sound, e.g. an ASCII "kh"
// in a 凡例 written for a plain text font and the target's "kʰ". It is a data
// row with a basis, never an inferred equivalence; without one the second arrow
// declines.
type IPACorrespondence struct {
	ID         string   `json:"id"`
	Part       string   `json:"part"`
	From       string   `json:"from"`
	To         string   `json:"to,omitempty"`
	Candidates []string `json:"candidates,omitempty"`
	Basis      string   `json:"basis"`
}

// adapterV2File is the on-disk shape. It is a separate struct from Adapter
// because a v2 "source" is a list of rows, while a v1 "source" is a flat
// inventory; one struct cannot read both without guessing.
type adapterV2File struct {
	SchemaVersion    int          `json:"schema_version"`
	SourceScheme     string       `json:"source_scheme_id"`
	CanonicalScheme  string       `json:"canonical_scheme_id"`
	RuleVersion      string       `json:"rule_version"`
	AnnotationSystem string       `json:"annotation_system"`
	RuleStatus       string       `json:"rule_status"`
	RuleStatusBasis  string       `json:"rule_status_basis,omitempty"`
	Coverage         string       `json:"coverage,omitempty"`
	Provenance       []Provenance `json:"provenance,omitempty"`

	Source          SourceInventoryV2   `json:"source"`
	Correspondences []IPACorrespondence `json:"ipa_correspondences,omitempty"`
	Contexts        []SourceContextRule `json:"context_rules,omitempty"`
	Exceptions      []Exception         `json:"exceptions,omitempty"`

	// v1 keys are refused rather than ignored: a file that still carries a
	// hand-written target inventory is a v1 file wearing a v2 number, and
	// silently dropping that block would make the target end ambiguous.
	CanonicalBlock json.RawMessage `json:"canonical,omitempty"`
	SegmentMap     json.RawMessage `json:"segment_map,omitempty"`
}

// compiledV2 is what conversion reads. Slices are ordered deterministically at
// load time; maps are only ever indexed by a key, never ranged for a result.
type compiledV2 struct {
	pivot       map[string][]string
	toneByClass map[string][]string

	sourceOnsets []string
	sourceRimes  []string
	sourceTones  []string

	onsetIPA    map[string]SourceSegment
	rimeIPA     map[string]SourceSegment
	zeroOnset   *SourceSegment
	toneClass   map[string]string
	toneID      map[string]string
	toneMissing map[string]string

	contexts        []SourceContextRule
	correspondences map[string]IPACorrespondence
	exceptions      map[string]Exception

	coverage string
}

func loadAdapterBytes(raw []byte, path string, target *Scheme) (*Adapter, error) {
	var head struct {
		SchemaVersion int `json:"schema_version"`
	}
	if err := json.Unmarshal(raw, &head); err != nil {
		return nil, ErrInvalidRule{Reason: fmt.Sprintf("%s: %v", path, err)}
	}
	switch head.SchemaVersion {
	case 1:
		adapter := &Adapter{}
		if err := json.Unmarshal(raw, adapter); err != nil {
			return nil, ErrInvalidRule{Reason: fmt.Sprintf("%s: %v", path, err)}
		}
		if err := adapter.validateV1(); err != nil {
			return nil, err
		}
		return adapter, nil
	case AdapterSchemaV2:
		if target == nil {
			return nil, ErrInvalidRule{Reason: fmt.Sprintf(
				"%s: schema_version %d maps through the target scheme's documented IPA, so the target scheme has to be supplied; use LoadAdapterWithScheme",
				path, AdapterSchemaV2)}
		}
		file := &adapterV2File{}
		if err := json.Unmarshal(raw, file); err != nil {
			return nil, ErrInvalidRule{Reason: fmt.Sprintf("%s: %v", path, err)}
		}
		return file.compile(path, target)
	default:
		return nil, ErrInvalidRule{Reason: fmt.Sprintf("schema_version %d is not supported", head.SchemaVersion)}
	}
}

func (f *adapterV2File) compile(path string, target *Scheme) (*Adapter, error) {
	if len(f.CanonicalBlock) > 0 {
		return nil, ErrInvalidRule{Reason: path + ": schema_version 2 reads the target inventory from the target scheme; a " +
			"`canonical` block would be a second copy of it"}
	}
	if len(f.SegmentMap) > 0 {
		return nil, ErrInvalidRule{Reason: path + ": schema_version 2 has no segment_map; register `source` rows with their documented IPA instead"}
	}
	if err := validateDeclaration(f.SourceScheme, f.CanonicalScheme, f.RuleVersion, f.AnnotationSystem,
		f.RuleStatus, f.RuleStatusBasis, true); err != nil {
		return nil, err
	}
	if f.SourceScheme == target.SchemeID {
		return nil, ErrInvalidRule{Reason: "source and canonical scheme cannot be the same"}
	}
	if f.CanonicalScheme != target.SchemeID {
		return nil, ErrInvalidRule{Reason: fmt.Sprintf(
			"canonical_scheme_id %q does not match the supplied target scheme %q", f.CanonicalScheme, target.SchemeID)}
	}
	if f.RuleStatus == RuleStatusProduction {
		if len(f.Provenance) == 0 {
			return nil, ErrInvalidRule{Reason: "a production rule set needs provenance: at least one {what, locator} pair"}
		}
		if err := rejectSynthetic(f); err != nil {
			return nil, err
		}
	}
	for _, item := range f.Provenance {
		if item.What == "" || item.Locator == "" {
			return nil, ErrInvalidRule{Reason: "every provenance entry needs a what and a locator"}
		}
	}

	adapter := &Adapter{
		SchemaVersion:    AdapterSchemaV2,
		SourceScheme:     f.SourceScheme,
		CanonicalScheme:  f.CanonicalScheme,
		RuleVersion:      f.RuleVersion,
		AnnotationSystem: f.AnnotationSystem,
		RuleStatus:       f.RuleStatus,
		RuleStatusBasis:  f.RuleStatusBasis,
		Source: Inventory{
			Onsets:     []string{},
			Rimes:      []string{},
			ToneValues: []string{},
		},
		Canonical:  target.Inventory(),
		Exceptions: f.Exceptions,
	}
	// NormalizeCanonical and the exception table still read the compiled
	// target inventories, so fill them even though v2 conversion uses the
	// target Scheme directly.
	adapter.canonicalOnsets = byLengthDesc(adapter.Canonical.Onsets)
	adapter.canonicalRimes = byLengthDesc(adapter.Canonical.Rimes)
	adapter.canonicalTones = byLengthDesc(adapter.Canonical.ToneValues)

	compiled := &compiledV2{
		pivot:           target.Pivot(),
		toneByClass:     target.ToneNotationsByCategory(),
		onsetIPA:        map[string]SourceSegment{},
		rimeIPA:         map[string]SourceSegment{},
		toneClass:       map[string]string{},
		toneID:          map[string]string{},
		toneMissing:     map[string]string{},
		correspondences: map[string]IPACorrespondence{},
		exceptions:      map[string]Exception{},
		coverage:        f.Coverage,
	}

	seenID := map[string]bool{}
	seenNotation := map[string]bool{}
	addSegment := func(part string, rows []SourceSegment, table map[string]SourceSegment, notations *[]string) error {
		for _, row := range rows {
			row.ID = strings.TrimSpace(row.ID)
			row.Notation = norm.NFC.String(strings.TrimSpace(row.Notation))
			row.IPA = norm.NFC.String(strings.TrimSpace(row.IPA))
			for i, candidate := range row.Candidates {
				row.Candidates[i] = norm.NFC.String(strings.TrimSpace(candidate))
			}
			if row.ID == "" {
				return ErrInvalidRule{Reason: "every source " + part + " needs an id"}
			}
			if seenID[row.ID] {
				return ErrInvalidRule{Reason: "duplicate rule id " + row.ID}
			}
			seenID[row.ID] = true
			if row.Basis == "" {
				return ErrInvalidRule{Reason: row.ID + ": a documented reading needs a basis"}
			}
			if row.IPA != "" && len(row.Candidates) > 0 {
				return ErrInvalidRule{Reason: row.ID + ": a one-to-many reading cannot also declare ipa"}
			}
			if row.IPA == "" && len(row.Candidates) == 0 {
				return ErrInvalidRule{Reason: row.ID + ": declares neither ipa nor candidates"}
			}
			if part == "rime" && row.Notation == "" {
				return ErrInvalidRule{Reason: row.ID + ": a rime cannot be empty"}
			}
			if row.Notation == "" && row.IPA != "∅" {
				return ErrInvalidRule{Reason: row.ID + ": the empty onset is the project's zero onset and its ipa must be ∅"}
			}
			key := part + ":" + row.Notation
			if seenNotation[key] {
				return ErrInvalidRule{Reason: "duplicate source " + part + " notation " + row.Notation}
			}
			seenNotation[key] = true
			table[row.Notation] = row
			if row.Notation != "" {
				*notations = append(*notations, row.Notation)
			}
			if part == "onset" && row.Notation == "" {
				copied := row
				compiled.zeroOnset = &copied
			}
		}
		return nil
	}
	if err := addSegment("onset", f.Source.Onsets, compiled.onsetIPA, &compiled.sourceOnsets); err != nil {
		return nil, err
	}
	if err := addSegment("rime", f.Source.Rimes, compiled.rimeIPA, &compiled.sourceRimes); err != nil {
		return nil, err
	}
	for _, tone := range f.Source.Tones {
		tone.ID = strings.TrimSpace(tone.ID)
		tone.Notation = norm.NFC.String(strings.TrimSpace(tone.Notation))
		tone.Category = norm.NFC.String(strings.TrimSpace(tone.Category))
		if tone.ID == "" || tone.Notation == "" {
			return nil, ErrInvalidRule{Reason: "every source tone needs an id and a notation"}
		}
		if seenID[tone.ID] {
			return nil, ErrInvalidRule{Reason: "duplicate rule id " + tone.ID}
		}
		seenID[tone.ID] = true
		if tone.Basis == "" {
			return nil, ErrInvalidRule{Reason: tone.ID + ": a documented reading needs a basis"}
		}
		if tone.Category == "" && tone.MissingCategoryReason == "" {
			return nil, ErrInvalidRule{Reason: tone.ID + ": a tone without a category must say why in missing_category_reason"}
		}
		toneKey := "tone:" + tone.Notation
		if seenNotation[toneKey] {
			return nil, ErrInvalidRule{Reason: "duplicate source tone notation " + tone.Notation}
		}
		seenNotation[toneKey] = true
		if previous, ok := compiled.toneClass[tone.Notation]; ok && previous != tone.Category {
			return nil, ErrInvalidRule{Reason: fmt.Sprintf(
				"source tone %s is registered twice with different classes", tone.Notation)}
		}
		compiled.toneClass[tone.Notation] = tone.Category
		compiled.toneID[tone.Notation] = tone.ID
		if tone.Category == "" {
			compiled.toneMissing[tone.Notation] = tone.MissingCategoryReason
		} else {
			delete(compiled.toneMissing, tone.Notation)
		}
		adapter.Source.ToneValues = append(adapter.Source.ToneValues, tone.Notation)
	}
	adapter.Source.Onsets = append(adapter.Source.Onsets, compiled.sourceOnsets...)
	adapter.Source.Rimes = append(adapter.Source.Rimes, compiled.sourceRimes...)
	adapter.sourceOnsets = byLengthDesc(compiled.sourceOnsets)
	adapter.sourceRimes = byLengthDesc(compiled.sourceRimes)
	adapter.sourceTones = byLengthDesc(adapter.Source.ToneValues)
	compiled.sourceOnsets = adapter.sourceOnsets
	compiled.sourceRimes = adapter.sourceRimes
	compiled.sourceTones = adapter.sourceTones

	for _, rule := range f.Contexts {
		rule.ID = strings.TrimSpace(rule.ID)
		if rule.ID == "" {
			return nil, ErrInvalidRule{Reason: "every context rule needs an id"}
		}
		if seenID[rule.ID] {
			return nil, ErrInvalidRule{Reason: "duplicate rule id " + rule.ID}
		}
		seenID[rule.ID] = true
		if rule.Basis == "" {
			return nil, ErrInvalidRule{Reason: rule.ID + ": a context rule needs a basis"}
		}
		// Normalise first, then judge emptiness. matchesSource reads an empty
		// selector as "any", so a selector written as blanks has to be refused as
		// empty rather than accepted as a wildcard: a rule whose neighbour was
		// only whitespace would otherwise rewrite every syllable in the file.
		rule.WhenOnset = norm.NFC.String(strings.TrimSpace(rule.WhenOnset))
		rule.WhenRime = norm.NFC.String(strings.TrimSpace(rule.WhenRime))
		rule.RewriteOnsetIPA = norm.NFC.String(strings.TrimSpace(rule.RewriteOnsetIPA))
		rule.RewriteRimeIPA = norm.NFC.String(strings.TrimSpace(rule.RewriteRimeIPA))
		if rule.RewriteOnsetIPA == "" && rule.RewriteRimeIPA == "" {
			return nil, ErrInvalidRule{Reason: rule.ID + ": rewrites nothing"}
		}
		if rule.WhenOnset == "" && rule.WhenRime == "" {
			return nil, ErrInvalidRule{Reason: rule.ID + ": names no neighbour, so it can never match"}
		}
		if rule.WhenOnset != "" && !adapter.Source.onsetSet()[rule.WhenOnset] {
			return nil, ErrInvalidRule{Reason: rule.ID + ": when_onset " + rule.WhenOnset + " is not a source onset, so it can never match"}
		}
		if rule.WhenRime != "" && !adapter.Source.rimeSet()[rule.WhenRime] {
			return nil, ErrInvalidRule{Reason: rule.ID + ": when_rime " + rule.WhenRime + " is not a source rime, so it can never match"}
		}
		compiled.contexts = append(compiled.contexts, rule)
	}

	for _, row := range f.Correspondences {
		row.ID = strings.TrimSpace(row.ID)
		row.Part = strings.TrimSpace(row.Part)
		row.From = norm.NFC.String(strings.TrimSpace(row.From))
		row.To = norm.NFC.String(strings.TrimSpace(row.To))
		for i, candidate := range row.Candidates {
			row.Candidates[i] = norm.NFC.String(strings.TrimSpace(candidate))
		}
		if row.ID == "" || row.From == "" {
			return nil, ErrInvalidRule{Reason: "every ipa_correspondence needs an id and a from"}
		}
		if seenID[row.ID] {
			return nil, ErrInvalidRule{Reason: "duplicate rule id " + row.ID}
		}
		seenID[row.ID] = true
		if row.Part != "onset" && row.Part != "rime" {
			return nil, ErrInvalidRule{Reason: row.ID + ": part must be onset or rime"}
		}
		if row.To != "" && len(row.Candidates) > 0 {
			return nil, ErrInvalidRule{Reason: row.ID + ": an equivalence cannot also declare candidates"}
		}
		if row.To == "" && len(row.Candidates) == 0 {
			return nil, ErrInvalidRule{Reason: row.ID + ": declares neither to nor candidates"}
		}
		if row.Basis == "" {
			return nil, ErrInvalidRule{Reason: row.ID + ": an IPA equivalence needs a basis; without one it is a guess"}
		}
		key := row.Part + ":" + row.From
		if previous, ok := compiled.correspondences[key]; ok {
			return nil, ErrInvalidRule{Reason: row.ID + " and " + previous.ID + " both map " + key}
		}
		compiled.correspondences[key] = row
	}

	exceptionKey := map[string]string{}
	for _, item := range f.Exceptions {
		item.ID = strings.TrimSpace(item.ID)
		// The key has to be the string conversion looks up, or the row is dead
		// weight that silently loses to the machine rules: convertV2 normalises
		// and trims the input before indexing this map.
		item.Source = norm.NFC.String(strings.TrimSpace(item.Source))
		if item.ID == "" || item.Source == "" {
			return nil, ErrInvalidRule{Reason: "every exception needs an id and a source_pronunciation"}
		}
		if seenID[item.ID] {
			return nil, ErrInvalidRule{Reason: "duplicate rule id " + item.ID}
		}
		seenID[item.ID] = true
		if item.Status != Exact && item.Status != Reviewed {
			return nil, ErrInvalidRule{Reason: item.ID + ": an exception may only assert EXACT or REVIEWED"}
		}
		if item.Canonical == "" {
			return nil, ErrInvalidRule{Reason: item.ID + ": " + string(item.Status) + " exception carries no value"}
		}
		if item.Status == Reviewed && item.Basis == "" {
			return nil, ErrInvalidRule{Reason: item.ID + ": a human conclusion needs a basis"}
		}
		item.Canonical = norm.NFC.String(item.Canonical)
		key := item.Source
		if previous, ok := exceptionKey[key]; ok {
			return nil, ErrInvalidRule{Reason: fmt.Sprintf(
				"%s and %s are the same source form once normalised, so only one of them can ever be found", previous, item.ID)}
		}
		exceptionKey[key] = item.ID
		if _, ok := adapter.parseCanonical(item.Canonical); !ok {
			return nil, ErrInvalidRule{Reason: item.ID + ": canonical value " + item.Canonical +
				" is not a syllable the target scheme can spell"}
		}
		compiled.exceptions[key] = item
	}

	adapter.v2 = compiled
	return adapter, nil
}

func rejectSynthetic(f *adapterV2File) error {
	check := func(where, value string) error {
		if strings.HasPrefix(strings.ToLower(strings.TrimSpace(value)), "synthetic") {
			return ErrInvalidRule{Reason: where + " is synthetic; a rule set that may drive real jobs cannot cite a fixture"}
		}
		return nil
	}
	for _, item := range f.Provenance {
		if err := check("provenance "+item.What, item.Locator); err != nil {
			return err
		}
	}
	rows := []SourceSegment{}
	rows = append(rows, f.Source.Onsets...)
	rows = append(rows, f.Source.Rimes...)
	for _, row := range rows {
		if err := check(row.ID+" basis", row.Basis); err != nil {
			return err
		}
	}
	for _, tone := range f.Source.Tones {
		if err := check(tone.ID+" basis", tone.Basis); err != nil {
			return err
		}
	}
	for _, rule := range f.Contexts {
		if err := check(rule.ID+" basis", rule.Basis); err != nil {
			return err
		}
	}
	for _, row := range f.Correspondences {
		if err := check(row.ID+" basis", row.Basis); err != nil {
			return err
		}
	}
	for _, item := range f.Exceptions {
		if err := check(item.ID+" basis", item.Basis); err != nil {
			return err
		}
	}
	return check("rule_status_basis", f.RuleStatusBasis)
}

// validateDeclaration is the half both schema versions share: a rule set has to
// say whether it may drive real jobs, and what it declares has to be a contract
// this engine implements.
func validateDeclaration(source, canonical, ruleVersion, annotation, ruleStatus, ruleStatusBasis string, allowToneCategory bool) error {
	switch {
	case source == "" || canonical == "":
		return ErrInvalidRule{Reason: "source_scheme_id and canonical_scheme_id are required"}
	case ruleVersion == "":
		return ErrInvalidRule{Reason: "rule_version is required: traces are meaningless without it"}
	case annotation != ToneValue && !(allowToneCategory && annotation == ToneCategory):
		return ErrInvalidRule{Reason: fmt.Sprintf(
			"annotation_system %q cannot be handled by this engine; %s marks tone classes, not values",
			annotation, ToneCategory)}
	case ruleStatus != RuleStatusTest && ruleStatus != RuleStatusProduction:
		return ErrInvalidRule{Reason: fmt.Sprintf(
			"rule_status must be %q or %q, got %q: a rule set has to say whether it may drive real conversion jobs",
			RuleStatusTest, RuleStatusProduction, ruleStatus)}
	case ruleStatus == RuleStatusProduction && ruleStatusBasis == "":
		return ErrInvalidRule{Reason: "rule_status_basis is required for a production rule set: " +
			"it has to record where its rules and its source documentation came from"}
	}
	return nil
}
