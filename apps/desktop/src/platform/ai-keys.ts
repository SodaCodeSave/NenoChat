import { deleteSecret, getSecret, setSecret } from './secure-store'

/**
 * AI 服务商密钥的本地保管：按 provider id 存进系统钥匙串。
 * 只在使用「本机 key」模式时有效，云端 key 模式由服务端解密。
 */
export function aiKeyAccount(providerId: string): string {
  return `ai.provider.${providerId}`
}

export async function saveProviderKey(providerId: string, apiKey: string): Promise<void> {
  if (!apiKey) return
  await setSecret(aiKeyAccount(providerId), apiKey)
}

export async function loadProviderKey(providerId: string): Promise<string> {
  return getSecret(aiKeyAccount(providerId))
}

export async function clearProviderKey(providerId: string): Promise<void> {
  await deleteSecret(aiKeyAccount(providerId))
}
