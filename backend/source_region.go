package main

import (
	"crypto/sha256"
	"encoding/json"
	"fangji/backend/ocrengine"
	"fmt"
	"github.com/pocketbase/pocketbase/core"
)

const sourceBindingVersion = "ocr-source-region-v1"

type ocrSourceBinding struct {
	Version      string                  `json:"version"`
	FileID       string                  `json:"fileId"`
	SourceKey    string                  `json:"sourceKey"`
	SHA256       string                  `json:"sha256"`
	PhysicalPage int                     `json:"physicalPage,omitempty"`
	Geometry     *ocrengine.PageGeometry `json:"geometry,omitempty"`
	CellsSHA256  string                  `json:"cellsSha256,omitempty"`
}
type sourceRegion struct {
	EntryID      string                `json:"entryId"`
	PhysicalPage int                   `json:"physicalPage"`
	AssetKey     string                `json:"assetKey"`
	Rect         *ocrengine.SourceRect `json:"rect"`
}

func sourceDigest(raw string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(raw))) }
func newOCRSourceBinding(file *core.Record) ocrSourceBinding {
	return ocrSourceBinding{Version: sourceBindingVersion, FileID: file.Id, SourceKey: pdfSourceKey(file), SHA256: file.GetString("file_hash")}
}
func encodeSourceBinding(binding ocrSourceBinding) string {
	raw, _ := json.Marshal(binding)
	return string(raw)
}
func sourceBindingMatches(binding ocrSourceBinding, file *core.Record) bool {
	return binding.Version == sourceBindingVersion && binding.FileID == file.Id && binding.SourceKey == pdfSourceKey(file) && len(binding.SHA256) == 64 && binding.SHA256 == file.GetString("file_hash")
}

// Only called after resolveTaskPDF. The rect is for this entry's own physical
// page, not its permitted neighboring page, and never inferred for old imports.
func (s *importService) taskSourceRegion(c *core.RequestEvent, file *core.Record, physicalPage int, assetKey string) *sourceRegion {
	page, err := s.app.FindRecordById("pages", c.Request.PathValue("pageId"))
	if err != nil || page.GetString("project") != file.GetString("project") || page.GetString("project_file") != file.Id || page.GetInt("pdf_page") != physicalPage {
		return nil
	}
	var binding ocrSourceBinding
	if json.Unmarshal([]byte(page.GetString("ocr_source_binding_json")), &binding) != nil || !sourceBindingMatches(binding, file) || binding.PhysicalPage != physicalPage {
		return nil
	}
	raw := page.GetString("ocr_cells_json")
	if binding.CellsSHA256 == "" || binding.CellsSHA256 != sourceDigest(raw) {
		return nil
	}
	var cells []ocrengine.Cell
	if json.Unmarshal([]byte(raw), &cells) != nil {
		return nil
	}
	rect := ocrengine.Region(cells, binding.Geometry)
	if rect == nil {
		return nil
	}
	return &sourceRegion{page.Id, physicalPage, assetKey, rect}
}
