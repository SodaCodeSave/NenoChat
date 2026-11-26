import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import source from './ui.ts?raw'
import chatHeaderSource from '@/components/chat/ChatHeader.vue?raw'
import conversationItemSource from '@/components/layout/ConversationItem.vue?raw'
import momentsSource from '@/views/MomentsView.vue?raw'
import conversationSettingsSource from '@/views/ConversationSettingsView.vue?raw'
import appearanceSource from '@/components/settings/sections/AppearanceSettings.vue?raw'

const indexCssSource = readFileSync(
  fileURLToPath(new URL('../styles/index.css', import.meta.url)),
  'utf8',
)

describe('AI 标识开关与主题色', () => {
  it('ui store 提供本地持久化的 showAiBadge 偏好，默认开启', () => {
    expect(source).toContain("const AI_BADGE_KEY = 'nenochat.showAiBadge'")
    // 未设置时默认显示（只有显式 'false' 才关闭）
    expect(source).toContain("localStorage.getItem(AI_BADGE_KEY) !== 'false'")
    expect(source).toContain('setShowAiBadge')
  })

  it('各处的 AI 角标都跟随开关', () => {
    expect(chatHeaderSource).toContain('v-if="isAi && ui.showAiBadge"')
    expect(conversationItemSource).toContain('v-if="isAi && ui.showAiBadge"')
    expect(momentsSource).toContain('v-if="post.personaId && ui.showAiBadge"')
    expect(conversationSettingsSource).toContain('personaByUserId.has(member.userId) && ui.showAiBadge')
  })

  it('外观设置里提供 AI 标识开关', () => {
    expect(appearanceSource).toContain('label="AI 标识"')
    expect(appearanceSource).toContain(':model-value="ui.showAiBadge"')
    expect(appearanceSource).toContain('@update:model-value="ui.setShowAiBadge"')
  })

  it('AI 标识色跟随主题色，不再固定紫色', () => {
    expect(indexCssSource).toContain('--mention: var(--accent);')
    expect(indexCssSource).toContain('--mention-soft: var(--accent-soft);')
    // 硬编码紫色已被移除
    expect(indexCssSource).not.toContain('#7c5cff;\n  --mention-soft')
    expect(indexCssSource).not.toContain('--mention: #9d8cff')
  })
})
