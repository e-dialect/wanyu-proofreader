/// <reference path="../pb_data/types.d.ts" />

// Evidence of recorded actions, not a training certificate or a checklist.
routerAdd("GET", "/api/fangji/projects/{projectId}/practice-progress", c => {
  const access = require(`${__hooks}/lib/project_access.js`)
  const projectId = access.assertId(c.request.pathValue("projectId"), "项目")
  let response
  $app.runInTransaction(dao => {
    const auth = access.currentAuth(dao, c.auth)
    const project = access.project(dao, projectId)
    const permissions = access.capabilities(dao, project, auth)
    if (!permissions.canManage && !permissions.canProofread) throw new ForbiddenError("请先加入该练习项目")
    if (project.getString("purpose") !== "practice") throw new BadRequestError("这不是练习项目，请选择或创建独立练习项目")
    const now = new Date().toISOString()
    const params = { project: projectId, user: auth.id, now }
    const fact = (sql, note, managerOnly = false) => {
      if (managerOnly && !permissions.canManage) return { count: null, note: "仅项目管理员可查看" }
      try {
        const row = new DynamicModel({ count: 0 })
        dao.db().newQuery(sql).bind(params).one(row)
        return { count: Number(row.count), note }
      } catch {
        return { count: null, note: "暂未能读取，请刷新后重试" }
      }
    }
    response = {
      project_id: projectId, purpose: "practice", generated_at: now,
      required_proofreads: Math.max(2, project.getInt("required_proofreads") || 2),
      facts: {
        entries: fact("SELECT COUNT(*) AS count FROM pages WHERE project={:project} AND status!='importing'", "已入册条目，不代表校对完成"),
        own_submitted: fact(`SELECT COUNT(DISTINCT p.id) AS count FROM proofreading_attempts a JOIN pages p ON p.id=a.page AND p.project=a.project
          WHERE a.project={:project} AND a.proofreader={:user} AND a.kind='proofread'
          AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND p.status!='importing'`, "本人在当前轮已提交的条目；不包含历史轮次，也不代表已完成双人校对"),
        own_active_claims: fact(`SELECT COUNT(DISTINCT p.id) AS count FROM task_leases l JOIN pages p ON p.id=l.page AND p.project=l.project
          WHERE l.project={:project} AND l.holder={:user} AND p.proofreader={:user}
          AND p.status IN ('claimed','proofreading') AND julianday(l.expires_at)>julianday({:now})`, "本人正在处理且领取尚未过期的条目；领取不等于提交"),
        pdf_ready: fact("SELECT COUNT(*) AS count FROM project_files WHERE project={:project} AND status='ready'", "已准备好的来源 PDF 文件", true),
        proofreader_members: fact("SELECT COUNT(*) AS count FROM project_memberships m JOIN projects p ON p.id=m.project WHERE m.project={:project} AND m.role='proofreader' AND m.user!=p.admin", "已加入的校对成员；成员人数不证明已独立提交", true),
        imported_batches: fact("SELECT COUNT(*) AS count FROM import_jobs WHERE project={:project} AND status IN ('completed','completed_with_errors')", "已结束的导入批次；包含部分条目导入失败的批次，请在台账核对", true),
        independent_submitted: fact(`SELECT COUNT(*) AS count FROM pages p JOIN projects pr ON pr.id=p.project
          WHERE p.project={:project} AND p.status!='importing' AND p.source_empty IS NOT 1
          AND (SELECT COUNT(DISTINCT a.proofreader) FROM proofreading_attempts a
            WHERE a.page=p.id AND a.project=p.project AND a.kind='proofread' AND a.proofreader!=''
            AND a.round=COALESCE(NULLIF(p.proofread_round,0),1)) >= MAX(2,COALESCE(pr.required_proofreads,2))`, "当前轮达到规定人数的独立提交条目；可能仍待仲裁，不代表来源正确或可以交付", true),
        arbitration_recorded: fact(`SELECT COUNT(DISTINCT p.id) AS count FROM proofreading_attempts a JOIN pages p ON p.id=a.page AND p.project=a.project
          WHERE a.project={:project} AND a.kind='arbitration' AND a.round=COALESCE(NULLIF(p.proofread_round,0),1) AND p.status!='importing'`, "当前轮已有仲裁提交的条目；没有分歧的条目不需要仲裁", true),
        confirmed_adoptions: fact("SELECT COUNT(*) AS count FROM adoption_batches WHERE project={:project} AND status='confirmed'", "已有用途编选确认记录；不代表当前仍满足交付条件", true),
        delivery_packages: fact("SELECT COUNT(*) AS count FROM release_deliveries WHERE project={:project}", "已生成的交付包记录；不代表对方已接收或验收", true)
      }
    }
  })
  return c.json(200, response)
}, $apis.requireAuth("users"))
