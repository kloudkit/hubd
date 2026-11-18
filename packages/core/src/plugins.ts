import type { Contracts, CoreSetup, CoreStart, Logger, Plugin, PluginId, PluginManifest, PluginModule } from '@hubd/sdk'
import type { ConfigService } from './config.ts'

export type Disabled = { id: PluginId; missing: PluginId[] }

export class CycleError extends Error {
  constructor(ids: PluginId[]) {
    super(`plugins depend on each other in a cycle: ${ids.join(', ')}`)
  }
}

export class PluginSystem {
  readonly #modules = new Map<PluginId, PluginModule>()
  readonly #plugins = new Map<PluginId, Plugin<unknown, unknown>>()
  readonly #logger: Logger
  readonly #config: ConfigService
  readonly #started = Promise.withResolvers<[(id: PluginId) => CoreStart, Contracts]>()
  readonly #order: PluginId[]
  readonly disabled: Disabled[]
  #startedIds: PluginId[] = []

  constructor(modules: PluginModule[], config: ConfigService, logger: Logger) {
    for (const m of modules) {
      if (this.#modules.has(m.manifest.id)) throw new Error(`plugin "${m.manifest.id}" is registered twice`)
      this.#modules.set(m.manifest.id, m)
    }
    this.#logger = logger
    this.#config = config
    const planned = PluginSystem.order(modules.map((m) => m.manifest))
    this.#order = planned.order
    this.disabled = planned.disabled
    for (const d of this.disabled) {
      logger.warn(`plugin "${d.id}" is off: it requires ${d.missing.join(', ')}, which is not registered`)
    }
  }

  static order(manifests: PluginManifest[]): { order: PluginId[]; disabled: Disabled[] } {
    const byId = new Map(manifests.map((m) => [m.id, m]))
    const disabled: Disabled[] = []
    for (let changed = true; changed; ) {
      changed = false
      for (const m of [...byId.values()]) {
        const missing = (m.requiredPlugins ?? []).filter((r) => !byId.has(r))
        if (missing.length) {
          byId.delete(m.id)
          disabled.push({ id: m.id, missing })
          changed = true
        }
      }
    }
    const needs = new Map(
      [...byId.values()].map((m) => [m.id, new Set(PluginSystem.#dependencies(m).filter((d) => byId.has(d)))]),
    )
    const order: PluginId[] = []
    for (let ready = PluginSystem.#ready(needs); ready.length; ready = PluginSystem.#ready(needs)) {
      for (const id of ready) {
        order.push(id)
        needs.delete(id)
        for (const n of needs.values()) n.delete(id)
      }
    }
    if (needs.size) throw new CycleError([...needs.keys()])
    return { order, disabled }
  }

  static #dependencies(m: PluginManifest): PluginId[] {
    return [...(m.requiredPlugins ?? []), ...(m.optionalPlugins ?? [])]
  }

  static #ready(needs: Map<PluginId, Set<PluginId>>): PluginId[] {
    return [...needs]
      .filter(([, n]) => n.size === 0)
      .map(([id]) => id)
      .sort()
  }

  get manifests(): PluginManifest[] {
    return this.#order.map((id) => this.#module(id).manifest)
  }

  async setup(core: (id: PluginId) => Omit<CoreSetup, 'getStartServices'>): Promise<void> {
    const contracts: Contracts = {}
    for (const id of this.#order) {
      const { manifest, plugin } = this.#module(id)
      const instance = plugin({ manifest, logger: this.#logger.get(id), config: this.#config.plugin(id) })
      this.#plugins.set(id, instance)
      contracts[id] = await instance.setup(
        {
          ...core(id),
          getStartServices: () => this.#started.promise.then(([start, contracts]) => [start(id), contracts]),
        },
        this.#deps(contracts, manifest),
      )
    }
  }

  async start(core: (id: PluginId) => CoreStart): Promise<void> {
    const contracts: Contracts = {}
    for (const id of this.#order) {
      contracts[id] = await this.#plugins.get(id)?.start?.(core(id), this.#deps(contracts, this.#module(id).manifest))
      this.#startedIds.push(id)
    }
    this.#started.resolve([core, contracts])
  }

  async stop(): Promise<void> {
    for (const id of this.#startedIds.reverse()) await this.#plugins.get(id)?.stop?.()
    this.#startedIds = []
  }

  #module(id: PluginId): PluginModule {
    const m = this.#modules.get(id)
    if (!m) throw new Error(`plugin "${id}" is not registered`)
    return m
  }

  #deps(contracts: Contracts, manifest: PluginManifest): Contracts {
    return Object.fromEntries(
      PluginSystem.#dependencies(manifest)
        .filter((d) => d in contracts)
        .map((d) => [d, contracts[d]]),
    )
  }
}
