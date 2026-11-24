import { describe, expect, it } from 'vitest'
import source from './MomentShareCard.vue?raw'

describe('MomentShareCard 统一卡片规格', () => {
  it('固定宽度、圆角边框走主题变量，不写死微信蓝', () => {
    expect(source).toContain('w-[240px]')
    expect(source).toContain('rounded-xl border border-line bg-surface')
    expect(source).toContain('text-accent')
    expect(source).not.toContain('#576b95')
  })

  it('封面固定高度、走懒加载，加载失败时隐藏而不是留破图', () => {
    expect(source).toContain('h-28')
    expect(source).toContain('loading="lazy"')
    expect(source).toContain('@error="coverFailed = true"')
    expect(source).toContain('v-if="coverUrl && !coverFailed"')
  })

  it('作者行 + 类型徽标 + 两行摘要 + 底部动作行', () => {
    expect(source).toContain(':name="card.authorName"')
    expect(source).toContain('动态')
    expect(source).toContain('line-clamp-2')
    expect(source).toContain('查看动态')
  })

  it('点击回到动态页并定位原帖子', () => {
    expect(source).toContain('`#/moments?post=${encodeURIComponent(props.card.postId)}`')
    expect(source).toContain('data-card="moment"')
  })

  it('空白摘要给占位文案，卡片不留空洞', () => {
    expect(source).toContain('[无正文]')
  })
})
