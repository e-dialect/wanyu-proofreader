import pb from '@/lib/pocketbase'

const projectPath = id => `/api/fangji/projects/${encodeURIComponent(id)}`
const pagePath = id => `/api/fangji/pages/${encodeURIComponent(id)}`
const send = (path, method = 'GET', body) => pb.send(path, { method, ...(body ? { body } : {}), requestKey: null })

export const getVerification = id => send(`${pagePath(id)}/verification`)
export const getVerificationPolicy = id => send(`${projectPath(id)}/verification-policy`)
export const saveVerificationPolicy = (id, body) => send(`${projectPath(id)}/verification-policy`, 'POST', body)
export const saveVerificationDraft = (id, body) => send(`${pagePath(id)}/draft`, 'PUT', body)
export const reportProblem = (id, body) => send(`${pagePath(id)}/problems`, 'POST', body)
export const getMyProblems = () => send('/api/fangji/my-problems')
export const resumeProblemTask = id => send(`${pagePath(id)}/resume`, 'POST', {})
export const getProjectProblems = id => send(`${projectPath(id)}/problems`)
export const updateProblem = (project, issue, body) => send(`${projectPath(project)}/problems/${encodeURIComponent(issue)}`, 'PUT', body)
export const groupProblems = (id, body) => send(`${projectPath(id)}/problems/group`, 'POST', body)
export const saveSourceJudgments = (id, body) => send(`${pagePath(id)}/source-judgments`, 'POST', body)
export const confirmEmptySource = (id, body) => send(`${pagePath(id)}/empty-source`, 'POST', body)
export const getVerificationSummary = id => send(`${projectPath(id)}/verification-summary`)
export const exportVerification = (id, mode = 'all') => send(`${projectPath(id)}/verification-export`, 'POST', { mode })

export const PROBLEM_STATES = { new: '待受理', in_progress: '处理中', technical: '等待技术处理', resolved: '已处理', reopened: '重新打开' }
export const PROBLEM_TYPES = { input_display: '输入／显示有问题', hint: '提示可能不合适', source_location: '来源页或定位有问题', unreadable: '原文暂时看不清', other: '其他' }
