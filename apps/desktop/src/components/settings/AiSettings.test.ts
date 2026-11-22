import { describe, expect, it } from 'vitest'
import source from './AiSettings.vue?raw'

describe('AiSettings', () => {
  it('在 AI 服务商卡片顶部展示后台可配置的推广横幅，默认不渲染', () => {
    expect(source).toContain(
      "import ProviderAdBanner from '@/components/settings/ProviderAdBanner.vue'",
    )
    expect(source).toContain('<ProviderAdBanner v-if="serverAi?.ad" :ad="serverAi.ad" />')

    const providersAt = source.indexOf('id="providers"')
    const bannerAt = source.indexOf('<ProviderAdBanner')
    const replyAt = source.indexOf('id="reply"')
    expect(bannerAt).toBeGreaterThan(providersAt)
    expect(bannerAt).toBeLessThan(replyAt)
    // 横幅数据来自 /ai/balance 的 ad 字段，后台没开启（null）时不渲染
    expect(source).toContain('ad: ProviderAdData | null')
  })

  it('服务商列表提供编辑入口，编辑态复用保存表单', () => {
    expect(source).toContain('const editingProviderId = ref<string | null>(null)')
    expect(source).toContain('icon="edit"')
    expect(source).toContain('@click="startEditProvider(provider)"')
    expect(source).toContain('@click="cancelProviderForm"')
    expect(source).toContain("'保存修改' : '保存服务商'")
  })

  it('保存服务商后自动拉取模型列表', () => {
    expect(source).toContain('await fetchModelsFor(providerId)')
    expect(source).toContain('ai.loadModels(providerId)')
    expect(source).toContain('已获取 ${models.length} 个模型')
  })

  it('主模型与识图模型都用可自定义的模型选择器', () => {
    expect(source.match(/<ModelPicker/g)).toHaveLength(3)
    expect(source).not.toContain('keyLocation')
    expect(source).not.toContain('loadProviderKey')
  })

  it('存量本机密钥不迁移，界面提示重新填写', () => {
    expect(source).toContain('旧版本的本机密钥不会自动迁移，点编辑重新填写')
    expect(source).toContain('这个服务商还没有密钥（旧版本机密钥不会自动迁移），请重新填写')
  })

  it('编辑态密钥留空时改用托管密钥测试连接', () => {
    expect(source).toContain('aiApi.testProviderStored')
    expect(source).toContain('空 Bearer 打上游必然失败')
  })

  it('供应商表单提供 AI 列表：开关、价格与增删', () => {
    expect(source).toContain('AI 列表')
    expect(source).toContain('function importFormModels')
    expect(source).toContain('function addManualModel')
    expect(source).toContain('function removeFormModel')
    expect(source).toContain('function selectableModels')
    // 关闭的 AI 不可被选用：表单里的模型选择器只给启用的模型
    expect(source).toContain('function formSelectableModels')
    // 保存时把 AI 列表一起提交
    expect(source).toContain('models: form.models ?? []')
    // 列表行有启用开关与输入/输出价格
    expect(source).toContain('entry.enabled = $event')
    expect(source).toContain('entry.priceInput = $event')
    expect(source).toContain('entry.priceOutput = $event')
  })

  it('供应商列表行展示已启用 AI 数徽标', () => {
    expect(source).toContain('function enabledCountOf')
    expect(source).toContain('AI {{ enabledCountOf(provider)!.enabled }}/{{ enabledCountOf(provider)!.total }}')
  })
})
