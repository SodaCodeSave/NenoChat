import { describe, expect, it } from 'vitest'
import source from './ConnectorSettings.vue?raw'

describe('ConnectorSettings', () => {
  it('和风天气经纬度允许小数输入', () => {
    // NumberInput 默认 integer: true 会把输入取整，经纬度必须显式放开小数
    expect(source).toContain(
      '<NumberInput id="connector-latitude" v-model="form.latitude" :integer="false" :min="-90" :max="90" />',
    )
    expect(source).toContain(
      '<NumberInput id="connector-longitude" v-model="form.longitude" :integer="false" :min="-180" :max="180" />',
    )
  })
})
