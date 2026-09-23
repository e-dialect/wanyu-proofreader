export const ONBOARDING_MOBILE_MAX = 768

const SHARED_BEFORE_EDITOR = [
  {
    id: 'workspace',
    title: '从工作台进入校对',
    target: '工作台「材料校对」、发现项目',
    body: '登录后先到工作台。若已有可校对的项目，打开「材料校对」；也可以从「发现项目」加入后再回来。'
  },
  {
    id: 'claim',
    title: '在项目大厅认领一条',
    target: '项目大厅「领取任务」',
    body: '大厅会列出你当前可处理的项目。点「领取任务」开始独立校对；每次只判断眼前这一条材料。'
  }
]

const SHARED_AFTER_FIELDS = [
  {
    id: 'keyboard',
    title: '在光标处插入字符',
    target: '字符键盘',
    body: '需要特殊字符时，先把光标放到要插入的位置，再点键盘。若已选中文字，键盘会替换这段选区。'
  },
  {
    id: 'draft-lease',
    title: '草稿保存在这台设备，任务会暂时为你保留',
    target: '「修改后自动保存到本机」、任务保留时间',
    body: '修改会自动存到本机浏览器，刷新后还能恢复。领取后的任务会暂时为你保留；离开太久或点「释放任务」后，其他人也可以领取。草稿仍留在这台设备上。'
  }
]

export function onboardingSteps(isMobile = false) {
  if (isMobile) {
    return [
      ...SHARED_BEFORE_EDITOR,
      {
        id: 'pdf',
        title: '先对照 PDF 再改字段',
        target: '编辑器中的 PDF 预览',
        body: '打开条目后先看 PDF 对应位置。没有 PDF 时，仍可根据已导入的字段完成校对。'
      },
      {
        id: 'fields',
        title: '一次只改一个字段',
        target: '字段卡、「待校对原文」、「恢复原文」、底部字段导航',
        body: '窄屏下一次显示一个字段。用底部导航切换，或打开总览检查全部。每张卡片上方是待校对原文，改错了可用「恢复原文」。'
      },
      ...SHARED_AFTER_FIELDS,
      {
        id: 'submit',
        title: '提交前会确认，提交后不能自行撤回',
        target: '「检查并提交」',
        body: '点「检查并提交」。若还在逐字段编辑，会先回到总览让你再看一遍，然后再弹出确认。提交后不能在当前界面撤回。'
      }
    ]
  }

  return [
    ...SHARED_BEFORE_EDITOR,
    {
      id: 'pdf',
      title: '对照 PDF 定位当前条',
      target: '编辑器左侧 PDF 预览',
      body: '打开条目后，先看 PDF 里对应的位置，再改右侧字段。没有 PDF 时，仍可根据已导入的字段完成校对。'
    },
    {
      id: 'fields',
      title: '对照「待校对原文」填写结果',
      target: '字段卡、「待校对原文」、「恢复原文」',
      body: '每张字段卡上方是待校对原文，下方填写你的结果。改错了可以用「恢复原文」回到导入内容。'
    },
    ...SHARED_AFTER_FIELDS,
    {
      id: 'submit',
      title: '提交前会确认，提交后不能自行撤回',
      target: '「检查并提交」',
      body: '点「检查并提交」会先弹出确认。提交后不能在当前界面撤回。可用 ⌘/Ctrl+S 保存草稿，⌘/Ctrl+Enter 打开或确认提交。'
    }
  ]
}
