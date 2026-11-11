package ocrengine

import (
	"context"
	"crypto/sha256"
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"os"
	"sort"
	"strings"

	pdfapi "github.com/pdfcpu/pdfcpu/pkg/api"
	pdfmodel "github.com/pdfcpu/pdfcpu/pkg/pdfcpu/model"
)

const SourceCoordinateSpace = "poppler-media-top-left-v1"

type PageGeometry struct {
	CoordinateSpace string     `json:"coordinateSpace"`
	MediaBox        [4]float64 `json:"mediaBox"`
	CropBox         [4]float64 `json:"cropBox"`
	Rotation        int        `json:"rotation"`
	Layout          string     `json:"layout"`
}
type SourceRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

// Geometry and digest come from the exact PDF parsed by Poppler, not its XML
// page dimensions (which do not encode effective CropBox or page rotation).
func readSourceGeometry(ctx context.Context, path string, page int) (string, *PageGeometry) {
	f, err := os.Open(path)
	if err != nil {
		return "", nil
	}
	defer f.Close()
	digest := sha256.New()
	if _, err = io.Copy(digest, f); err != nil {
		return "", nil
	}
	hash := fmt.Sprintf("%x", digest.Sum(nil))
	if _, err = f.Seek(0, io.SeekStart); err != nil {
		return hash, nil
	}
	conf := pdfmodel.NewDefaultConfiguration()
	conf.ValidationMode = pdfmodel.ValidationRelaxed
	parsed, err := pdfapi.ReadContext(ctx, f, conf)
	if err != nil {
		return hash, nil
	}
	if err = pdfapi.ValidateContext(ctx, parsed); err != nil {
		return hash, nil
	}
	dict, _, attrs, err := parsed.PageDict(ctx, page, false)
	if err != nil || attrs == nil || attrs.MediaBox == nil {
		return hash, nil
	}
	if unit, ok := dict.Find("UserUnit"); ok {
		value, e := parsed.DereferenceNumber(unit)
		if e != nil || value != 1 {
			return hash, nil
		}
	}
	media := attrs.MediaBox
	crop := attrs.CropBox
	if crop == nil {
		crop = media
	}
	g := &PageGeometry{CoordinateSpace: SourceCoordinateSpace, MediaBox: [4]float64{media.LL.X, media.LL.Y, media.UR.X, media.UR.Y}, CropBox: [4]float64{crop.LL.X, crop.LL.Y, crop.UR.X, crop.UR.Y}, Rotation: ((attrs.Rotate % 360) + 360) % 360, Layout: "unsupported"}
	if _, ok := g.dimensions(); !ok {
		return hash, nil
	}
	return hash, g
}
func finiteRect(b [4]float64) bool {
	for _, v := range b {
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return false
		}
	}
	return b[2] > b[0] && b[3] > b[1]
}
func rotate(x, y, w, h float64, r int) (float64, float64) {
	switch r {
	case 90:
		return h - y, x
	case 180:
		return w - x, h - y
	case 270:
		return y, w - x
	}
	return x, y
}
func turnBox(b [4]float64, w, h float64, r int) [4]float64 {
	out := [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	for _, p := range [][2]float64{{b[0], b[1]}, {b[2], b[1]}, {b[2], b[3]}, {b[0], b[3]}} {
		x, y := rotate(p[0], p[1], w, h, r)
		out[0] = min(out[0], x)
		out[1] = min(out[1], y)
		out[2] = max(out[2], x)
		out[3] = max(out[3], y)
	}
	return out
}
func (g *PageGeometry) dimensions() ([4]float64, bool) {
	if g == nil || g.CoordinateSpace != SourceCoordinateSpace || !finiteRect(g.MediaBox) || !finiteRect(g.CropBox) || g.Rotation < 0 || g.Rotation >= 360 || g.Rotation%90 != 0 {
		return [4]float64{}, false
	}
	m, c := g.MediaBox, g.CropBox
	c = [4]float64{max(m[0], c[0]), max(m[1], c[1]), min(m[2], c[2]), min(m[3], c[3])}
	if !finiteRect(c) {
		return c, false
	}
	b := [4]float64{c[0] - m[0], m[3] - c[3], c[2] - m[0], m[3] - c[1]}
	return turnBox(b, m[2]-m[0], m[3]-m[1], g.Rotation), true
}
func (g *PageGeometry) unrotate(b [4]float64) [4]float64 {
	w, h := g.MediaBox[2]-g.MediaBox[0], g.MediaBox[3]-g.MediaBox[1]
	if g.Rotation == 90 || g.Rotation == 270 {
		w, h = h, w
	}
	return turnBox(b, w, h, (360-g.Rotation)%360)
}

// Confirm a shared text column from geometry. The request's single_column
// option alone is not evidence: disjoint columns or indeterminate boxes fail.
func (g *PageGeometry) classify(rows []Row) {
	if g == nil {
		return
	}
	left, right, minimum := math.Inf(-1), math.Inf(1), math.Inf(1)
	count := 0
	for _, row := range rows {
		for _, cell := range row.Cells {
			if strings.TrimSpace(cell.Text) == "" {
				continue
			}
			b := cell.BBox
			b = [4]float64{b[0], b[1], b[0] + b[2], b[1] + b[3]}
			if !finiteRect(b) {
				return
			}
			b = g.unrotate(b)
			left = max(left, b[0])
			right = min(right, b[2])
			minimum = min(minimum, b[2]-b[0])
			count++
		}
	}
	if count > 0 && right-left >= minimum*0.15 {
		g.Layout = "single_column"
	}
}

// Region preserves all glyph boxes and a small context margin. Discontinuous
// fragments, untrusted geometry and content clipped by the CropBox use a page.
func Region(cells []Cell, g *PageGeometry) *SourceRect {
	crop, ok := g.dimensions()
	if !ok || g.Layout != "single_column" || len(cells) == 0 {
		return nil
	}
	combined := [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	lines := [][4]float64{}
	for _, cell := range cells {
		if cell.Source != "pdf_text" || (cell.Status != "certain" && cell.Status != "needs_review") || strings.TrimSpace(cell.Text) == "" {
			return nil
		}
		c := cell.BBox
		b := [4]float64{c[0], c[1], c[0] + c[2], c[1] + c[3]}
		if !finiteRect(b) || b[0] < crop[0] || b[1] < crop[1] || b[2] > crop[2] || b[3] > crop[3] {
			return nil
		}
		combined[0] = min(combined[0], b[0])
		combined[1] = min(combined[1], b[1])
		combined[2] = max(combined[2], b[2])
		combined[3] = max(combined[3], b[3])
		lines = append(lines, g.unrotate(b))
	}
	sort.Slice(lines, func(i, j int) bool { return lines[i][1] < lines[j][1] })
	for i := 1; i < len(lines); i++ {
		a, b := lines[i-1], lines[i]
		if min(a[2], b[2])-max(a[0], b[0]) < min(a[2]-a[0], b[2]-b[0])*0.15 || b[1]-a[3] > max(a[3]-a[1], b[3]-b[1])*2 {
			return nil
		}
	}
	w, h := crop[2]-crop[0], crop[3]-crop[1]
	x, y := max(0, combined[0]-crop[0]-8), max(0, combined[1]-crop[1]-8)
	endX, endY := min(w, combined[2]-crop[0]+8), min(h, combined[3]-crop[1]+8)
	return &SourceRect{x / w, y / h, (endX - x) / w, (endY - y) / h}
}

// Even when Poppler merges a table row into one line, a large internal word
// gap is not a safe single-column localization. No text semantics are guessed.
func (g *PageGeometry) rejectSeparatedWords(layout string) {
	if g == nil || g.Layout != "single_column" {
		return
	}
	decoder := xml.NewDecoder(strings.NewReader(layout))
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return
		}
		if err != nil {
			g.Layout = "unsupported"
			return
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "line" {
			continue
		}
		var line bboxLine
		if decoder.DecodeElement(&line, &start) != nil {
			g.Layout = "unsupported"
			return
		}
		boxes := [][4]float64{}
		for _, word := range line.Words {
			b := g.unrotate([4]float64{word.X1, word.Y1, word.X2, word.Y2})
			if !finiteRect(b) {
				g.Layout = "unsupported"
				return
			}
			boxes = append(boxes, b)
		}
		sort.Slice(boxes, func(i, j int) bool { return boxes[i][0] < boxes[j][0] })
		for i := 1; i < len(boxes); i++ {
			a, b := boxes[i-1], boxes[i]
			if b[0]-a[2] > 4*max(a[3]-a[1], b[3]-b[1]) {
				g.Layout = "unsupported"
				return
			}
		}
	}
}
