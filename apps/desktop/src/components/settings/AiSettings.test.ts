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
    expect(source).toContain("{{ editingProvider ? '保存修改' : '保存服务商' }}")
  })

  it('编辑本机密钥回填明文，保存走 PATCH 并同步钥匙串', () => {
    expect(source).toContain(
      "provider.keyLocation === 'local' ? await loadProviderKey(provider.id) : ''",
    )
    expect(source).toContain('aiApi.updateProvider(editingId, payload)')
    expect(source).toContain('await saveProviderKey(editingId, form.apiKey)')
    expect(source).toContain('await clearProviderKey(editingId)')
    expect(source).toContain(
      "form.keyLocation === 'server' && !form.apiKey ? {} : { apiKey: form.apiKey ?? '' }",
    )
  })
})
