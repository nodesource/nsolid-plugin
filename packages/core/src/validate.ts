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
  accountsUrl: z.string().url().refine(
    (value) => {
      // Try/catch defensively: in Zod v4 a `.refine` can receive a value that
      // failed an earlier `url()` check (checks aren't strictly short-circuited),
      // and `new URL` would throw and crash the validator instead of returning
      // a clean validation failure.
      let u
      try { u = new URL(value) } catch { return false }
      // Origin-only: no path (beyond "/"), query, or hash. The auth manager
      // builds endpoints via `new URL('/sign-in', accountsUrl)`, and the URL
      // constructor REPLACES the entire base path when given a leading-slash
      // path, so a base like "https://host/api/v1" would silently drop
      // "/api/v1" and OAuth would hit the wrong endpoint.
      return (u.pathname === '/' || u.pathname === '') && u.search === '' && u.hash === ''
    },
    { message: 'must be an origin-only URL with no path, query, or hash (e.g. https://accounts.nodesource.com)' }
  ),
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
