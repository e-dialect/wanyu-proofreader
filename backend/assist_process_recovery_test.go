package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// This helper starts the actual production main in a separate OS process. It
// does not replace bootstrap, migrations, model hooks, the writer or recovery.
func TestAssistProcessMainHelper(t *testing.T) {
	if os.Getenv("FANGJI_TEST_ASSIST_PROCESS") != "1" {
		return
	}
	for i, arg := range os.Args {
		if arg == "--" {
			os.Args = append([]string{os.Args[0]}, os.Args[i+1:]...)
			main()
			return
		}
	}
	t.Fatal("missing isolated main arguments")
}

type assistOwnedProcess struct {
	cmd  *exec.Cmd
	done chan struct{}
	err  error // read only after done is closed
	log  string
}

func startAssistProcess(t *testing.T, data, hooks, barrier, bootstrapSeen string, command ...string) (*assistOwnedProcess, string) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	migrations, err := filepath.Abs("pb_migrations")
	if err != nil {
		t.Fatal(err)
	}
	initializing := len(command) > 0
	if !initializing {
		command = []string{"serve", "--http=" + address}
	}
	args := append([]string{"-test.run=^TestAssistProcessMainHelper$", "--"}, command...)
	args = append(args, "--dir="+data, "--hooksDir="+hooks,
		"--migrationsDir="+migrations, "--hooksWatch=false", "--dev=false")
	cmd := exec.Command(os.Args[0], args...)
	// Inherited developer/provider configuration must not turn this temporary
	// fixture into an external integration or point it at another data directory.
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		blocked := false
		for _, prefix := range []string{"APP_", "PB_", "FANGJI_", "HINGHWA_", "SMTP_", "OCR_", "GOMAXPROCS", "GOMEMLIMIT", "GORACE"} {
			blocked = blocked || strings.HasPrefix(key, prefix)
		}
		if !blocked {
			cmd.Env = append(cmd.Env, value)
		}
	}
	cmd.Env = append(cmd.Env,
		"FANGJI_TEST_ASSIST_PROCESS=1", "FANGJI_TEST_ASSIST_BARRIER="+barrier,
		"FANGJI_TEST_ASSIST_BOOTSTRAP_SEEN="+bootstrapSeen,
		"APP_ADMIN_EMAIL=assist-process@example.invalid", "APP_ADMIN_PASSWORD=SyntheticProcess123!",
		"PB_ADMIN_EMAIL=assist-process-super@example.invalid", "PB_ADMIN_PASSWORD=SyntheticProcess123!",
		"FANGJI_RESEARCH_MODE=0", "FANGJI_SKIP_ADMIN_BOOTSTRAP=0",
		"GOMAXPROCS=2", "GOMEMLIMIT=768MiB", "GORACE=halt_on_error=1")
	if initializing {
		// As in the real integration harness, initialize app migrations before
		// account bootstrap: PocketBase Bootstrap itself runs only system ones.
		for i, value := range cmd.Env {
			if strings.HasPrefix(value, "FANGJI_SKIP_ADMIN_BOOTSTRAP=") {
				cmd.Env[i] = "FANGJI_SKIP_ADMIN_BOOTSTRAP=1"
			}
		}
	}
	logFile, err := os.CreateTemp(filepath.Dir(data), "assist-process-*.log")
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stdout, cmd.Stderr = logFile, logFile
	process := &assistOwnedProcess{cmd: cmd, done: make(chan struct{}), log: logFile.Name()}
	if err := cmd.Start(); err != nil {
		logFile.Close()
		t.Fatal(err)
	}
	go func() {
		process.err = cmd.Wait()
		logFile.Close()
		close(process.done)
	}()
	t.Cleanup(func() {
		process.stop(t, false)
		if t.Failed() {
			if raw, err := os.ReadFile(process.log); err == nil {
				for _, line := range strings.Split(string(raw), "\n") {
					if strings.Contains(line, "bootstrap_identity_") {
						t.Log(line)
					}
				}
			}
		}
	})
	return process, "http://" + address
}

func (p *assistOwnedProcess) stop(t *testing.T, crash bool) {
	t.Helper()
	defer func() {
		if raw, err := os.ReadFile(p.log); err == nil && bytes.Contains(raw, []byte("WARNING: DATA RACE")) {
			t.Error("race detector reported a failure in the isolated production main")
		}
	}()
	select {
	case <-p.done:
		return
	default:
	}
	// Only the retained handle of our direct child is signalled. No ps-derived
	// PID/PGID, process discovery or historical process-group cleanup is used.
	if crash {
		_ = p.cmd.Process.Kill()
	} else {
		_ = p.cmd.Process.Signal(os.Interrupt)
	}
	select {
	case <-p.done:
		return
	case <-time.After(5 * time.Second):
		_ = p.cmd.Process.Kill()
	}
	select {
	case <-p.done:
	case <-time.After(10 * time.Second):
		t.Error("owned assist main did not exit and reap")
	}
}

func assistProcessRequest(ctx context.Context, base, method, path, token string, body any) (int, map[string]any, error) {
	var encoded []byte
	var err error
	if body != nil {
		encoded, err = json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
	}
	request, err := http.NewRequestWithContext(ctx, method, base+path, bytes.NewReader(encoded))
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set("Authorization", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	result := map[string]any{}
	err = json.NewDecoder(io.LimitReader(response.Body, 4<<20)).Decode(&result)
	return response.StatusCode, result, err
}

func assistProcessAPI(t *testing.T, base, method, path, token string, body any) map[string]any {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	status, result, err := assistProcessRequest(ctx, base, method, path, token, body)
	if err != nil || status < 200 || status >= 300 {
		// Do not print auth tokens or source payloads on a failing assertion.
		t.Fatalf("isolated %s %s failed: status=%d error=%v", method, path, status, err)
	}
	return result
}

func waitAssistProcessReady(t *testing.T, p *assistOwnedProcess, base string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		status, _, err := assistProcessRequest(ctx, base, "GET", "/api/health", "", nil)
		cancel()
		if err == nil && status == http.StatusOK {
			return
		}
		select {
		case <-p.done:
			t.Fatalf("isolated production main exited before readiness: %v (private log %s)", p.err, p.log)
		default:
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("isolated production main did not become ready (private log %s)", p.log)
}

func copyAssistProcessHooks(t *testing.T, root string) string {
	t.Helper()
	dest := filepath.Join(root, "hooks")
	err := filepath.WalkDir("pb_hooks", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("unexpected hook symlink: %s", path)
		}
		relative, err := filepath.Rel("pb_hooks", path)
		if err != nil {
			return err
		}
		target := filepath.Join(dest, relative)
		if entry.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0600)
	})
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dest, "lib", "assist_publication.js")
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	needle := "dao.runInTransaction(tx => { acquired = Date.now(); result = fn(tx) })"
	if strings.Count(string(raw), needle) != 1 {
		t.Fatal("transaction seam changed; update the after-commit fixture explicitly")
	}
	// The only writer instrumentation is after runInTransaction has returned:
	// an independent SQLite reader must see the committed private payload. The
	// pause never holds SQLite's writer or adds a production/test HTTP endpoint.
	barrier := `
    const fixtureBarrier = $os.getenv("FANGJI_TEST_ASSIST_BARRIER")
    if (fixtureBarrier && ["findings", "events", "derivations", "retirements"].includes(phase)) {
      let fixtureArmed = false
      try { $os.stat(fixtureBarrier + "/armed"); fixtureArmed = true } catch {}
      if (fixtureArmed) {
        $os.remove(fixtureBarrier + "/armed")
        $os.writeFile(fixtureBarrier + "/committed", toBytes(phase), 384)
        for (;;) {
          try { $os.stat(fixtureBarrier + "/release"); break } catch {}
          sleep(10)
        }
      }
    }`
	if err := os.WriteFile(file, []byte(strings.Replace(string(raw), needle, needle+barrier, 1)), 0600); err != nil {
		t.Fatal(err)
	}
	// This sentinel is downstream of the real, higher-priority OS ownership
	// guard. Its absence in process two proves bootstrap/recovery was not entered.
	sentinel := `onBootstrap((e) => {
  const path = $os.getenv("FANGJI_TEST_ASSIST_BOOTSTRAP_SEEN")
  if (path) $os.writeFile(path, toBytes(String(e.app.store().get("fangjiDataDirectoryOwner"))), 384)
  return e.next()
})`
	if err := os.WriteFile(filepath.Join(dest, "000_assist_process_fixture.pb.js"), []byte(sentinel), 0600); err != nil {
		t.Fatal(err)
	}
	return dest
}

func openAssistProcessReadOnly(t *testing.T, data string) *sql.DB {
	t.Helper()
	location := (&url.URL{Scheme: "file", Path: filepath.Join(data, "data.db")}).String()
	db, err := sql.Open("sqlite", location+"?mode=ro&_pragma=busy_timeout(1000)")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	return db
}

func assistSQLRows(t *testing.T, tx *sql.Tx, query string, args ...any) string {
	t.Helper()
	rows, err := tx.Query(query, args...)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		t.Fatal(err)
	}
	result := []map[string]any{}
	for rows.Next() {
		values, pointers := make([]any, len(columns)), make([]any, len(columns))
		for i := range pointers {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			t.Fatal(err)
		}
		row := map[string]any{}
		for i, column := range columns {
			row[column] = values[i]
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func assistProcessSnapshot(t *testing.T, db *sql.DB, project string) map[string]string {
	t.Helper()
	tx, err := db.BeginTx(context.Background(), &sql.TxOptions{ReadOnly: true})
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	visible := `(f.assist_publication='' OR EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=f.assist_publication AND p.state='published'))`
	current := visible + ` AND f.superseded_at='' AND NOT EXISTS(SELECT 1 FROM _assist_finding_retirements r JOIN assist_publications p ON p.id=r.publication AND p.state='published' WHERE r.finding=f.id)`
	return map[string]string{
		"current":   assistSQLRows(t, tx, "SELECT f.* FROM review_findings f WHERE f.project=? AND "+current+" ORDER BY f.id", project),
		"history":   assistSQLRows(t, tx, "SELECT f.* FROM review_findings f WHERE f.project=? AND "+visible+" ORDER BY f.id", project),
		"events":    assistSQLRows(t, tx, `SELECT e.* FROM verification_events e WHERE e.project=? AND (e.assist_publication='' OR EXISTS(SELECT 1 FROM assist_publications p WHERE p.id=e.assist_publication AND p.state='published')) ORDER BY e.id`, project),
		"pages":     assistSQLRows(t, tx, "SELECT * FROM pages WHERE project=? ORDER BY id", project),
		"published": assistSQLRows(t, tx, "SELECT * FROM assist_publications WHERE project=? AND state='published' ORDER BY id", project),
	}
}

func assistPrivatePayloadCounts(t *testing.T, db *sql.DB, publication string) map[string]int {
	t.Helper()
	counts := map[string]int{}
	for _, item := range []struct{ table, relation string }{
		{"review_findings", "assist_publication"}, {"verification_events", "assist_publication"},
		{"_assist_page_derivations", "publication"}, {"_assist_finding_retirements", "publication"},
	} {
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM "+item.table+" WHERE "+item.relation+"=?", publication).Scan(&count); err != nil {
			t.Fatal(err)
		}
		counts[item.table] = count
	}
	return counts
}

func TestAssistActualProcessCrashRecoveryAndExclusiveDataDirectory(t *testing.T) {
	root := t.TempDir()
	data, barrier := filepath.Join(root, "data"), filepath.Join(root, "barrier")
	if err := os.Mkdir(barrier, 0700); err != nil {
		t.Fatal(err)
	}
	hooks := copyAssistProcessHooks(t, root)
	migration, _ := startAssistProcess(t, data, hooks, "", "", "migrate", "up")
	select {
	case <-migration.done:
		if migration.err != nil {
			t.Fatalf("actual main migration failed: %v (private log %s)", migration.err, migration.log)
		}
	case <-time.After(30 * time.Second):
		t.Fatal("actual main migrations did not finish")
	}
	firstBootstrap := filepath.Join(root, "first-bootstrap-entered")
	first, base := startAssistProcess(t, data, hooks, barrier, firstBootstrap)
	waitAssistProcessReady(t, first, base)
	if seen, err := os.ReadFile(firstBootstrap); err != nil || string(seen) != "true" {
		t.Fatalf("positive control did not enter JS bootstrap with real ownership: %v", err)
	}
	login := func(base string) string {
		return assistProcessAPI(t, base, "POST", "/api/collections/users/auth-with-password", "", map[string]any{
			"identity": "assist-process@example.invalid", "password": "SyntheticProcess123!",
		})["token"].(string)
	}
	token := login(base)
	project := assistProcessAPI(t, base, "POST", "/api/fangji/projects", token, map[string]any{
		"name": "Synthetic publication crash", "accessMode": "members_only",
	})["id"].(string)
	for i := range 120 {
		row, _ := json.Marshal(map[string]string{"词条": fmt.Sprintf("甲、乙%d", i), "拼音": "ka1", "莆田IPA": "a𰻞\uEE009999", "释义": "合成"})
		assistProcessAPI(t, base, "POST", "/api/collections/pages/records", token, map[string]any{
			"project": project, "page_number": i + 1, "pdf_page": 1, "status": "pending", "ocr_row_json": string(row),
		})
	}
	path := "/api/fangji/projects/" + project + "/findings/recompute"
	old := assistProcessAPI(t, base, "POST", path, token, nil)
	if old["findings"].(float64) < 100 {
		t.Fatal("fixture must create a complete old batch larger than one stage chunk")
	}
	db := openAssistProcessReadOnly(t, data)
	before := assistProcessSnapshot(t, db, project)
	if before["current"] == "[]" {
		t.Fatal("fixture lacks a complete old publication")
	}
	if err := os.WriteFile(filepath.Join(barrier, "armed"), []byte("one committed payload"), 0600); err != nil {
		t.Fatal(err)
	}
	requestContext, cancelRequest := context.WithCancel(context.Background())
	t.Cleanup(cancelRequest)
	pending := make(chan error, 1)
	go func() {
		_, _, err := assistProcessRequest(requestContext, base, "POST", path, token, nil)
		pending <- err
	}()
	deadline := time.Now().Add(30 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(barrier, "committed")); err == nil {
			break
		}
		select {
		case err := <-pending:
			t.Fatalf("second recompute ended before its committed-stage barrier: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("no committed stage reached the after-success barrier")
		}
		time.Sleep(10 * time.Millisecond)
	}
	var publication string
	if err := db.QueryRow("SELECT id FROM assist_publications WHERE project=? AND state='staging'", project).Scan(&publication); err != nil {
		t.Fatal(err)
	}
	counts := assistPrivatePayloadCounts(t, db, publication)
	total := 0
	for _, count := range counts {
		total += count
	}
	if total == 0 {
		t.Fatal("barrier preceded COMMIT: independent read-only SQLite saw no private payload")
	}
	if !reflect.DeepEqual(before, assistProcessSnapshot(t, db, project)) {
		t.Fatal("committed staging changed old current/history/page bytes")
	}

	bootstrapSeen := filepath.Join(root, "second-bootstrap-entered")
	second, _ := startAssistProcess(t, data, hooks, "", bootstrapSeen)
	select {
	case <-second.done:
		if second.err == nil {
			t.Fatal("second backend unexpectedly accepted an owned data directory")
		}
	case <-time.After(15 * time.Second):
		second.stop(t, true)
		t.Fatal("second backend failed to reject the owned data directory promptly")
	}
	secondLog, err := os.ReadFile(second.log)
	if err != nil || !bytes.Contains(secondLog, []byte("data directory ownership: data directory is already owned by another backend instance")) {
		t.Fatalf("second backend failed for something other than the real ownership guard: %v", err)
	}
	if _, err := os.Stat(bootstrapSeen); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("second backend entered bootstrap before its ownership rejection")
	}
	var state string
	if err := db.QueryRow("SELECT state FROM assist_publications WHERE id=?", publication).Scan(&state); err != nil || state != "staging" {
		t.Fatalf("second backend mutated the live publication: state=%s error=%v", state, err)
	}
	if !reflect.DeepEqual(counts, assistPrivatePayloadCounts(t, db, publication)) || !reflect.DeepEqual(before, assistProcessSnapshot(t, db, project)) {
		t.Fatal("second backend changed committed staging or prior published bytes")
	}

	select {
	case <-first.done:
		t.Fatal("first backend exited before the deliberate crash")
	default:
	}
	first.stop(t, true) // actual kill and Wait, not close/reopen of an in-process DB
	if first.err == nil {
		t.Fatal("deliberately killed backend did not record a failed process exit")
	}
	select {
	case err := <-pending:
		if err == nil {
			t.Fatal("killed in-flight recomputation unexpectedly returned success")
		}
	case <-time.After(5 * time.Second):
		cancelRequest()
		t.Fatal("killed recompute request did not terminate")
	}
	restarted, restartedBase := startAssistProcess(t, data, hooks, "", "")
	waitAssistProcessReady(t, restarted, restartedBase)
	var failureCode string
	if err := db.QueryRow("SELECT state,failure_code FROM assist_publications WHERE id=?", publication).Scan(&state, &failureCode); err != nil || state != "aborted" || failureCode != "PROCESS_RESTARTED" {
		t.Fatalf("startup did not retain and abort interrupted bulk marker: state=%s code=%s error=%v", state, failureCode, err)
	}
	if !reflect.DeepEqual(before, assistProcessSnapshot(t, db, project)) {
		t.Fatal("crash recovery changed old current/history/page bytes")
	}
	// Observe the existing once-per-minute cleanup, without adding an endpoint or
	// bypassing the real main. Only one stage was committed, so its removal must
	// fit each real cleanup budget and never remove the marker or old history.
	cleanupStarted := time.Now()
	deadline = cleanupStarted.Add(70 * time.Second)
	for {
		after := assistPrivatePayloadCounts(t, db, publication)
		remaining := 0
		for name, count := range after {
			if count > counts[name] || counts[name]-count > 100 {
				t.Fatalf("cleanup exceeded its per-kind bound for %s", name)
			}
			remaining += count
		}
		if remaining == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("existing periodic cleanup did not remove the interrupted private stage")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := db.QueryRow("SELECT state FROM assist_publications WHERE id=?", publication).Scan(&state); err != nil || state != "aborted" {
		t.Fatal("bounded cleanup removed or changed the retained aborted marker")
	}
	if !reflect.DeepEqual(before, assistProcessSnapshot(t, db, project)) {
		t.Fatal("bounded cleanup changed old published history")
	}
	result := assistProcessAPI(t, restartedBase, "POST", path, login(restartedBase), nil)
	if result["publication"] == old["publication"] || result["findings"] != old["findings"] {
		t.Fatal("subsequent real HTTP recomputation failed to publish a complete replacement")
	}
	restarted.stop(t, false)
	phase, err := os.ReadFile(filepath.Join(barrier, "committed"))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("actual main: committed phase=%s payloads=%v old findings=%v cleanup observation=%s; exclusive ownership, kill/wait/restart, retained history, bounded cleanup and subsequent recomputation passed", phase, counts, old["findings"], time.Since(cleanupStarted).Round(time.Millisecond))
}
