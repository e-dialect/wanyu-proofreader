// Package tone formats declared tone values. It does not map tone categories,
// infer a dialect, normalize Unicode, or approve a linguistic reading.
package tone

import (
	"embed"
	"encoding/json"
	"fmt"
)

// The authoritative reviewable document remains scripts/scheme/data. Python's
// existing unittest checks byte identity with this runtime-embedded copy.
//
//go:embed data/tone_notation.json
var ruleFiles embed.FS

type RuleDocument struct {
	SchemaVersion int                    `json:"schema_version"`
	RuleVersion   string                 `json:"rule_version"`
	Provenance    map[string]any         `json:"provenance"`
	Schemes       map[string]SchemeRules `json:"schemes"`
}

type SchemeRules struct {
	Title               string              `json:"title"`
	AnnotationSystem    string              `json:"annotation_system"`
	Notation            string              `json:"notation"`
	ToneValueSets       map[string][]string `json:"tone_value_sets,omitempty"`
	ColumnToneValueSets map[string]string   `json:"column_tone_value_sets,omitempty"`
	ColumnReason        map[string]string   `json:"column_reason,omitempty"`
	LongTones           []string            `json:"long_tones,omitempty"`
	KnownLoss           []string            `json:"known_loss,omitempty"`
	ToneCategories      []string            `json:"tone_categories,omitempty"`
	WhyThisSchemeIsHere string              `json:"why_this_scheme_is_here,omitempty"`
	InventoryFile       string              `json:"inventory_file,omitempty"`
	Basis               string              `json:"basis,omitempty"`
}

// Rules returns a fresh document so a caller cannot mutate another request's
// rules. Source notes are public rule provenance; no corpus rows are embedded.
func Rules() (RuleDocument, error) {
	var doc RuleDocument
	raw, err := ruleFiles.ReadFile("data/tone_notation.json")
	if err != nil {
		return doc, err
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return doc, err
	}
	if doc.SchemaVersion != 1 || doc.RuleVersion == "" || len(doc.Schemes) == 0 {
		return doc, fmt.Errorf("invalid tone notation rule document")
	}
	for id, body := range doc.Schemes {
		if body.AnnotationSystem == "tone_value" {
			if _, err := doc.ToneValueScheme(id); err != nil {
				return doc, err
			}
		}
	}
	return doc, nil
}

// ToneValueScheme refuses category-based schemes even when their digits look
// identical. Selecting a scheme is the operator's evidence declaration.
func (d RuleDocument) ToneValueScheme(id string) (SchemeRules, error) {
	body, ok := d.Schemes[id]
	if !ok {
		return body, fmt.Errorf("unknown tone notation scheme %q", id)
	}
	if body.AnnotationSystem != "tone_value" {
		return body, fmt.Errorf("scheme %q uses %q, not tone_value", id, body.AnnotationSystem)
	}
	if len(body.ToneValueSets) == 0 || len(body.ColumnToneValueSets) == 0 {
		return body, fmt.Errorf("scheme %q declares no tone value columns", id)
	}
	for name, values := range body.ToneValueSets {
		if _, err := ValidateLegal(values); err != nil {
			return body, fmt.Errorf("scheme %s set %s: %w", id, name, err)
		}
	}
	for column, name := range body.ColumnToneValueSets {
		if _, ok := body.ToneValueSets[name]; !ok {
			return body, fmt.Errorf("scheme %s column %s has unknown tone value set %s", id, column, name)
		}
	}
	return body, nil
}

// ValidateLegal validates a declaration, preserving order and deduplicating exact
// strings. Zero is a complete light tone, never a digit within another contour.
func ValidateLegal(values []string) ([]string, error) {
	if len(values) == 0 || len(values) > 64 {
		return nil, fmt.Errorf("declare between 1 and 64 legal tone values")
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if len(value) == 0 || len(value) > 6 {
			return nil, fmt.Errorf("tone value %q must contain 1 to 6 ASCII digits", value)
		}
		if value != "0" {
			for _, digit := range value {
				if digit < '1' || digit > '5' {
					return nil, fmt.Errorf("tone value %q must be 0 or contain only 1 to 5", value)
				}
			}
		}
		if !seen[value] {
			out = append(out, value)
			seen[value] = true
		}
	}
	return out, nil
}
