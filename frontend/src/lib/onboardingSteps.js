export const ONBOARDING_MOBILE_MAX = 768

// Guidance stays separate from the research-purpose decision required at submit.
const RESEARCH_NOTICE =
  '你之后提交的校对结论可能被用于语言研究。这只说明数据用途。如果不同意用于研究，可以选择退出。退出后仍然可以正常领取和提交，不影响其他任何权益。请在第一次提交之前做出选择。'

export function onboardingSteps(isMobile = false) {
  return [
    {
      id: 'source',
      title: '先看来源，再核对内容',
      target: '来源 PDF 与核验约定',
      body: '从工作台继续任务，或在项目中领取任务；发现项目现在位于「项目」的「可加入」。对照 PDF 逐字段核对。来源缺失或看不清时，保存未完成工作并提交问题，不把无法判断当作已经核对。'
    },
    {
      id: 'fields',
      title: isMobile ? '一次只改一个字段' : '专注当前字段',
      target: '字段、字符键盘、草稿',
      body:
        (isMobile
          ? '用底部导航一次只改一个字段，整条总览用于检查。'
          : '在来源 PDF 旁填写字段结果。') +
        '对照待校对原文（导入值）；笔误改文字字段，口误改读音字段。修改后可恢复原文对应的导入值。字符键盘在光标处插入，选中文字时替换选区。草稿保存在当前设备；释放任务后草稿仍保留。'
    },
    {
      id: 'submit',
      title: '检查后提交，存疑时报告',
      target: '检查并提交、问题与草稿、研究用途',
      body:
        '检查并提交前确认修改与逐字段核对声明；提交后不能自行撤回，系统会尝试继续下一条。' +
        (isMobile ? '' : '可用 Ctrl+Enter 打开提交检查。') +
        '研究用途：' +
        RESEARCH_NOTICE
    }
  ]
}
