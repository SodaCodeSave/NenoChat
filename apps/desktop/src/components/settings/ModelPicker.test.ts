import { describe, expect, it } from 'vitest'
import source from './ModelPicker.vue?raw'

describe('ModelPicker', () => {
  it('列表为空时退回手填，且当前自定义值始终可见', () => {
    expect(source).toContain(":disabled=\"disabled || models.length === 0\"")
    expect(source).toContain("if (props.modelValue && !list.includes(props.modelValue)) list.unshift(props.modelValue)")
  })

  it('支持在选择与手填之间切换', () => {
    expect(source).toContain("const customMode = ref(false)")
    expect(source).toContain("customMode.value = !customMode.value")
    expect(source).toContain("v-if=\"!customMode\"")
    expect(source).toContain('icon="customMode ? \'chevronDown\' : \'edit\'"')
  })
})
