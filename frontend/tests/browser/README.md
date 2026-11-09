# Review workspace browser regression

`mobile-field-flow.cjs` runs with the `editor` group. It mounts the real editor
and arbitration workspace at 320×844, 390×844 and 640×400, checks the first-field
overview entry, visible next-field action, one-row footer, original textarea
identity and caret insertion, and verifies that overview/confirmation alone
never submits. Read-only review has no submission entry; arbitration keeps its
unresolved-field gate. Receipts and screenshots are in
`output/playwright/mobile-field-flow/`. These viewport checks do not verify
native phone keyboards or IMEs.

`editor-states.cjs` also checks stable task-header feedback for local drafts,
storage failure, offline/online signals and server failures. A held claim request
after a successful submit confirms that server submission and next-task claiming
remain distinct. The full-App `workbench.cjs` and discovery regression verify
the shared task/project directory geometry, retained results on refresh failure,
permission links and existing join/claim behavior.

`run_frontend_quality_browser.py --only components` runs `reka-controls.cjs`
against the real public components: empty-string and numeric values, reordered
options, an asynchronous disabled change while open, disabled/busy actions,
keyboard menu dismissal, menu-to-AppModal focus return, 1280/390/320px portal
geometry and reduced-motion preferences. It uses no backend requests.

The `workbench` group also runs `entry-list-experience.cjs` against a disposable
real backend. It checks exact CSV values, default-hidden batch selection,
select/exit, details, required quality basis, URL filters, reload, 503 retention
and retry, stale empty-result suppression and mobile summaries. Its screenshots
and JSON receipt are in `output/playwright/entry-list-experience/`.

With Vite running on port 5173, run `node tests/browser/auth-navigation.cjs`
from the frontend directory for login/registration navigation regression.
It mounts the real views with a memory router and synthetic authentication,
covering desktop/mobile round trips, automatic return after registration,
restored destinations with query/hash, and the default workspace destination.
No backend requests are made. Screenshots are saved in
`output/playwright/auth-navigation` at the repository root.
Set `BROWSER_CHANNEL=msedge` for installed Edge on Windows, or
`REVIEW_BASE_URL` for a different Vite URL.

With Vite running on port 5173, run `node tests/browser/discovery.cjs` from
the frontend directory for project joining regression. The real discovery view
uses synthetic in-memory projects and never contacts a backend. Desktop/mobile
checks cover Enter submission, repeated Enter while busy, error/input retention,
retry, public-project joining and existing-member navigation. Screenshots are
saved in `output/playwright/discovery` at the repository root.
Set `BROWSER_CHANNEL=msedge` for installed Edge on Windows, or
`REVIEW_BASE_URL` for a different Vite URL.

Start Vite on port 5173 with `npm run dev`, then run `node tests/browser/review.cjs`
from the frontend directory with Playwright available (locally or through `NODE_PATH`).
The default browser is installed Chrome; set `BROWSER_CHANNEL` to choose another channel.

The fixture mounts the real proofreading and arbitration views with a memory router.
All API requests are intercepted and answered with synthetic records and an embedded
sample PDF; no backend data is read or written. Checks cover the desktop source/editor split and collapsible character tray,
mobile character insertion, pinned keyboard, mobile group switching, field navigation and overview.
Regression scenarios focus the third field on desktop, switch to mobile, replace its selection,
restore another field's remembered caret, ignore delayed events from hidden fields, and repeat
the desktop/mobile transition for both views. The mock uses the restricted task PDF endpoint
and checks source-page mapping instead of requesting original file URLs. Screenshots are written to `/tmp/review-*.png` for visual inspection.

Native iOS/Android keyboard behavior still requires device testing; desktop viewport
emulation cannot verify the operating system's keyboard or IME.

Run `node tests/browser/modal.cjs` against the same Vite server for submission
confirmation regression coverage. It mounts both real review views with synthetic
API responses and checks desktop/mobile Tab and Shift+Tab loops (eight presses
each), Escape/cancel/backdrop dismissal, background scroll locking, focus return
to each trigger, and arbitration's unresolved-field gate. It also verifies that
reviewing and dismissing never submits a record. Screenshots of both dialogs and
the restored trigger are saved in `output/playwright/modal` at the repository root.
Set `MODAL_SCREENSHOTS` to change this directory, `REVIEW_BASE_URL` to change the
server URL, or `BROWSER_CHANNEL=msedge` to use installed Edge on Windows.

The suite also loads the real shipped preset in desktop/mobile proofreading and
arbitration: an exact combining tilde, its dotted-circle label, and both tortoise
shell brackets are inserted at the saved caret. Synthetic screenshots are saved
to `/tmp/keyboard-symbols-*.png`.

Regrouping checks assert the 24-key initial group, a deduplicated total, identical
shortcut/category insertion, cross-group selection replacement, reachability of
all categories and complete pinyin insertion. The default layouts are captured
with synthetic data in `/tmp/keyboard-default-*.png`.

Run `node tests/browser/repository-review.cjs` for repository audit regressions.
The fixture mounts the real App, AdminLayout, source workspace, and proofreader
editor with intercepted synthetic APIs. It checks project identity remounting,
query-preserving component keys, draft flush before a fast task switch, account
replacement, and logout removing the old private view. Its normal/empty/mobile
screenshots and request report are in `output/playwright/repository-review`.
The same script is included in `backend/tests/run_frontend_quality_browser.py`
and therefore in the existing CI mounted browser job; `--only repository` runs
this regression alone. Native browser APIs are exercised; synthetic data does
not establish human acceptance or real-language quality.

`pdf-lifecycle.cjs` also runs in the `repository` group. It holds the first
already-authorized blob read at a request barrier, then uses the real app to
log out, leave the editor, or replace the account while the read is pending.
The actual bundled PDF.js worker remains unmodified and every `pageerror`
fails the scenario. It also checks ordinary canvas rendering/zoom, source-read
failure, and invalid PDF feedback. `REVIEW_BASE_URL` selects the local fixture
server; `PDF_LIFECYCLE_OUTPUT` selects the screenshot/report directory (default
`output/playwright/pdf-lifecycle`). Cancellation is awaited explicitly; there
is no fixed sleep or exception-message allowlist.

`source-fidelity.cjs` runs in the same `repository` group using the real source
workspace and App error boundary. Synthetic responses cover empty reports,
empty/filtered review queues, clean-form refresh, preserved same-version drafts,
changed-server conflicts blocking both button and native form submission,
explicit adoption of the latest record, and the clean baseline after saving.
The first response is held behind a request barrier to confirm that a visible
heading does not establish list readiness. Its report and mobile conflict
screenshot are in `repository-review/source-fidelity/`.

`normalization-draft.cjs` mounts the real normalization panel with explicit
synthetic API snapshots. It verifies same-basis refresh, changed-source stale
lockout and visible old drafts, explicit fresh input, a GET-to-save 409, and
read-only access after a row leaves the queue. Screenshots cover 1280 and 390px.
It runs with the unified runner's `repository` group; set `REVIEW_BASE_URL` and
`NORMALIZATION_DRAFT_OUTPUT` to override its default local server/output.

`editor-experience.cjs` checks the focused work surface with the same synthetic
API fixture: the character tray starts closed, pointer and keyboard resizing
respect bounds, user/project preferences survive reload, codepoint search and
recent keys insert exact values at the remembered caret, and the mobile source
pane leaves the input visible. It also verifies that a source blocker expands
the agreement panel and that difference-first arbitration leaves source
judgments unrecorded. Screenshots are saved to `output/playwright/editor-experience`.
The unified runner includes this check in its `editor` group. These viewport
checks do not establish native iOS/Android keyboard or IME acceptance.

The unified runner's `workbench` group runs `auth-navigation.cjs`, `discovery.cjs`,
`seed_demo.mjs`, `workbench.cjs`, and `review-bundle.cjs` in that order. The last
two use the real App and disposable backend: workbench journeys cover task and
queue restoration, while bundle import covers read-only validation, malformed
packages, unknown rights references, human confirmation, exact original values,
and idempotent replay. Use `--only workbench` to run this group locally.

`import-errors.cjs` also runs in the `workbench` group against the real disposable
backend. A mixed CSV creates one valid row and 205 error records. The script
visits every error page from the historical batch, downloads the complete JSON
report, checks exact stored values and counts, refuses a failed later page,
cancels an in-flight report without producing a file, and reopens the same CSV
through the current import UI. Screenshots and its receipt are saved to
`output/playwright/import-errors`; the mobile check covers whole-page overflow.

CI's existing `backend-unicode` job invokes the unified runner without `--only`,
so both `editor` and `workbench` execute. It explicitly selects the installed
Chromium browser and requires their screenshots and final JSON receipts before
passing. The `frontend-quality-browser` artifact contains all of
`output/playwright/`, including `workbench/`, `editor-experience/`, and
`frontend-quality/review-bundle/`. It also preserves the reviewed, checked-in
`docs/evidence/workbench-experience-20261107/before-after/` comparison. CI checks
these comparison files exist; it does not recreate the historical baseline
screenshots or turn them into a new comparison run. Partial runtime evidence is
uploaded even if a browser regression fails.

`components` also runs `job-observer.cjs` against the mounted production observer,
status panel and CSV controls with intercepted synthetic responses. It verifies shared
GETs, stale snapshots, hidden/offline recovery, token refresh/logout fencing, conversion
progress without a fabricated denominator, read-only CSV20 and 390/1440px layout.
Screenshots and the numeric receipt are in `output/playwright/job-observer/`.


`--only delivery` 复用 delivery_integration.mjs 生成的真实临时实例，自动启动原生编选/交付深链与未保存保护浏览器回归；不依赖手工设置外部fixture。完整runner也会执行此组，输出位于output/playwright/frontend-quality/delivery。repository组包含主动退出七项检查：小于500ms的草稿同步保存、失败返回、切账号失效和唯一副本保留。
`workspace-ready.cjs` runs in `components` and mounts the real workspace with
synthetic API responses. It verifies that required queue/management failures and
a held retry do not report `workspace_ready`; successful retry reports once,
and a later refresh does not duplicate it. Proofreaders require access and queue
data, while management data is required only when the successful access context
selected that reader. Set `REVIEW_BASE_URL` and `WORKSPACE_READY_OUTPUT` to override
the local fixture server and `output/playwright/workspace-ready/` receipt path.
