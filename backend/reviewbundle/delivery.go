package reviewbundle

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

// ReviewedField and ResultEntry are the result payload defined by #182, §3.
// Delivery metadata lives in a separate sidecar; it does not redefine that payload.
type ReviewedField struct {
	Field      string `json:"field"`
	Value      any    `json:"value"`
	Decision   string `json:"decision"`
	Provenance string `json:"provenance"`
}

type ResultEntry struct {
	EntryID        string          `json:"entry_id"`
	ReviewedFields []ReviewedField `json:"reviewed_fields"`
}

type ScopeCounts struct {
	Adopted  int `json:"adopted"`
	Excluded int `json:"excluded"`
	Pending  int `json:"pending"`
}

func (c ScopeCounts) Total() int { return c.Adopted + c.Excluded + c.Pending }

// Declaration contains identifiers and a D-side reason, never excluded text.
type Declaration struct {
	EntryID string `json:"entry_id"`
	Scope   string `json:"scope"`
	Reason  string `json:"reason,omitempty"`
}

type DeliverySnapshot struct {
	Project              string          `json:"project"`
	ImportJob            string          `json:"import_job"`
	ResultOf             string          `json:"result_of"`
	SourceSystem         string          `json:"source_system"`
	SourceID             string          `json:"source_id"`
	SourceVersion        string          `json:"source_version"`
	RightsRef            string          `json:"rights_ref"`
	Recipient            string          `json:"recipient"`
	Purpose              string          `json:"purpose"`
	SelectionRef         string          `json:"selection_ref"`
	SelectionRule        string          `json:"selection_rule"`
	SelectionConfirmedBy string          `json:"selection_confirmed_by"`
	SelectionAuthority   string          `json:"selection_authority"`
	Operator             string          `json:"operator"`
	Reviewer             string          `json:"reviewer"`
	Version              int             `json:"version"`
	Previous             string          `json:"previous,omitempty"`
	PreviousPackageID    string          `json:"previous_package_id,omitempty"`
	PreviousSHA256       string          `json:"previous_sha256,omitempty"`
	Changes              DeliveryChanges `json:"changes"`
	ChangeReason         string          `json:"change_reason,omitempty"`
	Expected             ScopeCounts     `json:"expected"`
	Database             ScopeCounts     `json:"database"`
	Declarations         []Declaration   `json:"declarations"`
	Entries              []ResultEntry   `json:"entries"`
}

type DeliveryChanges struct {
	Added         int  `json:"added"`
	Removed       int  `json:"removed"`
	Changed       int  `json:"changed"`
	ScopeChanged  int  `json:"scope_changed"`
	SourceChanged bool `json:"source_changed"`
}

// CompareDelivery reports structural differences without copying original text.
func CompareDelivery(previous, current DeliverySnapshot) DeliveryChanges {
	d := DeliveryChanges{SourceChanged: previous.SourceSystem != current.SourceSystem || previous.SourceID != current.SourceID || previous.SourceVersion != current.SourceVersion}
	oldEntries := map[string][]byte{}
	newEntries := map[string][]byte{}
	for _, e := range previous.Entries {
		oldEntries[e.EntryID], _ = json.Marshal(e)
	}
	for _, e := range current.Entries {
		newEntries[e.EntryID], _ = json.Marshal(e)
	}
	for id, value := range newEntries {
		old, ok := oldEntries[id]
		if !ok {
			d.Added++
		} else if !bytes.Equal(old, value) {
			d.Changed++
		}
	}
	for id := range oldEntries {
		if _, ok := newEntries[id]; !ok {
			d.Removed++
		}
	}
	oldScope := map[string]Declaration{}
	for _, item := range previous.Declarations {
		oldScope[item.EntryID] = item
	}
	for _, item := range current.Declarations {
		if old, ok := oldScope[item.EntryID]; ok && old != item {
			d.ScopeChanged++
		}
	}
	return d
}

type Reconciliation struct {
	Status        string         `json:"status"`
	Counts        ScopeCounts    `json:"counts"`
	PayloadCount  int            `json:"payload_count"`
	SourceCovered int            `json:"source_covered"`
	SourceTotal   int            `json:"source_total"`
	OutsideRatio  float64        `json:"outside_ratio"`
	Reasons       map[string]int `json:"reasons"`
	Problems      []string       `json:"problems"`
}

// Reconcile can be run offline. The service constructs Database from actual rows
// in a read transaction, and binds the preview to a digest of that snapshot.
func Reconcile(s DeliverySnapshot) Reconciliation {
	r := Reconciliation{Status: "consistent", Reasons: map[string]int{}, Problems: []string{}, PayloadCount: len(s.Entries), SourceTotal: len(s.Declarations)}
	add := func(msg string) { r.Problems = append(r.Problems, msg); r.Status = "inconsistent" }
	seen := map[string]bool{}
	adopted := map[string]bool{}
	for _, d := range s.Declarations {
		if strings.TrimSpace(d.EntryID) == "" || seen[d.EntryID] {
			add("来源条目标识缺失或重复。")
		}
		seen[d.EntryID] = true
		switch d.Scope {
		case "adopted":
			r.Counts.Adopted++
			adopted[d.EntryID] = true
		case "excluded":
			r.Counts.Excluded++
		case "pending":
			r.Counts.Pending++
		default:
			add("交接清单含未知范围。")
		}
		if d.Scope != "adopted" {
			if strings.TrimSpace(d.Reason) == "" {
				add("范围外或待处理条目缺少 D 侧理由。")
			}
			r.Reasons[d.Reason]++
		}
	}
	if r.Counts != s.Expected || r.Counts != s.Database {
		add("交接清单、包内与数据库的采用／范围外／待处理数量不一致。")
	}
	if r.Counts.Total() == 0 {
		add("批次为空。")
	} else {
		r.OutsideRatio = float64(r.Counts.Excluded+r.Counts.Pending) / float64(r.Counts.Total())
	}
	if r.Counts.Adopted != len(s.Entries) {
		add("采用数量与结果正文数量不一致。")
	}
	used := map[string]bool{}
	for _, entry := range s.Entries {
		if !adopted[entry.EntryID] || used[entry.EntryID] {
			add("正文含范围外条目或重复条目。")
		}
		used[entry.EntryID] = true
	}
	if s.SourceSystem != "" && s.SourceID != "" && s.SourceVersion != "" {
		r.SourceCovered = len(s.Declarations)
	} else {
		add("缺少来源系统／标识／版本。")
	}
	return r
}

func Digest(data []byte) string { sum := sha256.Sum256(data); return hex.EncodeToString(sum[:]) }

func canonicalSnapshot(s DeliverySnapshot) DeliverySnapshot {
	s.Declarations = append([]Declaration(nil), s.Declarations...)
	s.Entries = append([]ResultEntry(nil), s.Entries...)
	sort.Slice(s.Declarations, func(i, j int) bool { return s.Declarations[i].EntryID < s.Declarations[j].EntryID })
	sort.Slice(s.Entries, func(i, j int) bool { return s.Entries[i].EntryID < s.Entries[j].EntryID })
	return s
}

func SnapshotDigest(s DeliverySnapshot) string {
	data, _ := json.Marshal(canonicalSnapshot(s))
	return Digest(data)
}

type deliverySidecar struct {
	Format          string           `json:"format"`
	Snapshot        DeliverySnapshot `json:"snapshot"`
	Reconciliation  Reconciliation   `json:"reconciliation"`
	Coverage        string           `json:"coverage"`
	Sampling        bool             `json:"sampling"`
	SamplingRule    string           `json:"sampling_rule"`
	Extrapolatable  bool             `json:"extrapolatable"`
	ReleaseDecision string           `json:"release_decision"`
}

// BuildDelivery produces the same bytes for the same snapshot and timestamp.
// Fixed ZIP timestamps, sorted members, and stable source IDs make replay independent
// of the host filesystem, database, clock, and Go map iteration order.
func BuildDelivery(snapshot DeliverySnapshot, createdAt string) ([]byte, error) {
	s := canonicalSnapshot(snapshot)
	if _, err := time.Parse(time.RFC3339, createdAt); err != nil {
		return nil, fmt.Errorf("生成时间无效。")
	}
	for _, v := range []string{s.Operator, s.Reviewer, s.Recipient, s.Purpose, s.SelectionRef, s.SelectionRule, s.SelectionConfirmedBy, s.SelectionAuthority} {
		if strings.TrimSpace(v) == "" || len([]rune(v)) > 200 || strings.ContainsAny(v, "\r\n") {
			return nil, fmt.Errorf("操作者、核查者、接收方、用途与已确认的编选凭据均为必填（最多 200 字且不可换行）。")
		}
	}
	if s.Version < 1 || (s.Version > 1 && (s.Previous == "" || s.PreviousPackageID == "" || !validSHA256(s.PreviousSHA256) || strings.TrimSpace(s.ChangeReason) == "")) {
		return nil, fmt.Errorf("重发必须关联前包并说明差异。")
	}
	r := Reconcile(s)
	if r.Status != "consistent" {
		return nil, fmt.Errorf("对账不一致：%s", strings.Join(r.Problems, " "))
	}
	if len(s.Entries) == 0 {
		return nil, fmt.Errorf("没有已采用的校对成果。")
	}
	var payload bytes.Buffer
	enc := json.NewEncoder(&payload)
	enc.SetEscapeHTML(false)
	for _, entry := range s.Entries {
		if err := enc.Encode(entry); err != nil {
			return nil, err
		}
	}
	doc := manifest{}
	doc.Bundle.BundleID = "delivery-" + SnapshotDigest(s)[:32]
	doc.Bundle.SchemaVersion = SchemaResult
	doc.Bundle.CreatedAt = createdAt
	doc.SourceSystem = "wanyu-proofreader"
	doc.SourceID = s.SourceID
	doc.SourceVersion = s.SourceVersion
	doc.RightsRef = s.RightsRef
	doc.Operator = s.Operator
	doc.ResultOf = &struct {
		BundleID string `json:"bundle_id"`
	}{s.ResultOf}
	doc.Files = []manifestFile{{Path: "results.jsonl", SHA256: Digest(payload.Bytes()), Lines: len(s.Entries), Bytes: payload.Len()}}
	manifestData, err := json.Marshal(doc)
	if err != nil {
		return nil, err
	}
	sidecar, err := json.Marshal(deliverySidecar{Format: "wanyu-delivery/v1", Snapshot: s, Reconciliation: r, Coverage: "one_import_batch_confirmed_selection", Sampling: false, SamplingRule: "全部采用范围；范围外与待处理仅列标识和理由，不携带正文", Extrapolatable: false, ReleaseDecision: "human_required"})
	if err != nil {
		return nil, err
	}
	files := map[string][]byte{"manifest.json": manifestData, "results.jsonl": payload.Bytes(), "delivery.json": sidecar}
	if report := validateLoaded(files); !report.OK {
		return nil, fmt.Errorf("结果包契约校验失败：%s", report.Errors[0].Message)
	}
	var sums strings.Builder
	for _, name := range []string{"delivery.json", "manifest.json", "results.jsonl"} {
		fmt.Fprintf(&sums, "%s  %s\n", Digest(files[name]), name)
	}
	files["checksums.sha256"] = []byte(sums.String())
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, name := range []string{"checksums.sha256", "delivery.json", "manifest.json", "results.jsonl"} {
		if len(files[name]) > maxFileBytes {
			return nil, fmt.Errorf("交付包文件超过 8 MiB 上限，请在 D 侧拆分批次。")
		}
		h := &zip.FileHeader{Name: name, Method: zip.Store}
		h.SetMode(0600)
		w, err := zw.CreateHeader(h)
		if err != nil {
			return nil, err
		}
		if _, err = w.Write(files[name]); err != nil {
			return nil, err
		}
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	if out.Len() > maxTotalBytes {
		return nil, fmt.Errorf("交付包超过 20 MiB 上限，请在 D 侧拆分批次。")
	}
	return out.Bytes(), nil
}

// ReplayDelivery validates every archive byte against an independently recorded
// SHA-256, checks the existing result contract, and reconstructs the archive offline.
// The digest is a transport integrity pin, not an identity signature.
func ReplayDelivery(data []byte, expectedSHA string) ([]byte, DeliverySnapshot, error) {
	fail := func(msg string) ([]byte, DeliverySnapshot, error) {
		return nil, DeliverySnapshot{}, fmt.Errorf("%s已拒绝整包，未写入任何数据。", msg)
	}
	if !validSHA256(expectedSHA) || !strings.EqualFold(Digest(data), expectedSHA) {
		return fail("交付包 SHA-256 校验失败。")
	}
	files, refusal, err := loadZipFiles(data)
	if err != nil || refusal != nil {
		return fail("交付包无法安全解包。")
	}
	if len(files) != 4 {
		return fail("交付包文件清单不完整或含额外文件。")
	}
	for _, name := range []string{"checksums.sha256", "delivery.json", "manifest.json", "results.jsonl"} {
		if _, ok := files[name]; !ok {
			return fail("交付包缺少 " + name + "。")
		}
	}
	if report := validateLoaded(files); !report.OK {
		return fail(report.Errors[0].Message)
	}
	var side deliverySidecar
	var doc manifest
	if json.Unmarshal(files["delivery.json"], &side) != nil || side.Format != "wanyu-delivery/v1" || json.Unmarshal(files["manifest.json"], &doc) != nil {
		return fail("交付说明无法解析。")
	}
	rebuilt, err := BuildDelivery(side.Snapshot, doc.Bundle.CreatedAt)
	if err != nil {
		return fail(err.Error())
	}
	if !bytes.Equal(rebuilt, data) {
		return fail("重放结果与包内数据、对账或校验和不一致。")
	}
	return rebuilt, side.Snapshot, nil
}
