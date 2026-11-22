import { describe, expect, it } from 'vitest'
import inputSource from '@/components/chat/MessageInput.vue?raw'
import viewSource from '@/views/ConversationView.vue?raw'

describe('拖拽上传附件', () => {
  it('MessageInput 暴露 handleFiles，拖拽投递与文件选择器、粘贴共用同一条上传管线', () => {
    expect(inputSource).toContain('defineExpose({ insertMention, handleFiles })')
  })

  it('聊天列挂四个拖拽事件，悬停遮罩盖住整个会话区', () => {
    expect(viewSource).toContain('@dragenter="onDragEnter"')
    expect(viewSource).toContain('@dragover="onDragOver"')
    expect(viewSource).toContain('@dragleave="onDragLeave"')
    expect(viewSource).toContain('@drop="onDrop"')
    expect(viewSource).toContain('v-if="draggingFile"')
    expect(viewSource).toContain('pointer-events-none absolute inset-0')
  })

  it('drop 提取 dataTransfer 的文件交给 MessageInput 上传', () => {
    expect(viewSource).toContain('Array.from(event.dataTransfer?.files ?? [])')
    expect(viewSource).toContain('messageInput.value?.handleFiles(files)')
  })

  it('enter/leave 用计数抵消子元素间的抖动，drop 时清零', () => {
    expect(viewSource).toContain('dragDepth.value += 1')
    expect(viewSource).toContain('if (dragDepth.value > 0) dragDepth.value -= 1')
    expect(viewSource).toContain('dragDepth.value = 0')
  })

  it('只接管文件拖拽，页面内拖文本仍走 textarea 原生插入', () => {
    expect(viewSource).toContain("Array.from(event.dataTransfer?.types ?? []).includes('Files')")
    expect(viewSource).toContain('if (!dragHasFiles(event)) return')
  })

  it('dragover 必须 preventDefault，浏览器才允许 drop', () => {
    expect(viewSource).toMatch(/function onDragOver[\s\S]*?event\.preventDefault\(\)/)
  })

  it('文件拖到聊天列外也不让 WebView 打开文件，卸载时摘掉窗口监听', () => {
    expect(viewSource).toContain("window.addEventListener('dragover', preventFileNavigation)")
    expect(viewSource).toContain("window.addEventListener('drop', preventFileNavigation)")
    expect(viewSource).toContain("window.removeEventListener('dragover', preventFileNavigation)")
    expect(viewSource).toContain("window.removeEventListener('drop', preventFileNavigation)")
    expect(viewSource).toContain('function preventFileNavigation(event: DragEvent): void')
  })

  it('遮罩文案区分普通会话与 AI 会话', () => {
    expect(viewSource).toContain("isAi ? '松开发送图片' : '松开发送文件'")
    expect(viewSource).toContain("isAi ? 'AI 会话暂只支持图片' : '支持图片与文件，一次最多 9 个'")
  })
})
