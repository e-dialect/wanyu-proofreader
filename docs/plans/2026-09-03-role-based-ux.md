# Role-based UX Implementation Plan

> **已被取代（2026-10-05）。** 本计划不再作为验收依据。界面的可核对约定以 [docs/DESIGN.md](../DESIGN.md) 与 [2026-10-02-ui-architecture.md](2026-10-02-ui-architecture.md) 为准。下文保留作当时的实现记录。`IpaKeyboard.vue` 已改名为 `frontend/src/components/editor/ProjectKeyboard.vue`。

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Fangji's proofreading and administration workflows easier to understand, safer to operate, and faster to navigate without changing backend contracts.

**Architecture:** Add a small pure `workspaceInsights` module for role-specific status derivation and test it with Node's built-in test runner. Recompose the existing Vue views around those derived states, then extend the shared CSS tokens and responsive components. Keep PocketBase service calls and the two-pass workflow intact.

**Tech Stack:** Vue 3 `<script setup>`, Vue Router, plain CSS, Node test runner, Vite.

---

### Task 1: Role insight helpers

**Files:**
- Create: `frontend/src/lib/workspaceInsights.js`
- Create: `frontend/tests/workspaceInsights.test.js`

**Steps:**

1. Write failing tests for page status totals, per-project urgency ordering, proofreader action labels, changed fields, and arbitration differences.
2. Run `cd frontend && npm test -- --test-name-pattern="workspace"` and confirm the new module is missing.
3. Implement pure helpers using `PAGE_STATUS`, with null-safe numeric inputs and stable project order.
4. Run `cd frontend && npm test` and confirm all helper tests pass.
5. Commit the tested insight layer with the proofreader UI in Task 2.

### Task 2: Proofreader workspace

**Files:**
- Modify: `frontend/src/services/pagesService.js`
- Modify: `frontend/src/composables/useTaskNeighbors.js`
- Modify: `frontend/src/views/proofreader/TaskHallView.vue`
- Modify: `frontend/src/views/proofreader/ProofreadEditorView.vue`
- Modify: `frontend/src/components/editor/ProjectKeyboard.vue`（原 `IpaKeyboard.vue`，文件已改名）
- Modify: `frontend/src/style.css`

**Steps:**

1. Preserve each user's active page in queue summaries and expose neighbor position/count from the task composable.
2. Replace the project table with responsive action cards and role-relevant summary metrics.
3. Replace horizontal field editing with vertical source/edit cards, add restore actions and change summaries.
4. Add an accessible submission review tray before calling `submitTwoPassProofread`.
5. Make IPA/BUC groups collapsible while preserving mouse-down selection behavior.
6. Run `cd frontend && npm test && npm run build`.
7. Commit as `feat(proofreader): streamline the proofreading workspace`.

### Task 3: Admin operations and arbitration

**Files:**
- Modify: `frontend/src/views/admin/DashboardView.vue`
- Modify: `frontend/src/views/admin/ProjectDetailView.vue`
- Modify: `frontend/src/views/admin/ArbitrationView.vue`
- Modify: `frontend/src/style.css`
- Test: `frontend/tests/workspaceInsights.test.js`

**Steps:**

1. Drive dashboard totals and project urgency from the tested insight helpers.
2. Add direct links from a project's arbitration count to `?status=arbitration` and hydrate that query in project detail.
3. Add clickable status overview, section navigation, and stronger selected-item feedback to project detail.
4. In arbitration, default to differences, track explicit resolution per differing field, add bulk source actions, and prevent submission while unresolved.
5. Add a final confirmation summary and leave protection for unfinished arbitration work.
6. Run `cd frontend && npm test && npm run build`.
7. Commit as `feat(admin): prioritize project exceptions and safe arbitration`.

### Task 4: Shared polish and documentation

**Files:**
- Modify: `frontend/src/style.css`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Steps:**

1. Finalize archival-workbench tokens, typography, focus styles, responsive navigation, skeleton/empty states, and reduced-motion behavior.
2. Document the role-specific flows and submission/exception behavior.
3. Run `git diff --check`, `cd frontend && npm test`, `cd frontend && npm run build`, and `docker compose config`.
4. Commit as `docs: explain the role-based workspace experience`.

### Task 5: Pull request

1. Review the branch commit-by-commit and confirm the worktree contains no generated files or unrelated changes.
2. Push `feat/role-based-ux` to `origin`.
3. Create a PR against `main` with scope, UX evidence, accessibility notes, verification results, risk, and rollback information.
4. Request review from `aB0T-bupt`, the contributor of the workflow this refines.
