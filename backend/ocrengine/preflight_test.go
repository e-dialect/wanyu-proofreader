package ocrengine

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
)

// Model the parser boundary, not recognition quality. In particular, a rejected
// image page must not launch either text parser or a raster/recognition process.
func preflightCommands(t *testing.T, images bool, layout, raw string) (commandRunner, *[]string) {
	t.Helper()
	calls := []string{}
	return func(ctx context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name)
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if name == "pdfimages" {
			if images {
				return []byte("page num type\n2 0 image\n"), nil
			}
			return []byte("page num type\n"), nil
		}
		if name != "pdftotext" {
			t.Fatalf("unexpected raster/recognition command %s", name)
		}
		text := raw
		for _, arg := range args {
			if arg == "-bbox-layout" {
				text = layout
			}
		}
		return nil, os.WriteFile(args[len(args)-1], []byte(text), 0600)
	}, &calls
}

func TestImagePreflightRejectsBeforeTextExtraction(t *testing.T) {
	t.Setenv("OCR_ALLOW_SCANNED_TEST", "")
	run, calls := preflightCommands(t, true, "", "")
	result, err := recognize(context.Background(), "synthetic.pdf", 2, "eng", run)
	if !errors.Is(err, ErrScannedUnsupported) || !result.HasImages || len(result.Rows) != 0 {
		t.Fatalf("unsupported page was not rejected: result=%+v err=%v", result, err)
	}
	if !reflect.DeepEqual(*calls, []string{"pdfimages"}) {
		t.Fatalf("unsupported page launched unnecessary parsers: %v", *calls)
	}
}

func TestImagePreflightKeepsNativeEvidenceAndBlankAbstention(t *testing.T) {
	t.Setenv("OCR_ALLOW_SCANNED_TEST", "")
	for _, blank := range []bool{false, true} {
		t.Run(map[bool]string{false: "native", true: "blank"}[blank], func(t *testing.T) {
			raw := "  𠀀 \uE001 ⿰木木 a̤̍\n"
			layout := `<page><line><word xMin="10" yMin="20" xMax="90" yMax="30">𠀀 &#xE001; ⿰木木 a̤̍</word></line></page>`
			if blank {
				layout, raw = "<page></page>", ""
			}
			run, calls := preflightCommands(t, false, layout, raw)
			result, err := recognize(context.Background(), "synthetic.pdf", 2, "eng", run)
			if err != nil || result.HasImages || result.RawText != raw || result.RawLayout != layout || len(result.Rows) != 1 {
				t.Fatalf("native evidence changed: result=%+v err=%v", result, err)
			}
			c := result.Rows[0].Cells[0]
			if blank {
				if c.Text != "" || c.Status != "abstained" {
					t.Fatalf("blank page was guessed: %+v", c)
				}
			} else if c.Text != strings.TrimSuffix(raw, "\n") || c.BBox != [4]float64{10, 20, 80, 10} || c.Status != "needs_review" || c.Confidence != nil {
				t.Fatalf("native text/coordinates/status changed: %+v", c)
			}
			if !reflect.DeepEqual(*calls, []string{"pdfimages", "pdftotext", "pdftotext"}) {
				t.Fatalf("native parser calls=%v", *calls)
			}
		})
	}
}

func TestImagePreflightExperimentStillRejectsNativeTitleWithScan(t *testing.T) {
	t.Setenv("OCR_ALLOW_SCANNED_TEST", "1")
	run, calls := preflightCommands(t, true, "<line><word>title</word></line>", "title\n")
	if _, err := recognize(context.Background(), "synthetic.pdf", 2, "eng", run); !errors.Is(err, ErrScannedUnsupported) {
		t.Fatalf("mixed page was accepted by experimental mode: %v", err)
	}
	if !reflect.DeepEqual(*calls, []string{"pdfimages", "pdftotext", "pdftotext"}) {
		t.Fatalf("mixed page launched recognition or repeated image inspection: %v", *calls)
	}
}

func TestImagePreflightExperimentKeepsScannedOutputUnverified(t *testing.T) {
	t.Setenv("OCR_ALLOW_SCANNED_TEST", "1")
	calls := []string{}
	run := func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name)
		switch name {
		case "pdfimages":
			return []byte("page num type\n2 0 image\n"), nil
		case "pdftotext":
			text := ""
			for _, arg := range args {
				if arg == "-bbox-layout" {
					text = "<page></page>"
				}
			}
			return nil, os.WriteFile(args[len(args)-1], []byte(text), 0600)
		case "pdftoppm":
			return nil, nil
		case "tesseract":
			if err := os.WriteFile(args[1]+".tsv", []byte("5\t1\t1\t1\t1\t1\t10\t20\t30\t15\t99\t𠀀\n"), 0600); err != nil {
				return nil, err
			}
			return nil, os.WriteFile(args[1]+".txt", []byte("𠀀\n"), 0600)
		default:
			t.Fatalf("unexpected command %s", name)
			return nil, nil
		}
	}
	result, err := recognize(context.Background(), "synthetic.pdf", 2, "eng", run)
	if err != nil || len(result.Rows) != 1 || !result.HasImages {
		t.Fatalf("explicit experiment stopped working: result=%+v err=%v", result, err)
	}
	cell := result.Rows[0].Cells[0]
	if result.Engine != "tesseract_single_column" || cell.Status != "needs_review" || cell.Source != "tesseract" || cell.Confidence == nil || *cell.Confidence != 99 || cell.Text != "𠀀" {
		t.Fatalf("experimental confidence became a correctness judgment: %+v", result)
	}
	if !reflect.DeepEqual(calls, []string{"pdfimages", "pdftotext", "pdftotext", "pdftoppm", "tesseract"}) {
		t.Fatalf("experimental command boundary changed: %v", calls)
	}
}

func TestImagePreflightFailureAndCancellationStopFurtherParsers(t *testing.T) {
	for _, cancelled := range []bool{false, true} {
		ctx, cancel := context.WithCancel(context.Background())
		if cancelled {
			cancel()
		}
		calls := 0
		failure := errors.New("synthetic image parser failed")
		_, err := recognize(ctx, "synthetic.pdf", 2, "eng", func(ctx context.Context, name string, _ ...string) ([]byte, error) {
			calls++
			if name != "pdfimages" {
				t.Fatalf("launched %s after failed preflight", name)
			}
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, failure
		})
		cancel()
		if calls != 1 || (cancelled && !errors.Is(err, context.Canceled)) || (!cancelled && !errors.Is(err, failure)) {
			t.Fatalf("preflight failure changed: cancelled=%v calls=%d err=%v", cancelled, calls, err)
		}
	}
}
