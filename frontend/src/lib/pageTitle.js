const PAGE_TITLES = {
  WorkspaceHome: '工作台',
  Login: '登录',
  AccountSecurity: '账户安全',
  AccountAction: '账户验证与恢复',
  Register: '注册',
  ChangeInitialPassword: '修改密码',
  AdminDashboard: '项目管理',
  AdminTodos: '统一待办',
  NewProject: '新建项目',
  ProjectFilesGuide: '文件准备说明',
  ProjectDetail: '项目详情',
  ProjectBatchReport: '质量与交付报告',
  ProjectSettings: '项目设置',
  ProjectDeliveries: '交付包与回执',
  ProjectAdoption: '用途编选',
  SourceFidelity: '来源核验与问题处理',
  CreatorGrants: '创建权限',
  SourceRegistry: '来源库',
  GateRules: '规则门控',
  Arbitration: '条目仲裁',
  TaskHall: '我的任务',
  OwnSubmissions: '本人提交记录',
  MyProblems: '我的问题与草稿',
  ProofreaderProfile: '个人中心',
  ProofreadEditor: '校对任务',
  ProjectDiscovery: '项目'
}

const BRAND = '万语校坊'

export function pageTitleFor(name) {
  return PAGE_TITLES[name] || BRAND
}

export function documentTitleFor(name) {
  const title = pageTitleFor(name)
  return title === BRAND ? BRAND : `${title} — ${BRAND}`
}
