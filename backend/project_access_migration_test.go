package main

import (
	"bytes"
	"os"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/core"
	"golang.org/x/crypto/bcrypt"
)

// postSnapshotSelectFields 是本包的 SQL 查询会读、但由**初始快照之后**的迁移追加的列。
//
// newSchemaTestApp 只 import 初始快照、不跑后续迁移（它是给 schema 与安全边界用的），
// 所以队列查询里 SELECT 的 difficulty_tier 必须在这里显式补上，否则测试库与生产库
// schema 不同、SQL 直接报 no such column。TestPostSnapshotFieldsTrackTheirMigrations
// 钉住这份镜像与迁移文件里的取值表一致——镜像会漂，测试不许跟着一起漂。
var postSnapshotSelectFields = []struct {
	Field     string
	Migration string
	Marker    string
	Values    []string
}{
	{Field: "difficulty_tier", Migration: "pb_migrations/1789113700_page_difficulty.js", Marker: "const TIERS = [", Values: []string{"A", "B", "C", "unknown"}},
}

// newInitialSchemaTestApp preserves the original migration password settings.
// Both schema helpers create their database exclusively inside t.TempDir().
func newInitialSchemaTestApp(t testing.TB) *pocketbase.PocketBase {
	t.Helper()
	app := pocketbase.NewWithConfig(pocketbase.Config{DefaultDataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { app.ResetBootstrapState() })
	raw, err := os.ReadFile("pb_migrations/1788940000_initial_schema.js")
	if err != nil {
		t.Fatal(err)
	}
	raw = raw[bytes.IndexByte(raw, '[') : bytes.LastIndex(raw, []byte("];"))+1]
	if err := app.ImportCollectionsByMarshaledJSON(raw, false); err != nil {
		t.Fatal(err)
	}
	return app
}

func newSchemaTestApp(t testing.TB) *pocketbase.PocketBase {
	t.Helper()
	app := newInitialSchemaTestApp(t)
	projects, err := app.FindCollectionByNameOrId("projects")
	if err != nil {
		t.Fatal(err)
	}
	projects.Fields.Add(&core.SelectField{Name: "purpose", Values: []string{"work", "practice"}, MaxSelect: 1})
	if err := app.Save(projects); err != nil {
		t.Fatal(err)
	}
	// Only this _test.go fixture lowers bcrypt cost, on its own temporary
	// database. Password hashing/verification still use real bcrypt. Production
	// startup, migration files and HTTP full-migration suites never call this
	// helper and retain their configured cost, checked separately below.
	for _, name := range []string{"users", "_superusers"} {
		collection, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatal(err)
		}
		collection.Fields.GetByName("password").(*core.PasswordField).Cost = bcrypt.MinCost
		if err := app.Save(collection); err != nil {
			t.Fatalf("set test-only %s password cost: %v", name, err)
		}
	}
	pages, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		t.Fatal(err)
	}
	for _, column := range postSnapshotSelectFields {
		if pages.Fields.GetByName(column.Field) != nil {
			continue
		}
		pages.Fields.Add(&core.SelectField{Name: column.Field, MaxSelect: 1, Values: column.Values})
	}
	// 队列 SQL 还会读 pages.missing_glyph（布尔，1792800000 迁移追加），镜像里补一个布尔字段。
	if pages.Fields.GetByName("missing_glyph") == nil {
		pages.Fields.Add(&core.BoolField{Name: "missing_glyph"})
	}
	if err := app.Save(pages); err != nil {
		t.Fatalf("add post-snapshot pages fields: %v", err)
	}
	return app
}

func TestInitialSchemaRetainsProductionPasswordCost(t *testing.T) {
	// Deliberately bypass newSchemaTestApp so a weakened migration cannot be
	// hidden by the fixture override. Check actual hashes as well as settings.
	app := newInitialSchemaTestApp(t)
	for _, name := range []string{"users", "_superusers"} {
		t.Run(name, func(t *testing.T) {
			collection, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				t.Fatal(err)
			}
			cost := collection.Fields.GetByName("password").(*core.PasswordField).Cost
			if cost == 0 {
				cost = bcrypt.DefaultCost
			}
			if cost < bcrypt.DefaultCost {
				t.Fatalf("production password cost=%d below bcrypt default=%d", cost, bcrypt.DefaultCost)
			}
			record := core.NewRecord(collection)
			record.SetPassword("ProductionCostCheck123!")
			hash := record.GetRaw("password").(*core.PasswordFieldValue).Hash
			actual, err := bcrypt.Cost([]byte(hash))
			if err != nil || actual != cost {
				t.Fatalf("actual password hash cost=%d want=%d: %v", actual, cost, err)
			}
		})
	}
}

func TestSchemaTestAppUsesRealMinimumCostBcrypt(t *testing.T) {
	app := newSchemaTestApp(t)
	for _, name := range []string{"users", "_superusers"} {
		t.Run(name, func(t *testing.T) {
			collection, err := app.FindCollectionByNameOrId(name)
			if err != nil {
				t.Fatal(err)
			}
			record := core.NewRecord(collection)
			record.SetPassword("FixtureCostCheck123!")
			hash := record.GetRaw("password").(*core.PasswordFieldValue).Hash
			actual, err := bcrypt.Cost([]byte(hash))
			if err != nil || actual != bcrypt.MinCost {
				t.Fatalf("fixture password hash cost=%d want=%d: %v", actual, bcrypt.MinCost, err)
			}
			if !record.ValidatePassword("FixtureCostCheck123!") || record.ValidatePassword("wrong-password") {
				t.Fatal("fixture must retain real password verification")
			}
		})
	}
}

// TestPostSnapshotFieldsTrackTheirMigrations 从迁移文件源码里取出 TIERS 字面量，
// 与上面那份镜像比对。迁移改档位取值而镜像没跟上时，本包的队列查询会照着旧值算，
// 而生产库按新值存——这种偏差在测试里表现为"全绿但线上分错层"。
func TestPostSnapshotFieldsTrackTheirMigrations(t *testing.T) {
	for _, column := range postSnapshotSelectFields {
		raw, err := os.ReadFile(column.Migration)
		if err != nil {
			t.Fatalf("%s: %v", column.Migration, err)
		}
		text := string(raw)
		marker := column.Marker
		start := strings.Index(text, marker)
		if start < 0 {
			t.Fatalf("%s 里找不到 %s 定义，镜像字段 %s 的取值表已经无据可查", column.Migration, strings.TrimSpace(marker), column.Field)
		}
		list := text[start+len(marker):]
		list = list[:strings.Index(list, "]")]
		for _, want := range column.Values {
			if !strings.Contains(list, `"`+want+`"`) {
				t.Errorf("%s 的取值表不含 %q（镜像与迁移已漂移）: %s", column.Migration, want, strings.TrimSpace(list))
			}
		}
		if got, want := strings.Count(list, `"`)/2, len(column.Values); got != want {
			t.Errorf("%s 的取值表有 %d 个值，镜像只列了 %d 个: %s", column.Migration, got, want, strings.TrimSpace(list))
		}
	}
}
func TestFreshSchemaSecurityAndLimits(t *testing.T) {
	app := newSchemaTestApp(t)
	for _, name := range []string{"project_access_secrets", "project_join_attempts", "project_join_source_attempts", "task_leases"} {
		collection, err := app.FindCollectionByNameOrId(name)
		if err != nil {
			t.Fatal(err)
		}
		if collection.ListRule != nil || collection.ViewRule != nil || collection.CreateRule != nil || collection.UpdateRule != nil || collection.DeleteRule != nil {
			t.Fatalf("%s must not expose native records", name)
		}
	}
	files, err := app.FindCollectionByNameOrId("project_files")
	if err != nil {
		t.Fatal(err)
	}
	field := files.Fields.GetByName("file").(*core.FileField)
	if field.MaxSize != 100*1024*1024 || !field.Protected {
		t.Fatalf("unexpected PDF settings: %+v", field)
	}
	pages, err := app.FindCollectionByNameOrId("pages")
	if err != nil {
		t.Fatal(err)
	}
	if pages.Fields.GetByName("row_headers_json") == nil {
		t.Fatal("missing column-order snapshot")
	}
}
