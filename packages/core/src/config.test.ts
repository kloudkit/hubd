import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginModule } from '@hubd/sdk'
import { setting } from '@hubd/sdk'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { ConfigError, ConfigService } from './config.ts'

const dir = mkdtempSync(join(tmpdir(), 'hubd-config-'))

const file = (name: string, text: string) => {
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

const plugin = (id: string, config?: PluginModule['config']): PluginModule => ({
  manifest: { id, version: '0.0.0' },
  path: new URL('file:///'),
  config,
  plugin: () => ({ setup: () => {} }),
})

const greeter = plugin(
  'hello-world',
  z.object({ greeting: z.string().default('Hello'), loud: setting.boolean().default(false) }),
)

const base = { HUBD_DATABASE_URL: 'postgres://db' }

describe('ConfigService', () => {
  it('fills defaults from the schemas', () => {
    const c = ConfigService.load([greeter], base)
    expect(c.core).toMatchObject({ databaseUrl: 'postgres://db', host: '127.0.0.1', port: 5181, auth: 'token' })
    expect(c.plugin('hello-world')).toEqual({ greeting: 'Hello', loud: false })
  })

  it('lets the environment shadow the file, and the file shadow defaults', () => {
    const HUBD_CONFIG = file(
      'shadow.yaml',
      'port: 6000\nhost: 0.0.0.0\nlogLevel: debug\nplugins:\n  hello-world:\n    greeting: Hi\n    loud: true\n',
    )
    const c = ConfigService.load([greeter], {
      ...base,
      HUBD_CONFIG,
      HUBD_PORT: '7000',
      HUBD_PLUGIN_HELLO_WORLD_GREETING: 'Hey',
    })
    expect(c.core).toMatchObject({ port: 7000, host: '0.0.0.0', logLevel: 'debug' })
    expect(c.plugin('hello-world')).toEqual({ greeting: 'Hey', loud: true })
  })

  it('substitutes ${VAR} and ${VAR:-default} in the file', () => {
    const HUBD_CONFIG = file(
      'subst.yaml',
      'databaseUrl: ${DB_URL}\nhost: ${NOPE:-localhost}\nallowedHosts: [a, "${EXTRA}"]\n',
    )
    const c = ConfigService.load([], { HUBD_CONFIG, DB_URL: 'postgres://from-env', EXTRA: 'b' })
    expect(c.core).toMatchObject({ databaseUrl: 'postgres://from-env', host: 'localhost', allowedHosts: ['a', 'b'] })
  })

  it('reads a _FILE variable from the named file', () => {
    const c = ConfigService.load([], { HUBD_DATABASE_URL_FILE: file('secret', 'postgres://secret\n') })
    expect(c.core.databaseUrl).toBe('postgres://secret')
  })

  it('splits a comma list and parses booleans', () => {
    const c = ConfigService.load([], { ...base, HUBD_ALLOWED_HOSTS: 'a.example, b.example', HUBD_MIGRATE: 'true' })
    expect(c.core).toMatchObject({ allowedHosts: ['a.example', 'b.example'], migrate: true })
  })

  it('names unknown HUBD_ variables without failing', () => {
    const c = ConfigService.load([greeter], { ...base, HUBD_HOME: '/x', HUBD_PLUGIN_GONE_KEY: '1' })
    expect(c.unknown.sort()).toEqual(['HUBD_HOME', 'HUBD_PLUGIN_GONE_KEY'])
  })

  it('reports every invalid setting by its variable name, never its value', () => {
    const strict = plugin('strict', z.object({ apiKey: z.string() }))
    try {
      ConfigService.load([strict], { HUBD_PORT: 'not-a-port', HUBD_AUTH: 'sometimes' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      const issues = (e as ConfigError).issues.map((i) => i.split(':')[0])
      expect(issues.sort()).toEqual(['HUBD_AUTH', 'HUBD_DATABASE_URL', 'HUBD_PLUGIN_STRICT_API_KEY', 'HUBD_PORT'])
      expect((e as ConfigError).message).not.toContain('not-a-port')
    }
  })

  it('refuses no login beyond loopback unless told it is insecure', () => {
    expect(() => ConfigService.load([], { ...base, HUBD_AUTH: 'none', HUBD_HOST: '0.0.0.0' })).toThrow(
      /HUBD_AUTH_INSECURE/,
    )
    expect(
      ConfigService.load([], { ...base, HUBD_AUTH: 'none', HUBD_HOST: '0.0.0.0', HUBD_AUTH_INSECURE: '1' }).core.auth,
    ).toBe('none')
  })
})
