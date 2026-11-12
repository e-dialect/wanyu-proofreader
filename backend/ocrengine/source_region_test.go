package ocrengine

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"testing"
)

func TestSourceRegionRealPDFGeometry(t *testing.T) {
	for _, name := range []string{"pdftotext", "pdfimages"} {
		if _, err := exec.LookPath(name); err != nil {
			t.Skip("requires Poppler: " + name)
		}
	}
	raw, err := os.ReadFile("testdata/source-region.pdf")
	if err != nil {
		t.Fatal(err)
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(raw))
	for page := 1; page <= 7; page++ {
		t.Run(fmt.Sprint(page), func(t *testing.T) {
			result, err := Recognize(context.Background(), "testdata/source-region.pdf", page, "eng")
			if err != nil {
				t.Fatal(err)
			}
			if result.SourceSHA256 != digest || result.Geometry == nil {
				t.Fatalf("missing actual PDF provenance: %+v", result)
			}
			if page == 3 {
				if result.Geometry.Layout == "single_column" || Region(result.Rows[0].Cells, result.Geometry) != nil {
					t.Fatal("two-column page localized")
				}
				return
			}
			if page >= 4 {
				g := result.Geometry
				if g.Rotation != (page-4)*90 || g.MediaBox != [4]float64{20, 30, 632, 822} || g.CropBox != [4]float64{60, 90, 572, 762} {
					t.Fatalf("incorrect inherited/effective geometry: %+v", g)
				}
			}
			for _, row := range result.Rows {
				rect := Region(row.Cells, result.Geometry)
				if rect == nil || rect.X < 0 || rect.Y < 0 || rect.X+rect.Width > 1 || rect.Y+rect.Height > 1 {
					t.Fatalf("native line lacks a bounded local region: %+v geometry=%+v", row, result.Geometry)
				}
			}
		})
	}
}
func TestSourceRegionRejectsMergedColumnsAndKeepsContinuousLines(t *testing.T) {
	g := &PageGeometry{CoordinateSpace: SourceCoordinateSpace, MediaBox: [4]float64{0, 0, 600, 800}, CropBox: [4]float64{0, 0, 600, 800}, Layout: "single_column"}
	cells := []Cell{cell("line one", "pdf_text", [4]float64{50, 100, 150, 10}, nil), cell("line two", "pdf_text", [4]float64{50, 115, 100, 10}, nil)}
	if Region(cells, g) == nil {
		t.Fatal("continuous lines should retain both boxes")
	}
	cells[1].BBox[1] = 500
	if Region(cells, g) != nil {
		t.Fatal("distant fragment localized")
	}
	g.rejectSeparatedWords(`<line><word xMin="50" yMin="100" xMax="80" yMax="110">left</word><word xMin="300" yMin="100" xMax="350" yMax="110">right</word></line>`)
	if g.Layout == "single_column" {
		t.Fatal("merged table row accepted")
	}
}
