import { describe, expect, it } from 'vitest'
import source from './MomentsView.vue?raw'
import composerSource from '../components/moments/MomentsComposer.vue?raw'

describe('MomentsView 空间头', () => {
  it('顶部有头图区块：点头图直接换、未设置时渐变占位', () => {
    // 头图走 background 附件 + PATCH /users/me 存进 users.banner_url
    expect(source).toContain("uploadFile(file, { kind: 'background' })")
    expect(source).toContain("userApi.updateProfile({ bannerUrl: attachment.url })")
    // 未设置头图时渲染主题色渐变占位，而不是整块不渲染
    expect(source).toContain('bannerStyle')
    expect(source).toContain('linear-gradient')
    expect(source).toContain('color-mix(in srgb, var(--accent)')
    // 上传前本地预览，失败/成功都要回收对象 URL
    expect(source).toContain('URL.createObjectURL(file)')
    expect(source).toContain('URL.revokeObjectURL(localObjectUrl)')
    expect(source).toContain('bannerUploading')
  })

  it('头像与签名叠在头图下沿，签名复用个人资料 bio', () => {
    expect(source).toContain(':size="56"')
    expect(source).toContain('ring')
    expect(source).toContain('auth.user?.bio ||')
    // QQ 空间式空签名文案
    expect(source).toContain('这个人很懒，什么都没有写')
  })

  it('发帖逻辑完全移入共享组件，视图不再保留 textarea 与图片上传', () => {
    expect(source).toContain('bannerError')
    expect(source).not.toContain('pickImages')
    expect(source).not.toContain('<textarea')
    expect(composerSource).toContain('<textarea')
  })
})

describe('MomentsView 发帖入口', () => {
  it('桌面端保留常驻发布框（MomentsComposer），发布逻辑抽出共用', () => {
    expect(source).toContain("import MomentsComposer from '@/components/moments/MomentsComposer.vue'")
    expect(source).toContain('<MomentsComposer v-if="!ui.isMobile"')
  })

  it('手机端顶部紧凑条 + Dialog 弹窗发帖，发布成功自动关弹窗', () => {
    expect(source).toContain('composerOpen = true')
    expect(source).toContain('分享点什么…')
    expect(source).toContain("import Dialog from '@/components/ui/form/Dialog.vue'")
    expect(source).toContain('<Dialog v-model:open="composerOpen"')
    expect(source).toContain('bare')
    expect(source).toContain('@published="composerOpen = false"')
  })

  it('MomentsComposer 保留原有发帖能力：5000 字、9 张图、独立上传', () => {
    expect(composerSource).toContain('maxlength="5000"')
    expect(composerSource).toContain('pendingImages.length >= 9')
    expect(composerSource).toContain("uploadFile(file, { kind: 'file' })")
    expect(composerSource).toContain("emit('published')")
    // 视图里不再内联发帖逻辑，只能从共享组件走
    expect(source).not.toContain('maxlength="5000"')
  })
})

describe('MomentsView 空间帖子样式', () => {
  it('帖子改成 QQ 空间式平铺：蓝色昵称、时段、点赞名单、常驻评论', () => {
    expect(source).toContain('data-post-id=')
    expect(source).toContain('text-[#576b95]')
    expect(source).toContain('feedTime(post.createdAt)')
    expect(source).toContain('(post.likers ?? []).map((liker) => liker.name).join')
    expect(source).toContain('moments.comments[post.id] ?? []')
    // 评论区不再有展开/收起状态
    expect(source).not.toContain('openComments')
  })

  it('评论输入框和发送按钮只在点击评论按钮后出现，样式与发帖一致', () => {
    expect(source).toContain('openCommentInputs[post.id]')
    expect(source).toContain('@click="toggleCommentInput(post.id)"')
    expect(source).toContain('v-if="openCommentInputs[post.id]"')
    expect(source).toContain(
      'rounded-xl border border-line bg-surface-2 px-3 text-[13.5px] outline-none focus:border-accent',
    )
    const publishButton =
      'rounded-lg bg-accent px-3 py-1 text-[12.5px] font-medium text-accent-text disabled:opacity-50'
    expect(source).toContain(publishButton)
    expect(composerSource).toContain(publishButton)
  })

  it('分享复用会话选择器，卡片携带作者、摘要和封面', () => {
    expect(source).toContain("import ForwardDialog from '@/components/chat/ForwardDialog.vue'")
    expect(source).toContain('title="分享动态到"')
    expect(source).toContain('meta: { momentCard: card }')
    expect(source).toContain('postId: post.id')
    expect(source).toContain('authorName: postAuthorName(post)')
    expect(source).toContain('coverUrl: cover?.thumbUrl || cover?.url || null')
  })

  it('从卡片跳回时按 post 参数定位并高亮帖子', () => {
    expect(source).toContain("route.query.post")
    expect(source).toContain('moments.focus(postId)')
    expect(source).toContain('highlightedPostId.value = postId')
    expect(source).toContain('scrollIntoView')
  })
})
