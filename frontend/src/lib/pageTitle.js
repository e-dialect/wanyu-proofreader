const PAGE_TITLES = {
  WorkspaceHome: '工作台',
  Login: '登录',
  Register: '注册',
  ChangeInitialPassword: '修改密码',
  AdminDashboard: '项目管理',
  NewProject: '新建项目',
  ProjectFilesGuide: '文件准备说明',
  ProjectDetail: '项目详情',
  ProjectSettings: '项目设置',
  SourceFidelity: '来源核验与问题处理',
  CreatorGrants: '创建权限',
  SourceRegistry: '来源登记',
  GateRules: '规则门控',
  Arbitration: '条目仲裁',
  TaskHall: '校对项目',
  MyProblems: '我的问题与草稿',
  ProofreaderProfile: '个人中心',
  ProofreadEditor: '校对任务',
  ProjectDiscovery: '发现项目'
}

const BRAND = '万语校坊'

export function pageTitleFor(name) {
  return PAGE_TITLES[name] || BRAND
}

export function documentTitleFor(name) {
  const title = pageTitleFor(name)
  return title === BRAND ? BRAND : `${title} — ${BRAND}`
}
