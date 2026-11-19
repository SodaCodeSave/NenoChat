import { describe, expect, it } from 'vitest'
import source from './AiSettings.vue?raw'

describe('AiSettings', () => {
  it('在 AI 服务商卡片内展示 TokenRouter 推广横幅', () => {
    expect(source).toContain(
      "import TokenRouterAdBanner from '@/components/settings/TokenRouterAdBanner.vue'",
    )
    expect(source).toContain('<TokenRouterAdBanner />')

    const providersAt = source.indexOf('id="providers"')
    const bannerAt = source.indexOf('<TokenRouterAdBanner />')
    const replyAt = source.indexOf('id="reply"')
    expect(bannerAt).toBeGreaterThan(providersAt)
    expect(bannerAt).toBeLessThan(replyAt)
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
})
