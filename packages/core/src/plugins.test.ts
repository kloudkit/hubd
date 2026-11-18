import type { PluginManifest, PluginModule } from '@hubd/sdk'
import { describe, expect, it } from 'vitest'
import { ConfigService } from './config.ts'
import { PinoLogger } from './logger.ts'
import { CycleError, PluginSystem } from './plugins.ts'

const manifest = (id: string, requiredPlugins: string[] = [], optionalPlugins: string[] = []): PluginManifest => ({
  id,
  version: '0.0.0',
  requiredPlugins,
  optionalPlugins,
})

const module = (m: PluginManifest, plugin: PluginModule['plugin']): PluginModule => ({
  manifest: m,
  path: new URL('file:///'),
  plugin,
})

describe('PluginSystem.order', () => {
  it('puts every plugin after what it requires or optionally uses', () => {
    expect(PluginSystem.order([manifest('c', ['b']), manifest('b', [], ['a']), manifest('a')]).order).toEqual([
      'a',
      'b',
      'c',
    ])
  })

  it('sets aside a plugin whose requirement is missing, and its dependants', () => {
    const r = PluginSystem.order([manifest('a', ['gone']), manifest('b', ['a']), manifest('c', [], ['gone'])])
    expect(r.order).toEqual(['c'])
    expect(r.disabled.map((d) => d.id).sort()).toEqual(['a', 'b'])
  })

  it('refuses a cycle', () => {
    expect(() => PluginSystem.order([manifest('a', ['b']), manifest('b', ['a'])])).toThrow(CycleError)
  })
})

describe('PluginSystem', () => {
  it('hands each plugin only the contracts it declared, setup before start', async () => {
    const seen: string[] = []
    const modules = [
      module(manifest('a'), () => ({ setup: () => 'a-setup', start: () => 'a-start' })),
      module(manifest('b', ['a']), () => ({
        setup: (_core, deps) => void seen.push(`setup ${JSON.stringify(deps)}`),
        start: (_core, deps) => void seen.push(`start ${JSON.stringify(deps)}`),
      })),
      module(manifest('c'), () => ({ setup: (_core, deps) => void seen.push(`c ${JSON.stringify(deps)}`) })),
    ]
    const config = ConfigService.load(modules, { HUBD_DATABASE_URL: 'postgres://unused' })
    const system = new PluginSystem(modules, config, PinoLogger.silent())
    await system.setup(() => ({
      db: {} as never,
      operations: { add: () => {} },
      jobs: { add: () => {}, schedule: () => {} },
      records: { register: () => {} },
      events: { subscribe: () => {} },
    }))
    await system.start(() => ({ db: {} as never, jobs: {} as never }))
    expect(seen).toEqual(['c {}', 'setup {"a":"a-setup"}', 'start {"a":"a-start"}'])
  })

  it('refuses the same id twice', () => {
    const m = module(manifest('a'), () => ({ setup: () => {} }))
    const config = ConfigService.load([m], { HUBD_DATABASE_URL: 'postgres://unused' })
    expect(() => new PluginSystem([m, m], config, PinoLogger.silent())).toThrow(/twice/)
  })
})
