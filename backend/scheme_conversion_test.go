package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"fangji/backend/scheme"
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

// registryWithBothRuleStatuses 铺一个同时含测试夹具与可运行规则集的目录，直接问闸门。
// 两种文件都在场是这条测试的重点：闸门要能**分开**它们，而不是一律拒绝或一律放行。
func registryWithBothRuleStatuses(t *testing.T) *schemeRegistry {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("scheme", "testdata", "adapter_synthetic.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := map[string]any{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	doc["source_scheme_id"] = "declared-production"
	doc["rule_status"] = "production"
	doc["rule_status_basis"] = "测试用：出处写在这里只是为了让这份文件合法，规则本身仍是合成的。"
	runnable, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	for name, content := range map[string][]byte{"fixture.json": raw, "real.json": runnable} {
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv(schemeAdapterDirEnv, dir)
	registry, err := loadSchemeRegistry()
	if err != nil {
		t.Fatal(err)
	}
	return registry
}

// TestJobAdapterIsTheOnlyGateBetweenARuleSetAndARealJob 是 owner 第 1 条阻断的替代方案的
// 落点：真实规则的形状是 #189 的事，但「没被声明为真实方案的规则进不了真实作业」是本 PR 的事。
//
// 三种情形必须是三句不同的话。混成一句的后果很具体：管理员看到「不能用」时，
// 「目录里没这套方案」要去配 FANGJI_SCHEME_ADAPTER_DIR，「这套方案声明的是 test」要去问规则作者，
// 「作业记的版本和规则对不上」要重新发起作业——三条完全不同的下一步。
func TestJobAdapterIsTheOnlyGateBetweenARuleSetAndARealJob(t *testing.T) {
	registry := registryWithBothRuleStatuses(t)

	t.Run("a scheme nobody registered is the caller's sentence, not this one", func(t *testing.T) {
		adapter, refused := registry.jobAdapter("no-such-scheme")
		if adapter != nil {
			t.Fatalf("an unregistered scheme must not resolve to an adapter: %+v", adapter)
		}
		if refused != "" {
			t.Fatalf("the refusal for an unregistered scheme comes from startConversion: %q", refused)
		}
	})

	t.Run("a registered fixture is refused, and the sentence names it", func(t *testing.T) {
		adapter, refused := registry.jobAdapter("synthetic-source")
		if adapter == nil {
			t.Fatal("a registered fixture still resolves — the caller needs its id for the message")
		}
		if !strings.Contains(refused, "只能用于测试") {
			t.Fatalf("refusal does not say it is test-only: %q", refused)
		}
		for _, want := range []string{"synthetic-source", scheme.RuleStatusTest} {
			if !strings.Contains(refused, want) {
				t.Errorf("refusal does not mention %q: %q", want, refused)
			}
		}
		// 下一步做什么要写清楚：只说「不行」，管理员只能来读代码。
		if !strings.Contains(refused, "#189") {
			t.Errorf("refusal does not say who delivers the real rules: %q", refused)
		}
	})

	t.Run("a rule set that declares production goes through", func(t *testing.T) {
		adapter, refused := registry.jobAdapter("declared-production")
		if adapter == nil || refused != "" {
			t.Fatalf("a production rule set must pass the gate: adapter=%v refused=%q", adapter, refused)
		}
	})

	t.Run("the three sentences are three different sentences", func(t *testing.T) {
		// 前两种由本函数给出，第三种（登记了但版本对不上）由 processConversion 给出。
		// 这里至少钉住「未登记」与「声明为 test」不能是同一句话。
		if _, unregistered := registry.jobAdapter("no-such-scheme"); unregistered != "" {
			t.Fatalf("gate must leave the unregistered sentence to the caller: %q", unregistered)
		}
		_, fixture := registry.jobAdapter("synthetic-source")
		_, production := registry.jobAdapter("declared-production")
		if fixture == production {
			t.Fatalf("the fixture refusal and the pass-through collapsed into one: %q", fixture)
		}
	})
}

// TestReviewBlockedReasonIsFourDifferentSentences 覆盖 decideNormalization 的第一道闸。
// 它挡掉四种不该出现在复核队列里的条目，而四种的下一步处置完全不同，所以不能共用一句话。
func TestReviewBlockedReasonIsFourDifferentSentences(t *testing.T) {
	cases := []struct {
		status  string
		allowed bool
		mention string
	}{
		{string(scheme.Ambiguous), true, ""},
		{string(scheme.Unsupported), true, ""},
		{"", false, "还没有跑过转换"},
		{string(scheme.Exact), false, "机器已经判定了"},
		{string(scheme.Reviewed), false, "已经有人给过结论"},
		{"NOPE", false, "不在可复核的取值范围内"},
	}
	seen := map[string]string{}
	for _, tc := range cases {
		reason := reviewBlockedReason(tc.status)
		if tc.allowed {
			if reason != "" {
				t.Errorf("status %q must be reviewable, got %q", tc.status, reason)
			}
			continue
		}
		if !strings.Contains(reason, tc.mention) {
			t.Errorf("status %q: reason %q does not mention %q", tc.status, reason, tc.mention)
		}
		if previous, ok := seen[reason]; ok {
			t.Errorf("statuses %q and %q share one sentence: %q", previous, tc.status, reason)
		}
		seen[reason] = tc.status
	}

	// 纯判据本身也要对：handler 拿它当闸，表格里多一个取值而这里没跟上就会静默放行。
	for status, want := range map[scheme.Status]bool{
		scheme.Ambiguous: true, scheme.Unsupported: true,
		scheme.Exact: false, scheme.Reviewed: false, "": false,
	} {
		if got := reviewableNormalizationStatus(status); got != want {
			t.Errorf("reviewableNormalizationStatus(%q) = %v, want %v", status, got, want)
		}
	}
}
