package scheme

import (
	"strings"

	"golang.org/x/text/unicode/norm"
)

// convertV2 is #189's pipeline. The two arrows are deliberately visible in the
// trace, because the failures they produce are different failures with different
// owners: "this book never documented that segment" is a missing source page,
// while "the target scheme cannot spell this IPA" is a missing target row. A
// single decline code would send the reviewer to the wrong file.
//
// The stage order is the steering doc's:
//
//	source notation → documented IPA → target notation
//
// Context rules rewrite the source IPA (stage 2), never the target notation:
// sandhi is a claim about how the source reads, and applying it after the pivot
// would silently invent target rows.
func convertV2(input string, adapter *Adapter) Result {
	compiled := adapter.v2
	result := Result{
		SourceScheme:        adapter.SourceScheme,
		SourcePronunciation: input,
		CanonicalScheme:     adapter.CanonicalScheme,
		RuleVersion:         adapter.RuleVersion,
		Status:              Exact,
		Trace:               []string{},
	}
	corrected := norm.NFC.String(strings.TrimSpace(input))

	// A human conclusion outranks both arrows. It is stored here rather than in
	// the target scheme because it is a statement about this source, and it is
	// prefixed in the trace so a reader can tell it did not come from a rule row.
	if item, ok := compiled.exceptions[corrected]; ok {
		result.Status = item.Status
		result.CanonicalPronunciation = item.Canonical
		result.Trace = append(result.Trace, "exception:"+item.ID)
		return result
	}

	syllables, ok := splitSyllables(corrected, compiled.sourceOnsets, compiled.sourceRimes, compiled.sourceTones)
	if !ok {
		return decline(result, Unsupported, "source_to_ipa:source_parse_failed")
	}

	parts := make([]string, 0, len(syllables))
	for _, unit := range syllables {
		onsetIPA, rimeIPA, category, accepted, candidates, reason := sourceIPA(compiled, unit)
		result.Trace = append(result.Trace, accepted...)
		switch reason {
		case "":
		case "source_segment_one_to_many":
			result.Candidates = append(result.Candidates, candidates...)
			return decline(result, Ambiguous, "source_to_ipa:"+reason)
		default:
			return decline(result, Unsupported, "source_to_ipa:"+reason)
		}
		if category == "" {
			return decline(result, Unsupported, "source_to_ipa:missing_tone_category")
		}

		// The context stage reads the source notation and writes the source IPA.
		var onsetSeen, rimeSeen bool
		for _, rule := range compiled.contexts {
			if !rule.matchesSource(unit) {
				continue
			}
			if rule.RewriteOnsetIPA != "" {
				if onsetSeen && onsetIPA != rule.RewriteOnsetIPA {
					result.Trace = append(result.Trace, "source_to_ipa:"+rule.ID)
					return decline(result, Ambiguous, "source_to_ipa:source_rewrite_conflict")
				}
				onsetIPA, onsetSeen = rule.RewriteOnsetIPA, true
			}
			if rule.RewriteRimeIPA != "" {
				if rimeSeen && rimeIPA != rule.RewriteRimeIPA {
					result.Trace = append(result.Trace, "source_to_ipa:"+rule.ID)
					return decline(result, Ambiguous, "source_to_ipa:source_rewrite_conflict")
				}
				rimeIPA, rimeSeen = rule.RewriteRimeIPA, true
			}
			result.Trace = append(result.Trace, "source_to_ipa:"+rule.ID)
		}

		targetOnsets, onsetTrace, unexpressibleOnsets := compiled.targetNotations("onset", onsetIPA)
		result.Trace = append(result.Trace, prefixAll("ipa_to_target:", onsetTrace)...)
		if len(targetOnsets) == 0 {
			return decline(result, Unsupported, "ipa_to_target:no_target_onset_for_ipa")
		}
		if len(unexpressibleOnsets) > 0 {
			result.Candidates = append(result.Candidates, targetOnsets...)
			return decline(result, Ambiguous, "ipa_to_target:correspondence_candidate_not_expressible")
		}
		if len(targetOnsets) > 1 {
			result.Candidates = append(result.Candidates, targetOnsets...)
			return decline(result, Ambiguous, "ipa_to_target:target_segment_one_to_many")
		}

		targetRimes, rimeTrace, unexpressibleRimes := compiled.targetNotations("rime", rimeIPA)
		result.Trace = append(result.Trace, prefixAll("ipa_to_target:", rimeTrace)...)
		if len(targetRimes) == 0 {
			return decline(result, Unsupported, "ipa_to_target:no_target_rime_for_ipa")
		}
		if len(unexpressibleRimes) > 0 {
			result.Candidates = append(result.Candidates, targetRimes...)
			return decline(result, Ambiguous, "ipa_to_target:correspondence_candidate_not_expressible")
		}
		if len(targetRimes) > 1 {
			result.Candidates = append(result.Candidates, targetRimes...)
			return decline(result, Ambiguous, "ipa_to_target:target_segment_one_to_many")
		}

		targetTones := compiled.toneByClass[category]
		if len(targetTones) == 0 {
			return decline(result, Unsupported, "ipa_to_target:no_target_tone_for_category")
		}
		if len(targetTones) > 1 {
			result.Candidates = append(result.Candidates, targetTones...)
			return decline(result, Ambiguous, "ipa_to_target:target_tone_one_to_many")
		}

		onset, rime, tone := targetOnsets[0], targetRimes[0], targetTones[0]
		if problem := adapter.legal(onset, rime, tone); problem != "" {
			return decline(result, Unsupported, "ipa_to_target:target_legality:"+problem)
		}
		parts = append(parts, onset+rime+tone)
	}

	result.CanonicalPronunciation = strings.Join(parts, "")
	return result
}

// sourceIPA is the first arrow for one syllable: each source notation answers
// with the IPA its own 凡例 documents. reason is empty when every segment
// resolved; targetCandidates is non-empty only for a one-to-many source reading,
// and it already holds target spellings because Result.Candidates always does.
func sourceIPA(compiled *compiledV2, unit syllable) (string, string, string, []string, []string, string) {
	var trace []string
	var onsetRow SourceSegment
	if unit.onset == "" {
		// Parsing matches no onset and returns an empty one, which is also what a
		// book writes when it marks no onset. The two are the same string and not
		// the same fact, so the adapter has to say it explicitly; inferring ∅ is
		// exactly the guess #189 forbids.
		if compiled.zeroOnset == nil {
			return "", "", "", nil, nil, "zero_onset_row_absent"
		}
		onsetRow = *compiled.zeroOnset
	} else {
		row, ok := compiled.onsetIPA[unit.onset]
		if !ok {
			return "", "", "", nil, nil, "no_source_onset_ipa"
		}
		onsetRow = row
	}
	trace = append(trace, "source_to_ipa:"+onsetRow.ID)
	if len(onsetRow.Candidates) > 0 {
		candidates, correspondences := targetCandidates(compiled, "onset", onsetRow.Candidates)
		trace = append(trace, prefixAll("ipa_to_target:", correspondences)...)
		return "", "", "", trace, candidates, "source_segment_one_to_many"
	}

	rimeRow, ok := compiled.rimeIPA[unit.rime]
	if !ok {
		return "", "", "", trace, nil, "no_source_rime_ipa"
	}
	trace = append(trace, "source_to_ipa:"+rimeRow.ID)
	if len(rimeRow.Candidates) > 0 {
		candidates, correspondences := targetCandidates(compiled, "rime", rimeRow.Candidates)
		trace = append(trace, prefixAll("ipa_to_target:", correspondences)...)
		return "", "", "", trace, candidates, "source_segment_one_to_many"
	}

	category, hasRow := compiled.toneClass[unit.tone]
	if !hasRow {
		return "", "", "", trace, nil, "no_source_tone"
	}
	trace = append(trace, "source_to_ipa:"+compiled.toneID[unit.tone])
	return onsetRow.IPA, rimeRow.IPA, category, trace, nil, ""
}

// targetCandidates turns a source reading's alternative IPAs into the target
// notations a reviewer may choose between, so an AMBIGUOUS decline is actionable
// rather than a dead end. A candidate the target cannot spell contributes no
// notation, but the correspondence rows that carried the other candidates are
// returned too: #189 locates affected records by rule id, and a correspondence
// that shaped the answer has to appear in the trace even when the result is a
// decline.
func targetCandidates(compiled *compiledV2, part string, ipas []string) ([]string, []string) {
	var out []string
	var correspondences []string
	for _, ipa := range ipas {
		notations, used, _ := compiled.targetNotations(part, ipa)
		out = append(out, notations...)
		correspondences = append(correspondences, used...)
	}
	return dedupe(out), dedupe(correspondences)
}

// matchesSource treats an empty selector as "any neighbour". That reading is why
// the loader normalises selectors before checking them: a selector holding only
// blanks would otherwise pass for a present neighbour and then widen the rule to
// every syllable it can never have meant.
func (r SourceContextRule) matchesSource(unit syllable) bool {
	return (r.WhenOnset == "" || r.WhenOnset == unit.onset) &&
		(r.WhenRime == "" || r.WhenRime == unit.rime)
}

// targetNotations is the second arrow: documented IPA → the target notations
// that spell it, after any explicit equivalence the material itself records.
//
// unexpressible names the documented readings this target scheme cannot spell.
// They are reported instead of dropped on purpose: when a correspondence offers
// several documented IPA strings and only some of them reach the target, the
// surviving spelling is one branch of an unresolved reading, not a unique
// answer, so conversion must not upgrade it to EXACT.
func (compiled *compiledV2) targetNotations(part, ipa string) ([]string, []string, []string) {
	ipas := []string{ipa}
	var trace []string
	if row, ok := compiled.correspondences[part+":"+ipa]; ok {
		trace = append(trace, row.ID)
		if row.To != "" {
			ipas = []string{row.To}
		} else {
			ipas = append([]string(nil), row.Candidates...)
		}
	}
	var out []string
	var unexpressible []string
	for _, candidate := range ipas {
		spelled := compiled.pivot[part+":"+candidate]
		if len(spelled) == 0 {
			unexpressible = append(unexpressible, candidate)
			continue
		}
		out = append(out, spelled...)
	}
	return dedupe(out), trace, unexpressible
}

func prefixAll(prefix string, values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		out = append(out, prefix+value)
	}
	return out
}

func dedupe(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	return out
}
