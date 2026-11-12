<template>
  <main class="container page adoption-workspace">
    <WorkspaceLeaveGuard
      :dirty="dirty"
      :preserve-query="false"
      :bypass="accessLost || unavailable"
    />
    <ProjectWorkspaceNav :project-id="projectId" active="delivery" />
    <BatchReportReturn v-if="!accessLost && !projectUnavailable" :project-id="projectId" />
    <header class="page-heading adoption-heading">
      <div>
        <div class="page-eyebrow">项目交付</div>
        <h1>
          {{
            screen === 'create'
              ? '新建编选批次'
              : screen === 'detail'
                ? '核对本批交付范围'
                : '用途编选'
          }}
        </h1>
        <p>按用途与接收方整理交付范围，处理例外后明确确认。</p>
      </div>
      <div class="adoption-actions">
        <AppButton
          v-if="screen !== 'list'"
          type="button"
          :disabled="busy"
          @click="navigate({ listPage: historyPage })"
        >
          返回批次列表
        </AppButton>
        <AppButton
          v-else-if="!accessLost && !projectUnavailable"
          type="button"
          variant="primary"
          :disabled="loading || busy"
          @click="openCreate"
        >
          新建编选批次
        </AppButton>
      </div>
    </header>
    <AppDisclosure class="adoption-explanation mb-4" label="编选与校对、用途许可的关系">
      <p>
        这里的「编选」是整批交付取舍，不是仲裁台里选哪一份校对结果的「采用」；校对成果与状态保持原样。用途尚未允许的来源继续由服务端阻断。
      </p>
    </AppDisclosure>
    <AppStatusPanel v-if="loading && !loaded" state="pending" message="正在加载编选批次…" />
    <AppStatusPanel
      v-if="loadError && !loaded"
      state="error"
      :message="loadError"
      retry-label="重试"
      :busy="loading"
      @retry="load()"
    />
    <RouterLink v-if="projectUnavailable" to="/admin" class="btn btn-secondary mb-4">
      返回项目列表
    </RouterLink>
    <div v-if="visibleCreateConflict" class="alert alert-warning" role="alert">
      <p>本项目已有同用途的未确认编选。它可能包含其他批次，请打开后核对范围。</p>
      <button
        type="button"
        class="btn btn-secondary btn-sm"
        :disabled="busy"
        @click="selectBatch(visibleCreateConflict.id)"
      >
        查看已有未确认编选
      </button>
    </div>
    <div v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</div>
    <p v-if="message" class="alert alert-success" role="status">{{ message }}</p>
    <AppStatusPanel
      v-if="loadError && loaded && screen !== 'list'"
      state="error"
      :message="loadError"
      retry-label="重试批次详情"
      :busy="loading"
      @retry="load()"
    />

    <template v-if="loaded">
      <section v-if="screen === 'create'" class="card mb-4">
        <nav class="adoption-steps" aria-label="创建编选步骤">
          <span :aria-current="createStep === 1 ? 'step' : undefined">1 用途与接收方</span
          ><span :aria-current="createStep === 2 ? 'step' : undefined">2 条目范围</span
          ><span>3 数量与确认</span>
        </nav>
        <h2>{{ createStep === 1 ? '这批资料交给谁、用来做什么' : '选择本批需要交付的条目' }}</h2>
        <p class="text-muted">
          创建后先预览数量，再由你确认范围。来源用途未获允许时，仍会阻止进入交付范围。
        </p>
        <p v-if="createStep === 2" class="adoption-create-summary">
          <strong>{{ createForm.recipient }}</strong> · {{ purposeLabel(createForm.purpose) }}
        </p>
        <div v-if="reportScopeRequested" class="adoption-report-scope">
          <p v-if="reportScopePending" role="status">正在核对报告所用的导入批次…</p>
          <div v-else-if="reportScopeError" class="alert alert-warning" role="alert">
            <p>{{ reportScopeError }}</p>
            <button
              v-if="requestedReportBatch"
              type="button"
              class="btn btn-secondary btn-sm"
              @click="verifyReportScope"
            >
              重新核对批次
            </button>
          </div>
          <template v-else-if="verifiedReportBatch">
            <p v-if="customReportScope">
              自选导入批次。至少保留一个批次；若需整个项目，请返回编选列表新建。
            </p>
            <p v-else>
              导入范围仅限 <strong>{{ verifiedReportBatch.filename }}</strong> ·
              {{ verifiedReportBatch.entries }} 条已入册
            </p>
            <button
              v-if="createStep === 2 && !customReportScope"
              type="button"
              class="btn btn-quiet btn-sm"
              :disabled="busy"
              @click="openCustomReportScope"
            >
              改为自选范围
            </button>
          </template>
        </div>
        <form @submit.prevent="createStep === 1 ? nextCreateStep() : create()">
          <fieldset class="adoption-form-body" :disabled="busy || loading">
            <div v-show="createStep === 1" class="adoption-form-grid">
              <AppField layout="plain"
                ><template #label>用途 </template
                ><select v-model="createForm.purpose" class="form-control" required>
                  <option v-for="code in purposes" :key="code" :value="code">
                    {{ purposeLabel(code) }}
                  </option>
                </select>
              </AppField>
              <AppField layout="plain"
                ><template #label>接收方 </template
                ><input
                  v-model="createForm.recipient"
                  class="form-control"
                  maxlength="120"
                  required
                  placeholder="例如：乡声集盒春节版"
                />
              </AppField>
            </div>
            <div v-show="createStep === 2">
              <AppField
                ><template #label>校对范围</template
                ><select v-model="scopePreset" class="form-control" @change="applyScopePreset">
                  <option value="ready">已校对或已通过的条目</option>
                  <option value="custom">自定义校对状态</option>
                </select></AppField
              >
              <fieldset v-if="scopePreset === 'custom'" class="adoption-fieldset">
                <legend>选择校对状态</legend>
                <label v-for="code in pageStatuses" :key="code" class="adoption-check"
                  ><input v-model="createForm.statuses" type="checkbox" :value="code" />{{
                    statusLabel(code)
                  }}</label
                >
              </fieldset>
              <AppDisclosure class="adoption-optional mb-3" label="质量与记音要求（可选）">
                <fieldset class="adoption-fieldset">
                  <legend>质量状态（不勾选表示不限）</legend>
                  <label v-for="code in qualityStates" :key="code" class="adoption-check"
                    ><input v-model="createForm.qualityStates" type="checkbox" :value="code" />{{
                      qualityStateLabel(code)
                    }}</label
                  >
                </fieldset>
                <label class="adoption-check"
                  ><input
                    v-model="createForm.requirePinyin"
                    type="checkbox"
                  />要求记音归一已定稿</label
                >
              </AppDisclosure>
              <ImportBatchPicker
                v-if="!reportScopeRequested || (verifiedReportBatch && customReportScope)"
                :require-selection="reportScopeRequested"
                v-model="createForm.importJobsText"
                :project-id="projectId"
                :disabled="busy"
                @access-error="pageScope.invalidate($event)"
              />
              <AppField layout="plain"
                ><template #label>说明（可选） </template
                ><textarea
                  v-model="createForm.note"
                  class="form-control"
                  maxlength="500"
                  rows="2"
                ></textarea>
              </AppField>
            </div>
            <div class="adoption-actions">
              <AppButton
                v-if="createStep === 2"
                type="button"
                :disabled="busy || loading"
                @click="createStep = 1"
              >
                上一步</AppButton
              ><AppButton
                type="submit"
                variant="primary"
                :loading="busy"
                :disabled="
                  loading || !reportScopeReady || (createStep === 2 && !hasSelectedReportScope)
                "
                loading-label="正在创建…"
              >
                {{ createStep === 1 ? '下一步：选择范围' : '创建并预览数量' }}
              </AppButton>
            </div>
          </fieldset>
        </form>
      </section>

      <nav v-if="screen === 'detail' && current" class="adoption-tabs" aria-label="编选批次步骤">
        <button
          type="button"
          :class="detailTab === 'overview' ? 'is-active' : ''"
          :aria-current="detailTab === 'overview' ? 'page' : undefined"
          @click="changeTab('overview')"
        >
          范围与确认
        </button>
        <button
          type="button"
          :class="detailTab === 'exceptions' ? 'is-active' : ''"
          :aria-current="detailTab === 'exceptions' ? 'page' : undefined"
          @click="changeTab('exceptions')"
        >
          处理例外 <span v-if="exceptions.pendingTotal">{{ exceptions.pendingTotal }}</span>
        </button>
        <button
          type="button"
          :class="detailTab === 'history' ? 'is-active' : ''"
          :aria-current="detailTab === 'history' ? 'page' : undefined"
          @click="changeTab('history')"
        >
          判断与历史
        </button>
      </nav>
      <section v-if="screen === 'detail' && current" class="card mb-4">
        <header class="adoption-batch-head">
          <h2>{{ current.recipient }}</h2>
          <span class="badge">{{ batchStatusLabel(current.status) }}</span>
        </header>
        <p>{{ purposeLabel(current.purpose) }} · 规则：{{ ruleSummary(current.rule) }}</p>
        <p v-if="current.note">{{ current.note }}</p>

        <template v-if="detailTab === 'overview'">
          <p class="adoption-next-step">
            <strong>下一步</strong>
            {{ nextStepHint }}
          </p>
          <div class="adoption-counts">
            <div class="adoption-count">
              <span class="adoption-count-value">{{ counts.total }}</span
              ><span>项目条目</span>
            </div>
            <div class="adoption-count">
              <span class="adoption-count-value">{{ counts.selected }}</span
              ><span>进入本批</span>
            </div>
            <div class="adoption-count">
              <span class="adoption-count-value">{{ counts.excluded }}</span
              ><span>已定不进入</span>
            </div>
            <div class="adoption-count">
              <span class="adoption-count-value">{{ counts.pending }}</span
              ><span title="待处理（规则判不了）">待处理</span>
            </div>
          </div>
          <p v-if="current.status !== 'draft'" class="text-sm text-muted">
            项目条目是统计时的项目总数。进入本批只计实际选入的条目，所选导入范围之外的条目计入「已定不进入」。
          </p>
          <p v-if="!consistent" class="alert alert-warning" role="alert">
            三个数之和对不上总数，界面不照抄：请重新预览；若仍不一致，说明数据被绕过接口改过。
          </p>
          <div v-else-if="counts.pending > 0" class="alert alert-warning" role="alert">
            <p>
              还有
              {{ counts.pending }} 条待处理。确认当前范围后，本批资料仍会明确标记为尚未完整处理。
            </p>
            <details class="mt-2">
              <summary>查看清单标记</summary>
              <p>确认后导出的清单会写明 <code>complete: false</code>，不会把部分结果冒充全量。</p>
            </details>
          </div>
          <p v-if="batchEvents.stale" class="alert alert-warning" role="alert">
            这一批确认之后，来源的用途权利变过。采用范围可能需要重评——重评只会追加一条记录，
            不会改写确认时的数字。
          </p>

          <details v-if="current.reasons.length" class="mt-3">
            <summary>查看范围外与待定理由</summary>
            <ul class="adoption-reasons">
              <li v-for="item in current.reasons" :key="item.code">
                {{ reasonLabel(item.code) }} · {{ item.count }} 条
              </li>
            </ul>
          </details>

          <div class="adoption-actions">
            <RouterLink
              v-if="current.status === 'confirmed' && nativeDeliveryEnabled"
              class="btn btn-primary"
              :to="{
                path: `/admin/projects/${projectId}/deliveries`,
                query: { view: 'prepare', adoption: current.id, ...reportQuery }
              }"
              >准备交付包</RouterLink
            >
            <button
              v-if="current.status === 'confirmed'"
              class="btn"
              :class="nativeDeliveryEnabled ? 'btn-secondary' : 'btn-primary'"
              :disabled="busy || loading"
              @click="exportManifest('select')"
            >
              导出本批清单
            </button>
            <button
              v-else-if="counts.pending > 0 && current.status === 'previewed'"
              class="btn btn-primary"
              :disabled="busy || loading"
              @click="changeTab('exceptions')"
            >
              处理 {{ counts.pending }} 条待定条目
            </button>
            <button
              v-else-if="current.status === 'previewed'"
              class="btn btn-primary"
              :disabled="busy || loading || !consistent"
              @click="openConfirmation"
            >
              确认本批采用范围
            </button>
            <button v-else class="btn btn-primary" :disabled="busy || loading" @click="preview">
              预览并核对数量
            </button>
            <details class="adoption-more">
              <summary>更多操作</summary>
              <div class="adoption-actions">
                <button
                  class="btn btn-secondary"
                  :disabled="busy || loading || current.status === 'confirmed'"
                  @click="preview"
                >
                  重新预览数量
                </button>
                <button
                  v-if="current.status !== 'confirmed' && counts.pending > 0"
                  class="btn btn-secondary"
                  :disabled="busy || loading || !consistent || current.status !== 'previewed'"
                  @click="openConfirmation"
                >
                  确认当前范围（保留待处理记录）
                </button>
                <button class="btn btn-secondary" :disabled="busy || loading" @click="reevaluate">
                  按当前数据重新评估
                </button>
                <button
                  v-if="current.status !== 'confirmed'"
                  class="btn btn-secondary"
                  :disabled="busy || loading"
                  @click="exportManifest('select')"
                >
                  导出本批清单
                </button>
                <button
                  class="btn btn-quiet"
                  :disabled="busy || loading"
                  @click="exportManifest('all')"
                >
                  导出全部条目（需平台管理员）
                </button>
                <button
                  v-if="current.status !== 'confirmed'"
                  class="btn btn-quiet"
                  :disabled="busy || loading"
                  @click="openRemoval"
                >
                  删除这一批
                </button>
              </div>
            </details>
          </div>
          <p class="adoption-hint">导出默认只含进入本批的条目；清单另附未采用与待处理的数量。</p>
        </template>
        <template v-if="detailTab === 'history'">
          <AppPagination
            :page="batchEvents.page || 1"
            :total-pages="batchEvents.totalPages || 1"
            :busy="loading || busy"
            label="编选事件分页"
            @change="changePage"
          />
          <p v-if="!batchEvents.events.length" class="text-muted">
            这一批还没有重评或权利变更记录。
          </p>
          <details v-if="batchEvents.events.length" class="mt-3" open>
            <summary>这一批的事件（{{ batchEvents.events.length }}）</summary>
            <ul class="adoption-reasons">
              <li v-for="item in batchEvents.events" :key="item.id">
                {{ eventKindLabel(item.kind) }} · {{ item.created }}
                <span v-if="item.affected"> · 涉及 {{ item.affected }} 条</span>
                <div>{{ item.note }}</div>
                <div v-if="item.stored" class="adoption-hint">
                  确认时 {{ item.stored.selected }}/{{ item.stored.total }} → 重评时
                  {{ item.current.selected }}/{{ item.current.total }}
                </div>
              </li>
            </ul>
          </details>
        </template>
      </section>

      <section
        v-if="screen === 'detail' && current && detailTab === 'exceptions'"
        class="card mb-4"
      >
        <h2>处理例外</h2>
        <AppPagination
          :page="exceptions.page || 1"
          :total-pages="exceptions.totalPages || 1"
          :busy="loading || busy"
          label="待处理例外分页"
          @change="changePage"
        />
        <p v-if="exceptions.pendingTotal">
          {{ exceptions.pendingTotal }} 条待处理。当前页 {{ exceptions.pending.length }} 条：
          给结论、选理由、写依据，三样都留痕。改动例外会把批次退回草稿，需要重新预览再确认。
        </p>
        <div v-else class="adoption-exceptions-done">
          <p class="empty-state-text">没有待处理的例外。</p>
          <p class="text-muted">返回范围与确认，核对本批数量后继续。</p>
          <AppButton variant="primary" :disabled="busy || loading" @click="changeTab('overview')">
            返回核对数量
          </AppButton>
        </div>
        <AppField v-if="exceptions.pending.length"
          ><template #label>选择待处理条目</template
          ><select
            :value="activeExceptionId"
            class="form-control"
            @change="navigate({ ...route.query, exception: $event.target.value })"
          >
            <option v-for="item in exceptions.pending" :key="item.page" :value="item.page">
              第 {{ item.pageNumber }} 条 · {{ reasonLabel(item.reason) }}
            </option>
          </select></AppField
        >
        <article v-for="item in visibleExceptions" :key="item.page" class="adoption-pending">
          <h3>第 {{ item.pageNumber }} 条 · {{ reasonLabel(item.reason) }}</h3>
          <div class="adoption-form-grid">
            <AppField layout="plain"
              ><template #label>结论 </template
              ><select v-model="draftFor(item.page).decision" class="form-control">
                <option value="select">{{ DECISION_LABELS.select }}</option>
                <option value="exclude">{{ DECISION_LABELS.exclude }}</option>
              </select>
            </AppField>
            <AppField v-if="draftFor(item.page).decision === 'exclude'" layout="plain"
              ><template #label>理由 </template
              ><select v-model="draftFor(item.page).reason" class="form-control">
                <option value="">请选择理由</option>
                <option v-for="code in reasonCodes" :key="code" :value="code">
                  {{ reasonLabel(code) }}
                </option>
              </select>
            </AppField>
          </div>
          <AppField layout="plain"
            ><template #label>依据 </template
            ><input
              v-model="draftFor(item.page).note"
              class="form-control"
              maxlength="500"
              placeholder="写清为什么这样判，例如取得书面许可、缺字表已补齐"
            />
          </AppField>
          <button
            class="btn btn-secondary btn-sm mt-3"
            :disabled="busy || loading"
            @click="decide(item.page)"
          >
            保存这一条
          </button>
        </article>

        <details v-if="exceptions.exceptions.length" class="mt-3" :open="Boolean(exceptionQuery)">
          <summary>
            已处理的例外（{{ exceptions.decidedTotal || exceptions.exceptions.length }}）
          </summary>
          <AppPagination
            :page="exceptions.decidedPage || 1"
            :total-pages="exceptions.decidedPages || 1"
            :busy="loading || busy"
            label="已处理例外分页"
            @change="navigate({ ...route.query, decidedPage: $event })"
          />
          <ul class="adoption-reasons">
            <li v-for="item in exceptions.exceptions" :key="item.page">
              {{ DECISION_LABELS[item.decision] || item.decision }}
              <span v-if="item.reason"> · {{ reasonLabel(item.reason) }}</span>
              · {{ item.note }} · {{ item.decidedAt }}
            </li>
          </ul>
        </details>
      </section>

      <section v-if="screen === 'list'" class="card mb-4" :aria-busy="loading">
        <h2>编选批次</h2>
        <AppStatusPanel v-if="loading" state="pending" message="正在加载历史批次…" />
        <div v-if="loadError" class="alert alert-error" role="alert">
          {{ loadError }}
          <button class="btn btn-secondary btn-sm" :disabled="loading" @click="load()">重试</button>
        </div>
        <AppStatusPanel
          v-if="!loading && !loadError && !batches.length"
          state="empty"
          reason="none"
          message="这个项目还没有编选批次。"
        />
        <ul class="adoption-history">
          <li
            v-for="item in batches"
            :key="item.id"
            :class="{ 'adoption-history-current': item.id === currentId }"
          >
            <button
              class="btn btn-quiet adoption-history-trigger"
              :disabled="busy || loading"
              @click="selectBatch(item.id)"
            >
              <strong>{{ item.recipient }}</strong
              ><span class="adoption-hint"
                >{{ purposeLabel(item.purpose) }} · {{ batchStatusLabel(item.status) }} ·
                {{ item.counts.selected }}/{{ item.counts.total }} 条进入本批</span
              >
            </button>
            <span class="adoption-hint">{{ new Date(item.created).toLocaleString('zh-CN') }}</span>
          </li>
        </ul>
        <AppPagination
          v-if="historyTotalItems"
          :page="historyPage"
          :total-pages="historyTotalPages"
          :busy="busy || loading"
          label="编选历史分页"
          button-class="btn btn-secondary btn-sm"
          @change="changePage"
        >
          <template #position
            >第 {{ historyPage }} / {{ historyTotalPages }} 页 · 共
            {{ historyTotalItems }} 批</template
          >
        </AppPagination>
      </section>
      <section v-if="screen === 'list' && summary?.batches?.total" class="card mb-4">
        <details>
          <summary>已确认批次统计与排除理由</summary>
          <p>
            数字取各批确认时的值（那是交付依据）；「需重评」只表示确认之后用途权利变过，
            不等于已经改过范围。
          </p>
          <dl class="adoption-metrics">
            <div class="adoption-metric">
              <dt>批次</dt>
              <dd>{{ summary.batches.total }}</dd>
              <small
                >草稿 {{ summary.batches.byStatus.draft || 0 }} · 已预览
                {{ summary.batches.byStatus.previewed || 0 }} · 已确认
                {{ summary.batches.byStatus.confirmed || 0 }}</small
              >
            </div>
            <div class="adoption-metric">
              <dt>已确认范围</dt>
              <dd>{{ summary.confirmed.selected }}/{{ summary.confirmed.total }}</dd>
              <small>条进入本批；待处理 {{ summary.confirmed.pending }} 条</small>
            </div>
            <div class="adoption-metric">
              <dt>例外</dt>
              <dd>{{ summary.exceptions.decided }}</dd>
              <small>条已处理</small>
            </div>
            <div class="adoption-metric">
              <dt>需重评</dt>
              <dd>{{ summary.events.staleBatches }}</dd>
              <small
                >批在确认后遇到权利变更（另有 {{ summary.events.reevaluated }} 次重评记录）</small
              >
            </div>
          </dl>
          <p v-if="!summary.confirmed.complete" class="adoption-hint">
            有已确认批次仍带待处理条目：它们导出的清单里 <code>complete</code> 是
            <code>false</code>。
          </p>
          <div v-if="summary.reasons.length" class="mt-3">
            <h3 class="adoption-subhead">已确认批次的排除理由分布</h3>
            <ul class="adoption-reasons">
              <li v-for="item in summary.reasons" :key="item.code">
                {{ reasonLabel(item.code) }} · {{ item.count }} 条
              </li>
            </ul>
          </div>
        </details>
      </section>
    </template>
    <ConfirmDialog
      :open="confirmOpen && Boolean(current)"
      title-id="adoption-confirm-title"
      :busy="busy"
      :close-on-backdrop="!busy"
      :close-on-esc="!busy"
      @close="confirmOpen = false"
    >
      <h2 id="adoption-confirm-title">确认本批采用范围</h2>
      <p v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</p>
      <p>交给 {{ current?.recipient }} · {{ purposeLabel(current?.purpose) }}。</p>
      <p>
        进入 {{ counts.selected }} 条，已定不进入 {{ counts.excluded }} 条，待处理
        {{ counts.pending }} 条。确认后保留这一次的规则、数量与凭据。
      </p>
      <p v-if="counts.pending" class="alert alert-warning" role="alert">
        仍有待处理条目；清单会明确标为未完整处理，且不会放宽来源用途许可。
      </p>
      <template #actions
        ><button
          type="button"
          class="btn btn-secondary"
          :disabled="busy"
          @click="confirmOpen = false"
        >
          继续核对</button
        ><button
          type="button"
          class="btn btn-primary"
          :disabled="busy || !consistent"
          @click="confirm"
        >
          {{ busy ? '正在确认…' : '确认并保留本批范围' }}
        </button></template
      >
    </ConfirmDialog>
    <ConfirmDialog
      :open="removeOpen && Boolean(current)"
      title-id="adoption-remove-title"
      :busy="busy"
      :close-on-backdrop="!busy"
      :close-on-esc="!busy"
      @close="removeOpen = false"
    >
      <h2 id="adoption-remove-title">删除这份编选草稿？</h2>
      <p v-if="operationError" class="alert alert-error" role="alert">{{ operationError }}</p>
      <p>
        将删除交给 {{ current?.recipient }} 的本批草稿及其例外记录；项目条目和校对结果保持原样。
      </p>
      <template #actions
        ><button
          type="button"
          class="btn btn-secondary"
          :disabled="busy"
          @click="removeOpen = false"
        >
          保留草稿</button
        ><button type="button" class="btn btn-danger" :disabled="busy" @click="remove">
          {{ busy ? '正在删除…' : '删除本批草稿' }}
        </button></template
      >
    </ConfirmDialog>
  </main>
</template>

<script setup>
const nativeDeliveryEnabled = globalThis.__FANGJI_NATIVE_DELIVERY_ENABLED__ !== false
import AppStatusPanel from '@/components/AppStatusPanel.vue'
import ConfirmDialog from '@/components/ConfirmDialog.vue'
import ProjectWorkspaceNav from '@/components/admin/project/ProjectWorkspaceNav.vue'
import ImportBatchPicker from '@/components/admin/project/ImportBatchPicker.vue'
import BatchReportReturn from '@/components/admin/project/BatchReportReturn.vue'
import { batchReportNavigationQuery, readBatchReportContext } from '@/lib/batchReportContext'
import { getBatchReport } from '@/services/batchReportService'
import WorkspaceLeaveGuard from '@/components/admin/project/WorkspaceLeaveGuard.vue'
import AppButton from '@/components/AppButton.vue'
import AppDisclosure from '@/components/AppDisclosure.vue'
import AppPagination from '@/components/AppPagination.vue'
import { useProtectedPageScope } from '@/composables/useProtectedPageScope'
import AppField from '@/components/AppField.vue'
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  DECISION_LABELS,
  DEFAULT_STATUSES,
  PAGE_STATUS_LABELS,
  QUALITY_STATE_LABELS,
  batchStatusLabel,
  countsConsistent,
  eventKindLabel,
  includeLabel,
  manifestFilename,
  normalizeCounts,
  purposeLabel,
  qualityStateLabel,
  reasonLabel,
  ruleFromForm,
  ruleSummary,
  statusLabel
} from '@/lib/adoption'
import {
  confirmAdoptionBatch,
  createAdoptionBatch,
  deleteAdoptionBatch,
  exportAdoptionManifest,
  decideAdoptionException,
  getAdoptionSummary,
  getAdoptionBatch,
  getAdoptionExceptionByPage,
  listAdoptionBatches,
  listAdoptionEvents,
  listAdoptionExceptions,
  previewAdoptionBatch,
  reevaluateAdoptionBatch
} from '@/services/adoptionService'
import { downloadText } from '@/lib/downloadText'
import { getPbMessage, getPbStatus } from '@/utils/pbErrors'

const route = useRoute()
const router = useRouter()
const projectId = computed(() => String(route.params.id))
const reportContext = computed(() => readBatchReportContext(route.query, projectId.value))
const reportQuery = computed(() => batchReportNavigationQuery(reportContext.value))

function positivePage(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return 1
  if (!/^[1-9]\d*$/.test(String(value))) return 1
  const page = Number(value)
  return Number.isSafeInteger(page) ? page : 1
}
const queryPage = computed(() => positivePage(route.query.page))
const routeListPage = computed(() =>
  positivePage(
    route.query.listPage ??
      route.query.returnPage ??
      (!route.query.batch && route.query.view !== 'create' ? route.query.page : undefined)
  )
)
function exceptionFromQuery(query) {
  // Canonical links win when both keys exist; entry remains a read-only alias.
  return typeof query.exception === 'string'
    ? query.exception
    : typeof query.entry === 'string'
      ? query.entry
      : ''
}
const exceptionQuery = computed(() => exceptionFromQuery(route.query))
function navigate(query) {
  const canonical = { ...query }
  delete canonical.returnPage
  for (const key of [
    'reportProject',
    'reportBatch',
    'reportExport',
    'reportHistoryPage',
    'reportSection'
  ])
    delete canonical[key]
  const listPage = positivePage(
    canonical.listPage ??
      route.query.listPage ??
      route.query.returnPage ??
      (screen.value === 'list' ? historyPage.value : routeListPage.value)
  )
  if (listPage > 1) canonical.listPage = String(listPage)
  else delete canonical.listPage
  const selected = exceptionFromQuery(query)
  delete canonical.entry
  if (selected) canonical.exception = selected
  else delete canonical.exception
  return router.push({ query: { ...canonical, ...reportQuery.value } })
}
function changeTab(tab) {
  return navigate({ batch: currentId.value, tab, page: 1 })
}
function changePage(page) {
  return screen.value === 'list' ? navigate({ listPage: page }) : navigate({ ...route.query, page })
}
const screen = ref('list')
const createStep = ref(1)
const scopePreset = ref('ready')
const detailTab = ref('overview')
const activeExceptionId = ref('')
const confirmOpen = ref(false)
const removeOpen = ref(false)
function openConfirmation() {
  operationError.value = ''
  confirmOpen.value = true
}
function openRemoval() {
  operationError.value = ''
  removeOpen.value = true
}
const pageStatuses = Object.keys(PAGE_STATUS_LABELS)
const qualityStates = Object.keys(QUALITY_STATE_LABELS)

const loading = ref(false)
const loadError = ref('')
const loaded = ref(false)
const unavailable = ref(false)
const projectUnavailable = ref(false)
const busy = ref(false)
const operationError = ref('')
const createConflict = ref(null)
const message = ref('')

const batches = ref([])
const historyPage = ref(1)
const requestedHistoryPage = ref(1)
const historyTotalPages = ref(1)
const historyTotalItems = ref(0)
const purposes = ref([])
const reasonCodes = ref([])
const currentId = ref('')
const currentRecord = ref(null)
const exceptions = ref({ exceptions: [], pending: [], pendingTotal: 0 })
const batchEvents = ref({ events: [], stale: false })
const summary = ref(null)
const decisionDrafts = reactive({})

const createForm = reactive({
  purpose: 'public_display',
  recipient: '',
  note: '',
  statuses: [...DEFAULT_STATUSES],
  qualityStates: [],
  requirePinyin: false,
  importJobsText: ''
})

const visibleCreateConflict = computed(() =>
  screen.value === 'create' && createConflict.value?.purpose === createForm.purpose
    ? createConflict.value
    : null
)

const reportScopeRequested = computed(
  () => route.query.view === 'create' && route.query.importJob !== undefined
)
const requestedReportBatch = computed(() => {
  const batchId = reportContext.value?.batchId
  return reportScopeRequested.value && batchId && route.query.importJob === batchId ? batchId : ''
})
const reportScopePending = ref(false)
const reportScopeError = ref('')
const verifiedReportBatch = ref(null)
const customReportScope = ref(false)
const savedCreateTransition = ref(false)
let reportScopeRequest
let reportScopeKey = ''
const reportScopeReady = computed(
  () => !reportScopeRequested.value || verifiedReportBatch.value?.id === requestedReportBatch.value
)
const hasSelectedReportScope = computed(
  () =>
    !reportScopeRequested.value ||
    !customReportScope.value ||
    createForm.importJobsText.split(/[,，\s]+/).some(Boolean)
)

function openCustomReportScope() {
  if (!verifiedReportBatch.value) return
  createForm.importJobsText = verifiedReportBatch.value.id
  customReportScope.value = true
}

function syncReportScope() {
  const key = reportScopeRequested.value ? `${projectId.value}:${requestedReportBatch.value}` : ''
  if (key === reportScopeKey) return
  reportScopeKey = key
  createForm.importJobsText = ''
  customReportScope.value = false
  if (key) createStep.value = 1
  void verifyReportScope()
}

async function verifyReportScope() {
  reportScopeRequest?.cancel()
  verifiedReportBatch.value = null
  reportScopePending.value = false
  reportScopeError.value = ''
  if (!reportScopeRequested.value || accessLost.value) return
  const batchId = requestedReportBatch.value
  if (!batchId) {
    reportScopeError.value = '未能确认本链接指向的导入批次。请返回批次报告重新打开编选。'
    return
  }
  const request = pageScope.capture()
  reportScopeRequest = request
  const id = projectId.value
  reportScopePending.value = true
  try {
    const report = await getBatchReport(id, batchId, request.signal)
    if (!request.isCurrent() || requestedReportBatch.value !== batchId || projectId.value !== id)
      return
    if (
      report?.schema !== 'WanyuBatchReport/v1' ||
      report.project_id !== id ||
      report.batch?.id !== batchId
    )
      throw new Error('读取到的批次与本报告不一致。')
    if (!['completed', 'completed_with_errors'].includes(report.batch.status)) {
      reportScopeError.value = '本批次尚未完成导入。请完成导入后再核对。'
      return
    }
    const entries = report.metrics?.import?.retained?.value
    if (!Number.isSafeInteger(entries) || entries < 0) {
      reportScopeError.value = '暂时无法核对本批次的入册数量。'
      return
    }
    if (entries === 0) {
      reportScopeError.value = '本批次暂无已入册条目，无法从这里创建编选。'
      return
    }
    const filename = typeof report.batch.filename === 'string' ? report.batch.filename.trim() : ''
    verifiedReportBatch.value = {
      id: batchId,
      filename: filename || '未记录文件名的导入批次',
      entries
    }
  } catch (cause) {
    if (!request.isCurrent() || pageScope.invalidate(cause, request)) return
    reportScopeError.value =
      getPbStatus(cause) === 404
        ? '本批次已不可用，请返回批次台账重新选择。'
        : '暂时无法核对本批次。请重试或返回批次报告。'
  } finally {
    if (request.isCurrent()) reportScopePending.value = false
    request.finish()
  }
}

const visibleExceptions = computed(() => {
  const active =
    exceptions.value.pending.find((item) => item.page === activeExceptionId.value) ||
    exceptions.value.pending[0]
  return active ? [active] : []
})

function openCreate() {
  navigate({ view: 'create' })
  createStep.value = 1
}
function nextCreateStep() {
  if (reportScopeReady.value) createStep.value = 2
}
function applyScopePreset() {
  if (scopePreset.value === 'ready') createForm.statuses = [...DEFAULT_STATUSES]
}

const current = computed(() =>
  currentRecord.value?.id === currentId.value ? currentRecord.value : null
)
const dirty = computed(
  () =>
    (screen.value === 'create' &&
      !savedCreateTransition.value &&
      Boolean(
        createForm.recipient ||
        createForm.note ||
        createForm.importJobsText ||
        customReportScope.value
      )) ||
    Object.values(decisionDrafts).some(
      (draft) => draft.note || draft.reason || draft.decision !== 'select'
    )
)
const counts = computed(() => normalizeCounts(current.value?.counts))
const consistent = computed(() => countsConsistent(current.value?.counts))
const nextStepHint = computed(() => {
  if (!consistent.value) return '数量对账尚未通过，请重新预览并核对数量。'
  if (current.value?.status === 'confirmed') {
    if (batchEvents.value.stale)
      return '先核对来源用途变更，再准备交付；当前显示的仍是确认时的范围。'
    return nativeDeliveryEnabled
      ? '准备交付包，继续核查本批范围与接收方要求。'
      : '导出本批清单，交由交付环节检查。'
  }
  if (current.value?.status === 'previewed')
    return counts.value.pending > 0
      ? '先处理待定条目，再核对数量并确认范围。'
      : '核对下方数量，再确认本批采用范围。'
  return '预览当前条目数量，再处理待定项并确认范围。'
})
const EMPTY_EXCEPTIONS = { exceptions: [], pending: [], pendingTotal: 0 }
const EMPTY_EVENTS = { events: [], stale: false }
let projectGeneration = 0
let loadGeneration = 0
let readRequest
let activeOperationRequest
const pageScope = useProtectedPageScope((status) => {
  clearProtectedData()
  loadError.value =
    status === 401
      ? '登录状态已失效，当前页面内容已清除。请重新登录后重试。'
      : '当前账号已无权查看此项目，页面内容已清除。'
})
const { accessLost } = pageScope
function clearDetails() {
  currentRecord.value = null
  exceptions.value = { ...EMPTY_EXCEPTIONS }
  batchEvents.value = { ...EMPTY_EVENTS }
  activeExceptionId.value = ''
  confirmOpen.value = removeOpen.value = false
  for (const key of Object.keys(decisionDrafts)) delete decisionDrafts[key]
}
function clearProtectedData() {
  ++projectGeneration
  ++loadGeneration
  loaded.value = loading.value = busy.value = false
  batches.value = []
  purposes.value = reasonCodes.value = []
  summary.value = null
  operationError.value = message.value = ''
  createConflict.value = null
  historyPage.value = requestedHistoryPage.value = historyTotalPages.value = 1
  historyTotalItems.value = 0
  clearDetails()
  Object.assign(createForm, {
    purpose: 'public_display',
    recipient: '',
    note: '',
    statuses: [...DEFAULT_STATUSES],
    qualityStates: [],
    requirePinyin: false,
    importJobsText: ''
  })
  createStep.value = 1
  scopePreset.value = 'ready'
  reportScopeKey = ''
  reportScopePending.value = false
  reportScopeError.value = ''
  verifiedReportBatch.value = null
  customReportScope.value = false
}
// Preserve the endpoint's authority: a missing project revokes the entire
// workspace; a missing batch/exception revokes only the selected detail.
function projectRead(promise) {
  return promise.catch((cause) => {
    throw Object.assign(new Error('项目读取失败', { cause }), { requestSource: 'project' })
  })
}
function handleFailure(error, request, requestSource) {
  if (pageScope.invalidate(error, request)) return true
  if (!request.isCurrent()) return true
  if (getPbStatus(error) === 404 && requestSource === 'project') {
    pageScope.cancel()
    clearProtectedData()
    projectUnavailable.value = unavailable.value = true
    loadError.value = '项目不存在或已被删除，页面资料已清除。请返回项目列表或重试。'
    return true
  }
  if ((getPbStatus(error) === 404 || error?.invalidDetail) && currentId.value) {
    pageScope.cancel()
    ++projectGeneration
    ++loadGeneration
    loading.value = busy.value = false
    batches.value = batches.value.filter((item) => item.id !== currentId.value)
    clearDetails()
    unavailable.value = true
    loadError.value = '这份编选批次或所选例外已不可用，请返回批次列表或重试。'
    return true
  }
  return false
}

watch(projectId, resetProject, { immediate: true })
watch(
  () => route.query,
  async () => {
    for (const key of Object.keys(decisionDrafts)) delete decisionDrafts[key]
    unavailable.value = false
    createConflict.value = null
    const previousId = currentId.value
    const previousScreen = screen.value
    syncQuery()
    syncReportScope()
    if (previousId !== currentId.value || (!currentId.value && previousScreen !== screen.value)) {
      activeOperationRequest?.cancel()
      busy.value = false
    }
    await load(routeListPage.value)
  }
)
function syncQuery() {
  currentId.value = typeof route.query.batch === 'string' ? route.query.batch : ''
  screen.value = currentId.value ? 'detail' : route.query.view === 'create' ? 'create' : 'list'
  detailTab.value = ['overview', 'exceptions', 'history'].includes(route.query.tab)
    ? route.query.tab
    : 'overview'
  activeExceptionId.value = exceptionQuery.value
}
onBeforeUnmount(() => {
  ++projectGeneration
})

function resetProject() {
  pageScope.cancel()
  clearProtectedData()
  projectUnavailable.value = unavailable.value = false
  syncQuery()
  syncReportScope()
  return load(routeListPage.value)
}

async function load(page = requestedHistoryPage.value) {
  requestedHistoryPage.value = page
  readRequest?.cancel()
  const request = pageScope.capture()
  readRequest = request
  const generation = ++loadGeneration
  const isCurrent = () => request.isCurrent() && generation === loadGeneration
  const id = projectId.value
  const nextId = currentId.value
  loading.value = true
  loadError.value = ''
  try {
    const data = await projectRead(
      listAdoptionBatches(id, { page, perPage: 25, signal: request.signal })
    )
    const [details, nextSummary] = await Promise.all([
      loadBatchDetails(nextId, request.signal),
      projectRead(getAdoptionSummary(id, { signal: request.signal }))
    ])
    if (!isCurrent()) return
    // Only the exact detail endpoint is authoritative. Network errors retain
    // the last successful same-object content; 401/403 and 404 revoke it.
    batches.value = data.batches || []
    currentId.value = nextId
    historyPage.value = requestedHistoryPage.value = data.page
    historyTotalPages.value = data.totalPages
    historyTotalItems.value = data.totalItems
    purposes.value = data.purposes || []
    reasonCodes.value = data.reasons || []
    summary.value = nextSummary
    applyBatchDetails(details)
    loaded.value = true
    accessLost.value = unavailable.value = projectUnavailable.value = false
  } catch (failure) {
    const error = failure?.requestSource ? failure.cause : failure
    if (handleFailure(error, request, failure?.requestSource) || !isCurrent()) return
    loadError.value = getPbMessage(error, '加载编选批次失败')
  } finally {
    if (isCurrent()) loading.value = false
    request.finish()
  }
}

async function loadBatchDetails(batchId, signal) {
  if (!batchId)
    return { record: null, exceptions: { ...EMPTY_EXCEPTIONS }, events: { ...EMPTY_EVENTS } }
  const [record, exceptionsData, eventsData, exact] = await Promise.all([
    getAdoptionBatch(batchId, { signal }),
    listAdoptionExceptions(batchId, {
      signal,
      page: detailTab.value === 'exceptions' ? queryPage.value : 1,
      decidedPage: Number(route.query.decidedPage) || 1
    }),
    listAdoptionEvents(batchId, {
      signal,
      page: detailTab.value === 'history' ? queryPage.value : 1
    }),
    exceptionQuery.value
      ? getAdoptionExceptionByPage(batchId, exceptionQuery.value, { signal })
      : null
  ])
  if (record.project !== projectId.value)
    throw Object.assign(new Error('编选批次不属于当前项目'), { invalidDetail: true })
  if (
    exact?.entry?.pending &&
    !exceptionsData.pending.some((item) => item.page === exact.entry.page)
  )
    exceptionsData.pending.push(exact.entry)
  if (
    exact?.exception &&
    !exceptionsData.exceptions.some((item) => item.page === exact.exception.page)
  ) {
    exceptionsData.exceptions.push(exact.exception)
  }
  return { record, exceptions: exceptionsData, events: eventsData }
}

function applyBatchDetails(details) {
  if (Object.hasOwn(details, 'record')) currentRecord.value = details.record
  exceptions.value = details.exceptions || { ...EMPTY_EXCEPTIONS }
  batchEvents.value = details.events || { ...EMPTY_EVENTS }
  for (const item of exceptions.value.pending) draftFor(item.page)
  if (!exceptions.value.pending.some((item) => item.page === activeExceptionId.value))
    activeExceptionId.value = exceptions.value.pending[0]?.page || ''
}

function draftFor(pageId) {
  const key = `${currentId.value}:${pageId}`
  if (!decisionDrafts[key]) {
    decisionDrafts[key] = { decision: 'select', reason: '', note: '' }
  }
  return decisionDrafts[key]
}

async function act(fn, success, onError) {
  if (accessLost.value) return
  activeOperationRequest?.cancel()
  const request = pageScope.capture()
  activeOperationRequest = request
  const id = projectId.value
  const generation = projectGeneration
  const isCurrent = () => request.isCurrent() && generation === projectGeneration
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    await fn(id, isCurrent, request.signal)
    if (!isCurrent()) return
    if (success) message.value = success
    await load()
  } catch (e) {
    if (handleFailure(e, request) || !isCurrent() || onError?.(e)) return
    operationError.value = getPbMessage(e, '操作失败，请重试')
  } finally {
    if (isCurrent()) busy.value = false
    request.finish()
  }
}

function handleCreateConflict(error, purpose) {
  const batch = error?.response?.batch
  if (
    getPbStatus(error) !== 409 ||
    batch?.project !== projectId.value ||
    batch.purpose !== purpose ||
    !['draft', 'previewed'].includes(batch.status) ||
    typeof batch.id !== 'string' ||
    !/^[a-z0-9]{15}$/.test(batch.id)
  )
    return false
  createConflict.value = { id: batch.id, purpose }
  return true
}

async function create() {
  if (busy.value || !reportScopeReady.value) return
  createConflict.value = null
  const submittedPurpose = createForm.purpose
  const submittedNote = createForm.note
  const built = ruleFromForm({
    ...createForm,
    importJobsText:
      reportScopeRequested.value && !customReportScope.value
        ? verifiedReportBatch.value.id
        : createForm.importJobsText
  })
  if (built.error) {
    operationError.value = built.error
    return
  }
  if (reportScopeRequested.value && !built.rule.importJobs.length) {
    operationError.value = '请至少选择一个导入批次。'
    return
  }
  await act(
    async (id, isCurrent, signal) => {
      const batch = await createAdoptionBatch(
        id,
        {
          purpose: submittedPurpose,
          recipient: createForm.recipient.trim(),
          note: createForm.note.trim(),
          rule: built.rule
        },
        { signal }
      )
      if (!isCurrent()) return
      // Retain a successfully created draft before previewing: a failed preview
      // must retry this batch instead of silently creating another one.
      batches.value = [batch, ...batches.value.filter((item) => item.id !== batch.id)]
      currentId.value = batch.id
      currentRecord.value = batch
      if (createForm.note === submittedNote) createForm.note = ''
      savedCreateTransition.value = true
      try {
        await nextTick()
        if (!isCurrent()) return
        await navigate({ batch: batch.id, tab: 'overview', page: 1 })
      } finally {
        savedCreateTransition.value = false
      }
      if (!isCurrent()) return
      screen.value = 'detail'
      detailTab.value = 'overview'
      applyBatchDetails({ exceptions: { ...EMPTY_EXCEPTIONS }, events: { ...EMPTY_EVENTS } })
      await previewAdoptionBatch(batch.id, { signal })
      if (!isCurrent()) return
      // 接收方保留：同一批交付常常要按不同用途连续开几条；说明是一次性的。
      if (createForm.note === submittedNote) createForm.note = ''
      screen.value = 'detail'
      detailTab.value = 'overview'
    },
    '批次已创建并完成预览；核对数量后再确认。',
    (error) => handleCreateConflict(error, submittedPurpose)
  )
}

async function preview() {
  await act(
    (_id, _current, signal) => previewAdoptionBatch(current.value.id, { signal }),
    '已按当前数据重新计算。'
  )
}

async function confirm() {
  if (!current.value || !consistent.value || current.value.status !== 'previewed') return
  await act(
    (_id, _current, signal) => confirmAdoptionBatch(current.value.id, { signal }),
    '已确认本批采用范围；导出与下游都以这份清单为准。'
  )
  if (!operationError.value) confirmOpen.value = false
}

// 重评只追加一条事件，不改写确认时的数字：D5.3 的红线是「追加，不改历史」。
// 界面上必须把这件事说出来，否则「重新评估」会被读成「把这一批改了」。
async function reevaluate() {
  await act(async (_id, isCurrent, signal) => {
    const result = await reevaluateAdoptionBatch(current.value.id, { signal })
    if (!isCurrent()) return
    message.value = result.drift
      ? `已追加重评记录：${result.stored.selected}/${result.stored.total} → ${result.current.selected}/${result.current.total}，差异在「${result.drift}」。已确认的数字没有改。`
      : `已追加重评记录：与确认时一致（${result.current.selected}/${result.current.total}）。`
  }, '')
}

async function remove() {
  const batchId = current.value.id
  await act(async (_id, isCurrent, signal) => {
    await deleteAdoptionBatch(batchId, { signal })
    if (isCurrent()) {
      currentId.value = ''
      await navigate({ listPage: historyPage.value })
    }
  }, '草稿已删除。')
  if (!operationError.value) removeOpen.value = false
}

async function exportManifest(include) {
  if (accessLost.value || !current.value) return
  activeOperationRequest?.cancel()
  const request = pageScope.capture()
  activeOperationRequest = request
  const generation = projectGeneration
  const batch = current.value
  busy.value = true
  operationError.value = ''
  message.value = ''
  try {
    const manifest = await exportAdoptionManifest(batch.id, include, { signal: request.signal })
    if (!request.isCurrent() || generation !== projectGeneration) return
    downloadText(JSON.stringify(manifest, null, 2), manifestFilename(batch), 'application/json')
    message.value =
      include === 'select'
        ? includeLabel('select')
        : `${includeLabel('all')}；未采用与待处理的数量写在清单里。`
  } catch (e) {
    if (handleFailure(e, request) || !request.isCurrent() || generation !== projectGeneration)
      return
    operationError.value = getPbMessage(e, '导出失败')
  } finally {
    if (request.isCurrent() && generation === projectGeneration) busy.value = false
    request.finish()
  }
}

async function decide(pageId) {
  const batchId = currentId.value
  const draftKey = `${batchId}:${pageId}`
  const draft = draftFor(pageId)
  const note = draft.note.trim()
  if (!note) {
    operationError.value = '处理例外必须写明依据。'
    return
  }
  if (draft.decision === 'exclude' && !draft.reason) {
    operationError.value = '判为不进入本批时必须选一个理由。'
    return
  }
  await act(async (_id, isCurrent, signal) => {
    await decideAdoptionException(
      batchId,
      {
        page: pageId,
        decision: draft.decision,
        reason: draft.decision === 'exclude' ? draft.reason : '',
        note
      },
      { signal }
    )
    if (isCurrent()) delete decisionDrafts[draftKey]
  }, '例外已记录；批次退回草稿，请重新预览再确认。')
}

function selectBatch(id) {
  return navigate({ batch: id, tab: 'overview', page: 1 })
}
</script>

<style scoped>
.adoption-report-scope {
  padding: var(--space-3);
  margin-block: var(--space-3);
  border: 1px solid var(--primary-line);
  border-radius: var(--radius-panel);
  background: var(--primary-glow-soft);
  overflow-wrap: anywhere;
}
.adoption-report-scope p {
  margin: 0;
}
.adoption-report-scope .btn {
  margin-top: var(--space-2);
}
.adoption-form-body {
  min-width: 0;
  padding: 0;
  margin: 0;
  border: 0;
}
.adoption-create-summary,
.adoption-next-step {
  padding: var(--space-3) 0;
  margin-bottom: var(--space-3);
  border-bottom: 1px solid var(--line);
  line-height: 1.7;
}
.adoption-next-step strong {
  display: block;
  margin-bottom: var(--space-1);
  font-size: var(--text-sm);
  color: var(--gray-600);
}
.adoption-exceptions-done {
  display: grid;
  justify-items: start;
  gap: var(--space-2);
}
.adoption-workspace {
  min-width: 0;
  overflow-wrap: anywhere;
}
.adoption-more {
  padding: var(--space-2) 0;
}
.adoption-more summary,
.adoption-optional summary {
  cursor: pointer;
  color: var(--gray-600);
  font-size: var(--text-sm);
}
.adoption-more[open] {
  flex-basis: 100%;
}
.adoption-optional {
  padding: var(--space-2) 0;
}
.adoption-heading {
  margin-bottom: var(--space-3);
}
.adoption-heading h1 {
  font-size: var(--text-2xl);
}
.adoption-explanation {
  color: var(--gray-600);
  font-size: var(--text-sm);
}
.adoption-explanation p {
  padding-top: var(--space-2);
}
.adoption-steps,
.adoption-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-bottom: var(--space-4);
}
.adoption-steps span {
  padding: var(--space-2) var(--space-3);
  color: var(--gray-600);
  border-bottom: 2px solid var(--line);
}
.adoption-steps [aria-current='step'] {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 600;
}
.adoption-tabs button {
  padding: var(--space-2) var(--space-3);
  min-height: 44px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--gray-600);
  cursor: pointer;
  font: inherit;
}
.adoption-tabs .is-active {
  color: var(--primary);
  border-bottom-color: var(--primary);
  font-weight: 600;
}
.adoption-history li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) 0;
  border-bottom: 1px solid var(--line);
}
.adoption-history button {
  text-align: left;
  white-space: normal;
}
.adoption-history-trigger {
  display: grid;
  gap: var(--space-1);
  min-height: 44px;
  padding-inline: 0;
}
.adoption-history-trigger strong {
  font-size: var(--text-md);
}
@media (max-width: 640px) {
  .adoption-history li {
    align-items: start;
    flex-direction: column;
  }
}
.back-link {
  display: inline-block;
  margin-bottom: var(--space-3);
}
.adoption-form-grid {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr));
}
.adoption-fieldset {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  margin: var(--space-3) 0;
}
.adoption-check {
  display: inline-block;
  margin-right: var(--space-3);
}
.adoption-batch-head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--space-2);
}
.adoption-batch-head h2 {
  min-width: 0;
  font-size: var(--text-xl);
}
.adoption-batch-head .badge {
  flex-shrink: 0;
  white-space: nowrap;
}
.adoption-counts {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  margin: var(--space-3) 0;
}
.adoption-count {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}
.adoption-count-value {
  display: block;
  font-size: 1.6rem;
  font-weight: 600;
}
.adoption-reasons {
  margin: var(--space-2) 0 0;
  padding-left: 1.2rem;
}
.adoption-subhead {
  font-size: 1rem;
  margin: var(--space-3) 0 var(--space-1);
}
.adoption-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
.adoption-hint {
  color: var(--gray-600);
  font-size: 0.85rem;
}
.adoption-pending {
  border-top: 1px solid var(--line);
  margin-top: var(--space-3);
  padding-top: var(--space-2);
}
.adoption-metrics {
  display: grid;
  gap: var(--space-3);
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  margin: var(--space-3) 0;
}
.adoption-metric {
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
}
.adoption-metric dt {
  font-size: 0.85rem;
  color: var(--gray-600);
}
.adoption-metric dd {
  font-size: 1.4rem;
  font-weight: 600;
  margin: 0;
}
.adoption-metric small {
  color: var(--gray-600);
}
.adoption-history {
  list-style: none;
  padding: 0;
}
.adoption-history-current {
  font-weight: 600;
}
</style>
