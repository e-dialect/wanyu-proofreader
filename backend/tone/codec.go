package tone

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	Exact       = "EXACT"
	Ambiguous   = "AMBIGUOUS"
	Unsupported = "UNSUPPORTED"
	NoTone      = "NO_TONE"
	Empty       = "EMPTY"
)

type Conversion struct {
	Text   string   `json:"text"`
	Status string   `json:"status"`
	Tones  []string `json:"tones"`
	Reason string   `json:"reason"`
}

// Go has no Unicode-name lookup in its standard library. These are the Unicode
// SUPERSCRIPT ZERO..NINE codepoints, indexed by their ASCII digit; they are not
// a language's tone mapping. SuperscriptMap emits only keyboard-present values.
var superscriptCodepoints = [...]rune{0x2070, 0x00b9, 0x00b2, 0x00b3, 0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079}

func SuperscriptMap(values []string) map[string]string {
	available := make(map[string]bool, len(values))
	for _, value := range values {
		available[value] = true
	}
	out := map[string]string{}
	for digit, point := range superscriptCodepoints {
		char := string(point)
		if available[char] {
			out[strconv.Itoa(digit)] = char
		}
	}
	return out
}

func unchanged(value, status, reason string) Conversion {
	return Conversion{Text: value, Status: status, Tones: []string{}, Reason: reason}
}

func legalSet(values []string) (map[string]bool, error) {
	validated, err := ValidateLegal(values)
	if err != nil {
		return nil, err
	}
	out := make(map[string]bool, len(validated))
	for _, value := range validated {
		out[value] = true
	}
	return out, nil
}

type span struct{ start, end int }

func placeholderSpans(value []rune) ([]span, bool) {
	out := []span{}
	for i := 0; i < len(value); i++ {
		if value[i] != '@' {
			continue
		}
		end := i + 1
		for end < len(value) && (unicode.IsDigit(value[end]) || value[end] >= 'a' && value[end] <= 'f' || value[end] >= 'A' && value[end] <= 'F') {
			end++
		}
		length := end - i - 1
		if length < 2 {
			continue
		}
		if length > 6 {
			return nil, false
		}
		out = append(out, span{i, end})
		i = end - 1
	}
	return out, true
}
func protected(position int, spans []span) bool {
	// Spans are sorted and disjoint. A long cell containing many opaque IDs
	// must not make the full-cell mixed-notation scan quadratic.
	at := sort.Search(len(spans), func(i int) bool { return spans[i].end > position })
	return at < len(spans) && spans[at].start <= position
}
func mixedNotation(value []rune, spans []span) bool {
	plain, raised := false, false
	for at, char := range value {
		if protected(at, spans) {
			continue
		}
		if char >= '0' && char <= '9' {
			plain = true
		}
		for _, point := range superscriptCodepoints {
			if char == point {
				raised = true
				break
			}
		}
		if plain && raised {
			return true
		}
	}
	return false
}

func phoneticLetter(value rune) bool {
	// Latin script, IPA and modifier/phonetic extension letters. beta/theta/chi
	// are the Greek characters used as IPA symbols; arbitrary Greek/Han text is
	// not accepted as a reading context.
	return unicode.IsLetter(value) && (unicode.In(value, unicode.Latin) || value >= 0x0250 && value <= 0x02ff || value >= 0x1d00 && value <= 0x1dbf || value == 'β' || value == 'θ' || value == 'χ')
}
func phoneticBefore(value []rune, start int) bool {
	before := start - 1
	for before >= 0 && unicode.IsMark(value[before]) {
		before--
	}
	return before >= 0 && phoneticLetter(value[before])
}

// segmentInfo returns the first longest-first segmentation's contour count and
// at most four possible readings, exactly as the Python codec. Dynamic
// programming avoids recursion depth/exponential work on damaged long runs.
func segmentInfo(run string, legal map[string]bool) (int, int) {
	widest := 0
	for value := range legal {
		if len(value) > widest {
			widest = len(value)
		}
	}
	ways := make([]uint8, len(run)+1)
	contours := make([]int, len(run)+1)
	ways[len(run)] = 1
	for at := len(run) - 1; at >= 0; at-- {
		for width := widest; width > 0; width-- {
			end := at + width
			if end > len(run) || !legal[run[at:end]] || ways[end] == 0 {
				continue
			}
			if ways[at] == 0 {
				contours[at] = contours[end] + 1
			}
			count := int(ways[at]) + int(ways[end])
			if count > 4 {
				count = 4
			}
			ways[at] = uint8(count)
		}
	}
	return contours[0], int(ways[0])
}
func raise(run string, superscripts map[string]string) (string, string) {
	var result strings.Builder
	missing := []string{}
	for _, digit := range run {
		key := string(digit)
		mapped := superscripts[key]
		i := int(digit - '0')
		if i < 0 || i >= len(superscriptCodepoints) || mapped != string(superscriptCodepoints[i]) {
			missing = append(missing, key)
			continue
		}
		result.WriteString(mapped)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return "", "superscript_untypeable:" + strings.Join(missing, "")
	}
	return result.String(), ""
}

// Convert formats a declared reading column. Every unprotected decimal run must
// be ASCII and immediately follow a Latin/IPA letter or its combining marks.
// A failed or ambiguous cell is returned byte-for-byte; no partial conversion,
// Unicode normalization, trimming or tone-category inference takes place.
func Convert(value string, legal []string, superscripts map[string]string) Conversion {
	known, err := legalSet(legal)
	if err != nil {
		return unchanged(value, Unsupported, "invalid_legal_values")
	}
	if value == "" {
		return unchanged(value, Empty, "")
	}
	if !utf8.ValidString(value) {
		return unchanged(value, Unsupported, "invalid_utf8")
	}
	runes := []rune(value)
	spans, ok := placeholderSpans(runes)
	if !ok {
		return unchanged(value, Unsupported, "placeholder_out_of_spec_length")
	}
	if mixedNotation(runes, spans) {
		return unchanged(value, Unsupported, "mixed_tone_notation")
	}
	for at := 0; at < len(runes); at++ {
		if !unicode.IsDigit(runes[at]) {
			continue
		}
		start := at
		for at < len(runes) && unicode.IsDigit(runes[at]) {
			at++
		}
		if protected(start, spans) {
			at--
			continue
		}
		for _, digit := range runes[start:at] {
			if digit < '0' || digit > '9' {
				return unchanged(value, Unsupported, "non_ascii_tone_digits")
			}
		}
		if !phoneticBefore(runes, start) {
			return unchanged(value, Unsupported, "tone_digits_without_phonetic_context")
		}
		at--
	}
	status, reason := Exact, ""
	tones := []string{}
	cursor := 0
	var result strings.Builder
	for at := 0; at < len(runes); at++ {
		if !unicode.IsDigit(runes[at]) {
			continue
		}
		start := at
		for at < len(runes) && unicode.IsDigit(runes[at]) {
			at++
		}
		if protected(start, spans) {
			at--
			continue
		}
		run := string(runes[start:at])
		if known[run] {
			raised, missing := raise(run, superscripts)
			if missing != "" {
				return unchanged(value, Unsupported, missing)
			}
			tones = append(tones, run)
			result.WriteString(string(runes[cursor:start]))
			result.WriteString(raised)
			cursor = at
		} else {
			count, ways := segmentInfo(run, known)
			if ways > 0 {
				detail := fmt.Sprintf("tone_run_holds_%d_contours", count)
				if ways > 1 {
					if ways >= 4 {
						detail += "_in_at_least_4_ways"
					} else {
						detail += fmt.Sprintf("_in_%d_ways", ways)
					}
				}
				if status != Unsupported {
					status = Ambiguous
				}
				reason = detail
			} else {
				status = Unsupported
				reason = "tone_run_not_a_legal_value"
			}
		}
		at--
	}
	if status != Exact {
		return unchanged(value, status, reason)
	}
	if len(tones) == 0 {
		return unchanged(value, NoTone, "")
	}
	result.WriteString(string(runes[cursor:]))
	return Conversion{Text: result.String(), Status: Exact, Tones: tones}
}

// ConvertToneOnly accepts only one complete declared contour, without a reading
// stem. Its original leading/trailing Unicode whitespace is copied unchanged.
func ConvertToneOnly(value string, legal []string, superscripts map[string]string) Conversion {
	known, err := legalSet(legal)
	if err != nil {
		return unchanged(value, Unsupported, "invalid_legal_values")
	}
	if value == "" {
		return unchanged(value, Empty, "")
	}
	if !utf8.ValidString(value) {
		return unchanged(value, Unsupported, "invalid_utf8")
	}
	core := strings.TrimSpace(value)
	if core == "" {
		return unchanged(value, NoTone, "")
	}
	if mixedNotation([]rune(core), nil) {
		return unchanged(value, Unsupported, "mixed_tone_notation")
	}
	ascii := true
	for _, char := range core {
		if char < '0' || char > '9' {
			ascii = false
			break
		}
	}
	if !ascii {
		for _, char := range core {
			if unicode.IsDigit(char) && (char < '0' || char > '9') {
				return unchanged(value, Unsupported, "non_ascii_tone_digits")
			}
		}
		var flat strings.Builder
		allSuperscript := true
		for _, char := range core {
			found := false
			for digit, point := range superscriptCodepoints {
				if char == point {
					flat.WriteString(strconv.Itoa(digit))
					found = true
					break
				}
			}
			if !found {
				allSuperscript = false
				if unicode.IsDigit(char) && (char < '0' || char > '9') {
					return unchanged(value, Unsupported, "non_ascii_tone_digits")
				}
				break
			}
		}
		if allSuperscript {
			if known[flat.String()] {
				return unchanged(value, NoTone, "")
			}
			return unchanged(value, Unsupported, "tone_run_not_a_legal_value")
		}
		return unchanged(value, Unsupported, "tone_only_requires_single_value")
	}
	if !known[core] {
		return unchanged(value, Unsupported, "tone_run_not_a_legal_value")
	}
	raised, missing := raise(core, superscripts)
	if missing != "" {
		return unchanged(value, Unsupported, missing)
	}
	start := len(value) - len(strings.TrimLeftFunc(value, unicode.IsSpace))
	end := len(strings.TrimRightFunc(value, unicode.IsSpace))
	return Conversion{Text: value[:start] + raised + value[end:], Status: Exact, Tones: []string{core}}
}
