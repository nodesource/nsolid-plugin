import { z } from 'zod'
import type { BundleDescriptor } from './types.js'

const SkillRefSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  requiresMcp: z.array(z.string()).refine(
    (arr) => new Set(arr).size === arr.length,
    { message: 'must have unique items' }
  ).optional()
}).strict()

const McpUrlSchema = z.string().min(1).refine((value) => {
  if (/\$\{\w+\}/.test(value)) return true
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}, { message: 'must be a valid http(s) URL or contain template variables' })

const McpServerRefSchema = z.object({
  name: z.string(),
  url: McpUrlSchema,
  headers: z.record(z.string(), z.string())
}).strict()

const AuthConfigSchema = z.object({
  type: z.literal('oauth'),
  provider: z.string(),
  accountsUrl: z.string().url(),
  callbackPort: z.number().int().optional(),
  requiredPermissions: z.array(z.string()).optional()
}).strict()

const BundleDescriptorSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  skills: z.array(SkillRefSchema).min(1),
  mcpServers: z.array(McpServerRefSchema).min(1),
  auth: AuthConfigSchema.optional()
}).strict()

export function validateBundle (data: unknown): BundleDescriptor {
  const result = BundleDescriptorSchema.safeParse(data)
  if (!result.success) {
    const errors = result.error.issues
      .map(e => `${e.path.join('.')} ${e.message}`)
      .join('; ')
    throw new Error(`Bundle validation failed: ${errors}`)
  }
  return result.data
}
