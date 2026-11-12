package main

import "testing"

func TestCSVPageColumnIdentityAndPreservedOtherColumns(t *testing.T) {
	for _, tc := range []struct {
		headers        []string
		selected, want string
	}{
		{[]string{"page", "词条"}, "page", ""},
		{[]string{"物理页", "书页", "词条"}, "物理页", "物理页"},
		{[]string{"page", "页码", "词条"}, "page", "page"},
	} {
		got, err := canonicalCSVPageColumn(tc.headers, tc.selected)
		if err != nil || got != tc.want {
			t.Fatalf("identity %q: got %q, %v", tc.selected, got, err)
		}
	}
	headers, index, _, err := resolveCSVHeadersWithColumn([]string{"page", "页码", "词条"}, "页码")
	if err != nil {
		t.Fatal(err)
	}
	row, problem := buildCSVPage(headers, []string{"印刷五", "2", "𠀀ka⁵³³"}, index, 3)
	if problem != nil || row.pdfPage != 2 || row.rowJSON != `{"page":"印刷五","词条":"𠀀ka⁵³³"}` {
		t.Fatalf("explicit page column changed content: %+v %+v", row, problem)
	}
	_, problem = buildCSVPage(headers, []string{"1", "坏页码", "𠀀"}, index, 4)
	if problem == nil || problem.column != "页码" || problem.line != 4 {
		t.Fatal("error must identify selected column and source line")
	}
	if _, _, _, err := resolveCSVHeadersWithColumn(headers, "missing"); err == nil {
		t.Fatal("unknown selected column accepted")
	}
}

func TestCSVPageColumnMigrationRoundTrip(t *testing.T) {
	app := newSchemaTestApp(t)
	up, down := deliveryMigration(t, "pb_migrations/1794442200_csv_page_column.js")
	for _, migrate := range []func(*testing.T){
		func(t *testing.T) {
			if err := app.RunInTransaction(up); err != nil {
				t.Fatal(err)
			}
		},
		func(t *testing.T) {
			if err := app.RunInTransaction(down); err != nil {
				t.Fatal(err)
			}
		},
		func(t *testing.T) {
			if err := app.RunInTransaction(up); err != nil {
				t.Fatal(err)
			}
		},
	} {
		migrate(t)
	}
	c, err := app.FindCollectionByNameOrId("import_jobs")
	if err != nil || c.Fields.GetByName("csv_pdf_page_column") == nil {
		t.Fatal("mapping field not installed")
	}
}
