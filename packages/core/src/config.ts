import { existsSync, readFileSync } from 'node:fs'
import { type ConfigSchema, type PluginId, type PluginModule, setting } from '@hubd/sdk'
import { parse } from 'yaml'
import { z } from 'zod'

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export const hostname = (host: string | undefined): string =>
  (host ? (URL.parse(`http://${host}`)?.hostname ?? '') : '').toLowerCase()

const coreConfigSchema = z
  .object({
    databaseUrl: z.string().min(1),
    host: z.string().default('127.0.0.1'),
    publicUrl: z.url({ protocol: /^https?$/ }).optional(),
    clientDir: z.string().optional(),
    port: setting.number().pipe(z.number().int().min(0).max(65535)).default(5181),
    auth: z.enum(['token', 'none', 'oidc']).default('token'),
    oidcIssuer: z.url().optional(),
    oidcClientId: z.string().optional(),
    oidcClientSecret: z.string().optional(),
    oidcScopes: z
      .string()
      .default('openid email profile')
      .transform((s) => s.trim().replace(/\s+/g, ' '))
      .refine((s) => s.split(' ').includes('openid'), 'must include openid'),
    oidcGroupsClaim: z.string().default('groups'),
    authAllow: setting
      .list()
      .transform((l) => l.map((x) => x.toLowerCase()))
      .default([]),
    sessionSecret: z.string().min(32).optional(),
    sessionDays: setting.number().pipe(z.number().int().positive()).default(30),
    webDir: z.string().optional(),
    authInsecure: setting.boolean().default(false),
    allowedHosts: setting.list().default([]),
    migrate: setting.boolean().default(false),
    logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    logFormat: z.enum(['text', 'json']).default('text'),
    maxBodyBytes: setting
      .number()
      .pipe(z.number().int().positive())
      .default(10 * 1024 * 1024),
    requestTimeoutSeconds: setting.number().pipe(z.number().positive()).default(30),
    jobsPollSeconds: setting.number().pipe(z.number().min(0.5)).default(2),
    storage: z.enum(['volume', 's3']).default('volume'),
    storageDir: z.string().optional(),
    s3Endpoint: z.string().optional(),
    s3Bucket: z.string().optional(),
    s3Prefix: z.string().default(''),
    s3Region: z.string().default('us-east-1'),
    fileMaxBytes: setting
      .number()
      .pipe(z.number().int().positive())
      .default(25 * 1024 * 1024),
    revisionRetentionDays: setting.number().pipe(z.number().int().positive()).optional(),
  })
  .refine((c) => c.auth !== 'none' || LOOPBACK.has(c.host) || c.authInsecure, {
    path: ['authInsecure'],
    message: 'auth "none" listens only on loopback; set it to true to listen on another host',
  })
  .superRefine((c, ctx) => {
    if (c.auth !== 'oidc') return
    const needs = {
      publicUrl: c.publicUrl,
      oidcIssuer: c.oidcIssuer,
      oidcClientId: c.oidcClientId,
      oidcClientSecret: c.oidcClientSecret,
      sessionSecret: c.sessionSecret,
      authAllow: c.authAllow.length ? c.authAllow : undefined,
    }
    for (const [key, value] of Object.entries(needs)) {
      if (!value) ctx.addIssue({ code: 'custom', path: [key], message: 'is required when auth is "oidc"' })
    }
  })

export type CoreConfig = z.output<typeof coreConfigSchema>

export type StorageConfig =
  | { kind: 'volume'; dir: string }
  | { kind: 's3'; endpoint: string; bucket: string; prefix: string; region: string }

export function storageOf(c: CoreConfig): StorageConfig | null {
  if (c.storage === 'volume')
    return c.storageDir ? { kind: 'volume', dir: c.storageDir.replace(/(.)\/+$/, '$1') } : null
  if (!c.s3Bucket) return null
  const prefix = c.s3Prefix.replace(/^\/+|\/+$/g, '')
  return {
    kind: 's3',
    endpoint: (c.s3Endpoint ?? '').replace(/\/$/, ''),
    bucket: c.s3Bucket,
    prefix: prefix ? `${prefix}/` : '',
    region: c.s3Region,
  }
}

type Raw = Record<string, unknown>

type Section = { id: PluginId | null; prefix: string; schema: ConfigSchema; file: Raw; env: Raw }

const FILE_VAR = 'HUBD_CONFIG'

const envName = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()

const asObject = (value: unknown): Raw =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Raw) : {}

function substitute(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === 'string') {
    const whole = value.match(/^\$\{([A-Za-z0-9_]+)(?::-(.*))?\}$/)
    if (whole) return env[whole[1] as string] ?? whole[2]
    return value.replace(/\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
      return env[name] ?? fallback ?? ''
    })
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, env))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, env)]))
  }
  return value
}

function readFile(env: NodeJS.ProcessEnv): Raw {
  const path = env[FILE_VAR] ?? (existsSync('hubd.yaml') ? 'hubd.yaml' : null)
  return path ? asObject(substitute(parse(readFileSync(path, 'utf8')), env)) : {}
}

export class ConfigError extends Error {
  readonly issues: string[]

  constructor(issues: string[]) {
    super(`hubd's configuration is invalid:\n  ${issues.join('\n  ')}`)
    this.issues = issues
  }
}

export class ConfigService {
  readonly core: CoreConfig
  readonly unknown: string[]
  readonly #plugins: Map<PluginId, unknown>

  private constructor(core: CoreConfig, plugins: Map<PluginId, unknown>, unknown: string[]) {
    this.core = core
    this.#plugins = plugins
    this.unknown = unknown
  }

  static load(modules: PluginModule[], env: NodeJS.ProcessEnv = process.env): ConfigService {
    const file = readFile(env)
    const sections: Section[] = [
      { id: null, prefix: 'HUBD_', schema: coreConfigSchema, file, env: {} },
      ...modules.map((m) => ({
        id: m.manifest.id,
        prefix: `HUBD_PLUGIN_${m.manifest.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_`,
        schema: m.config ?? z.object({}),
        file: asObject(asObject(file.plugins)[m.manifest.id]),
        env: {},
      })),
    ]
    const names = new Map<string, { section: Section; key: string }>()
    for (const section of sections) {
      for (const key of Object.keys(section.schema.shape)) {
        const name = section.prefix + envName(key)
        if (names.has(name)) throw new ConfigError([`${name} is claimed by two settings`])
        names.set(name, { section, key })
      }
    }
    const unknown: string[] = []
    for (const [name, value] of Object.entries(env)) {
      if (!name.startsWith('HUBD_') || name === FILE_VAR || value === undefined) continue
      const fromFile = name.endsWith('_FILE')
      const target = names.get(fromFile ? name.slice(0, -'_FILE'.length) : name)
      if (!target) unknown.push(name)
      else target.section.env[target.key] = fromFile ? readFileSync(value, 'utf8').trim() : value
    }
    const issues: string[] = []
    const parsed = new Map<PluginId | null, unknown>()
    for (const section of sections) {
      const result = section.schema.safeParse({ ...section.file, ...section.env })
      if (result.success) parsed.set(section.id, result.data)
      else
        for (const i of result.error.issues)
          issues.push(`${section.prefix}${envName(String(i.path[0] ?? ''))}: ${i.message}`)
    }
    if (issues.length) throw new ConfigError(issues)
    return new ConfigService(parsed.get(null) as CoreConfig, parsed as Map<PluginId, unknown>, unknown)
  }

  plugin<T = unknown>(id: PluginId): T {
    return this.#plugins.get(id) as T
  }
}
