import { createApp, h, ref } from 'vue'
import { createRouter, createMemoryHistory } from 'vue-router'
import AppButton from '../../src/components/AppButton.vue'
import AppDropdown from '../../src/components/AppDropdown.vue'
import AppSelect from '../../src/components/AppSelect.vue'
import AppModal from '../../src/components/AppModal.vue'
import AppDisclosure from '../../src/components/AppDisclosure.vue'
import '../../src/style.css'

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: '/', component: {} }]
})
await router.push('/')
createApp({
  setup() {
    const value = ref('')
    const dialog = ref(false)
    const busy = ref(false)
    const labelledBusy = ref(false)
    const labelledButton = ref(null)
    const events = ref(0)
    const locked = ref(false)
    const reverse = ref(false)
    const detailsOpen = ref(false)
    const detailsValue = ref('  𠮷 ia̤̍h  ')
    const options = [
      { label: '全部状态', value: '' },
      { label: '待校对', value: 'pending' },
      { label: '数值零', value: 0 },
      { label: '不可选择', value: 'disabled', disabled: true }
    ]
    return () =>
      h('main', { class: 'container page' }, [
        h('h1', '公共控件回归夹具'),
        h('label', { for: 'fixture-select' }, '状态'),
        h(AppSelect, {
          id: 'fixture-select',
          'aria-label': '状态',
          modelValue: value.value,
          disabled: locked.value,
          options: reverse.value ? [...options].reverse() : options,
          'onUpdate:modelValue': (selected) => {
            value.value = selected
          }
        }),
        h('output', { 'aria-label': '实际筛选值' }, JSON.stringify(value.value)),
        h(
          AppButton,
          {
            onClick: () => {
              reverse.value = !reverse.value
            }
          },
          () => '刷新选项顺序'
        ),
        h(
          AppButton,
          {
            onClick: () => {
              setTimeout(() => {
                locked.value = true
              }, 750)
            }
          },
          () => '模拟异步锁定'
        ),
        h(AppDropdown, {
          label: '更多',
          'aria-label': '第 3 条的更多操作',
          items: [
            { label: '修正导入文本', action: 'edit' },
            { label: '不可执行', action: 'disabled', disabled: true }
          ],
          onSelect: () => {
            dialog.value = true
          }
        }),
        h(
          AppButton,
          {
            loading: busy.value,
            onClick: () => {
              busy.value = true
              events.value++
            }
          },
          () => '保存'
        ),
        h('output', { 'aria-label': '保存请求次数' }, String(events.value)),
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              busy.value = false
            }
          },
          '结束保存'
        ),
        h('section', { 'aria-label': '忙碌尺寸验证' }, [
          h(
            AppButton,
            {
              ref: labelledButton,
              loading: labelledBusy.value,
              loadingLabel: '正在提交到服务端…',
              'data-operation': 'geometry',
              onClick: () => {
                labelledBusy.value = true
              }
            },
            () => '提交'
          ),
          h(AppButton, { variant: 'ghost' }, () => '后续操作'),
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                labelledBusy.value = false
              }
            },
            '结束提交'
          ),
          h(
            'button',
            {
              type: 'button',
              onClick: () => {
                labelledButton.value?.focus()
              }
            },
            '聚焦提交按钮'
          )
        ]),
        h(
          AppDisclosure,
          {
            label: '核对说明',
            modelValue: detailsOpen.value,
            'onUpdate:modelValue': (open) => {
              detailsOpen.value = open
            }
          },
          () =>
            h('label', [
              '说明草稿',
              h('input', {
                'aria-label': '说明草稿',
                value: detailsValue.value,
                onInput: (event) => {
                  detailsValue.value = event.target.value
                }
              })
            ])
        ),
        h(
          AppButton,
          {
            onClick: () => {
              detailsOpen.value = false
            }
          },
          () => '外部收起说明'
        ),
        h(
          AppModal,
          {
            open: dialog.value,
            titleId: 'fixture-dialog-title',
            onClose: () => {
              dialog.value = false
            }
          },
          {
            default: () => [
              h('h2', { id: 'fixture-dialog-title' }, '修正导入文本'),
              h('label', ['修正内容', h('textarea', { 'aria-label': '修正内容' })])
            ],
            actions: () =>
              h(
                AppButton,
                {
                  onClick: () => {
                    dialog.value = false
                  }
                },
                () => '取消'
              )
          }
        )
      ])
  }
})
  .use(router)
  .mount('#app')
