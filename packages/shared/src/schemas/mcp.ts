import { z } from 'zod'

/** 非敏感配置：具体字段在服务端做二次校验 */
export const McpServerConfigSchema = z.object({
  timeoutMs: z.number().int().min(1000).max(120000).nullable().optional(),
})

/** 敏感配置：自定义请求头。创建/更新时随请求传入，服务端加密后只回掩码 */
export const McpServerSecretSchema = z.object({
  headers: z.record(z.string().min(1).max(256), z.string().max(4096)).optional(),
})

export const McpServerCreateSchema = z.object({
  name: z.string().trim().min(1).max(64),
  url: z.string().trim().min(8).max(1024),
  enabled: z.boolean().optional(),
  config: McpServerConfigSchema.optional(),
  secret: McpServerSecretSchema.optional(),
})

export const McpServerPatchSchema = z.object({
  name: z.string().trim().min(1).max(64).optional(),
  url: z.string().trim().min(8).max(1024).optional(),
  enabled: z.boolean().optional(),
  config: McpServerConfigSchema.optional(),
  secret: McpServerSecretSchema.optional(),
})

export type McpServerCreateInput = z.infer<typeof McpServerCreateSchema>
export type McpServerPatchInput = z.infer<typeof McpServerPatchSchema>
