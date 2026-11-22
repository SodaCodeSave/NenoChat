import { describe, expect, it } from 'vitest'
import source from './McpSkillSettings.vue?raw'

describe('McpSkillSettings', () => {
  it('MCP 卡片锚点与技能卡片锚点齐备', () => {
    expect(source).toContain('id="mcp"')
    expect(source).toContain('id="skills"')
  })

  it('MCP 请求头编辑按加密值处理，不回显明文', () => {
    // 已保存的掩码只用于提示文案；新输入的 header 值用 password 框
    expect(source).toContain('type="password"')
    expect(source).toContain('值（加密保存）')
  })

  it('技能正文用等宽多行编辑器，描述提示模型触发依据', () => {
    expect(source).toContain('id="skill-content"')
    expect(source).toContain('模型靠这段话判断什么时候要用这个技能')
  })
})
