import { open, save } from '@tauri-apps/plugin-dialog'
import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { isTauri } from './device'

/**
 * 备份文件的落盘 / 读取。
 * 桌面端走系统对话框 + fs；浏览器模式退化为下载与文件选择，
 * 两条路径产出的都是同一份 JSON，可互相导入。
 */

const FILTER = { name: 'NenoChat 备份', extensions: ['json'] }

export interface BackupExportResult {
  fileName: string
  path: string | null
  bytes: number
}

/** 保存备份文件；用户取消返回 null */
export async function saveBackupFile(
  fileName: string,
  contents: string,
): Promise<BackupExportResult | null> {
  const bytes = new Blob([contents]).size

  if (isTauri()) {
    const path = await save({ defaultPath: fileName, filters: [FILTER] })
    if (!path) return null
    await writeTextFile(path, contents)
    return { fileName, path, bytes }
  }

  const blob = new Blob([contents], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return { fileName, path: null, bytes }
}

export interface PickedBackupFile {
  fileName: string
  text: string
}

function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || 'backup.json'
}

/** 选择并读取备份文件；用户取消返回 null */
export async function pickBackupFile(): Promise<PickedBackupFile | null> {
  if (isTauri()) {
    const selected = await open({ multiple: false, directory: false, filters: [FILTER] })
    const path = Array.isArray(selected) ? selected[0] : selected
    if (!path) return null
    const text = await readTextFile(path)
    return { fileName: fileNameOf(path), text }
  }

  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    const finish = (value: PickedBackupFile | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }

    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        finish(null)
        return
      }
      void file.text().then((text) => finish({ fileName: file.name, text }))
    }
    // 浏览器取消选择不会触发 change，用窗口重新获得焦点兜底
    window.addEventListener(
      'focus',
      () => {
        window.setTimeout(() => {
          if (!input.files || input.files.length === 0) finish(null)
        }, 500)
      },
      { once: true },
    )

    input.click()
  })
}
