package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadingColumnsFromReportsWhatItCannotDecide(t *testing.T) {
	cases := []struct {
		name    string
		stored  string
		want    []string
		problem string
	}{
		{"not annotated yet", "", nil, "还没有标注列角色"},
		{"broken json", "{not json", nil, "无法解析"},
		{"no reading column", `{"词头":"headword","释义":"meaning"}`, nil, "没有把任何一列标成记音列"},
		{"one reading column", `{"词头":"headword","读音":"reading"}`, []string{"读音"}, ""},
		// 多个记音列必须拒绝而不是挑一个：挑哪个都会静默丢掉另一列的转换结果。
		{"two reading columns", `{"拼音":"reading","IPA":"reading"}`, nil, "一次只转换一列"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			columns, problem := readingColumnsFrom(tc.stored)
			if tc.problem == "" {
				if problem != "" {
					t.Fatalf("unexpected problem: %s", problem)
				}
				if len(columns) != len(tc.want) || (len(columns) > 0 && columns[0] != tc.want[0]) {
					t.Fatalf("columns = %v, want %v", columns, tc.want)
				}
				return
			}
			if !strings.Contains(problem, tc.problem) {
				t.Fatalf("problem %q does not mention %q", problem, tc.problem)
			}
		})
	}
}

func TestLoadSchemeRegistryWithoutADirectoryIsALegalState(t *testing.T) {
	t.Setenv(schemeAdapterDirEnv, "")
	registry, err := loadSchemeRegistry()
	if err != nil {
		t.Fatalf("an unset directory is not an error: %v", err)
	}
	if len(registry.adapters) != 0 {
		t.Fatalf("expected no adapters, got %d", len(registry.adapters))
	}
	// notice 要能被管理端显示出来，且必须点出是哪个环境变量没配——
	// 否则运维只知道"没有方案"，不知道该动哪里。
	if !strings.Contains(registry.notice, schemeAdapterDirEnv) {
		t.Fatalf("notice must name the env var: %q", registry.notice)
	}
}

func TestLoadSchemeRegistryLoadsAndRejects(t *testing.T) {
	synthetic, err := os.ReadFile(filepath.Join("scheme", "testdata", "adapter_synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}

	t.Run("loads the synthetic adapter", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "adapter.json"), synthetic, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv(schemeAdapterDirEnv, dir)
		registry, err := loadSchemeRegistry()
		if err != nil {
			t.Fatal(err)
		}
		if len(registry.adapters) != 1 {
			t.Fatalf("expected 1 adapter, got %d", len(registry.adapters))
		}
		if registry.adapters["synthetic-source"] == nil {
			t.Fatalf("adapter not keyed by source_scheme_id: %v", registry.schemes())
		}
		if registry.notice != "" {
			t.Fatalf("a configured directory must not carry a notice: %q", registry.notice)
		}
	})

	t.Run("a broken rule file fails the whole load", func(t *testing.T) {
		// #189 要求「非法即启动报错，不要静默半生效」：一个坏文件不能让其余方案照跑。
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "a-broken.json"), []byte("{"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "b-good.json"), synthetic, 0o600); err != nil {
			t.Fatal(err)
		}
		t.Setenv(schemeAdapterDirEnv, dir)
		if _, err := loadSchemeRegistry(); err == nil {
			t.Fatal("a broken rule file must fail the load")
		}
	})

	t.Run("two files claiming one scheme id is an error, not a silent override", func(t *testing.T) {
		dir := t.TempDir()
		for _, name := range []string{"a.json", "b.json"} {
			if err := os.WriteFile(filepath.Join(dir, name), synthetic, 0o600); err != nil {
				t.Fatal(err)
			}
		}
		t.Setenv(schemeAdapterDirEnv, dir)
		if _, err := loadSchemeRegistry(); err == nil {
			t.Fatal("a duplicate source_scheme_id must fail the load")
		}
	})
}
