import { API_PREFIX, type Attachment } from '@nenochat/shared'
import { getAccessToken, getBaseUrl, getDeviceId } from './http'

export interface UploadOptions {
  kind?: 'avatar' | 'file' | 'sticker' | 'background'
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

/**
 * 以 multipart 上传一个文件，返回解析后的 JSON 响应体。
 *
 * 用 XMLHttpRequest 而不是 fetch：fetch 拿不到上传进度。
 * 用 FormData + <input type="file">：不碰 Tauri 的 fs scope，
 * 桌面端与浏览器端走同一份代码。
 */
export function postFile<T>(path: string, file: File, options: UploadOptions = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const form = new FormData()
    form.append('file', file, file.name)

    const url = `${getBaseUrl().replace(/\/$/, '')}${path}`
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)

    const token = getAccessToken()
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`)
    const deviceId = getDeviceId()
    if (deviceId) xhr.setRequestHeader('x-device-id', deviceId)

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(Math.round((event.loaded / event.total) * 100))
      }
    }

    xhr.onerror = () => reject(new Error('网络错误，上传失败'))
    xhr.onabort = () => reject(new Error('已取消上传'))
    xhr.onload = () => {
      let body: unknown = null
      try {
        body = JSON.parse(xhr.responseText)
      } catch {
        /* 非 JSON 响应（例如代理返回的 HTML 错误页） */
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T)
        return
      }

      const message = (body as { error?: { message?: string } } | null)?.error?.message
      reject(new Error(message ?? `上传失败 (${xhr.status})`))
    }

    if (options.signal) {
      options.signal.addEventListener('abort', () => xhr.abort(), { once: true })
    }

    xhr.send(form)
  })
}

/** 上传文件。上传完由调用方决定怎么使用返回的附件 */
export async function uploadFile(file: File, options: UploadOptions = {}): Promise<Attachment> {
  const body = await postFile<{ attachment?: Attachment }>(
    `${API_PREFIX}/files?kind=${options.kind ?? 'file'}`,
    file,
    options,
  )
  if (!body?.attachment) throw new Error('服务端没有返回附件信息')
  return body.attachment
}
