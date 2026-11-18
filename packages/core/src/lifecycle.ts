import type { Logger } from '@hubd/sdk'

type Hook = { name: string; run(): unknown }

export class Lifecycle {
  readonly #hooks: Hook[] = []
  readonly #logger: Logger
  #stopping: Promise<void> | null = null

  constructor(logger: Logger) {
    this.#logger = logger
  }

  onShutdown(name: string, run: () => unknown): void {
    this.#hooks.push({ name, run })
  }

  shutdown(): Promise<void> {
    this.#stopping ??= this.#run()
    return this.#stopping
  }

  untilSignal(): Promise<NodeJS.Signals> {
    return new Promise((resolve) => {
      for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => resolve(signal))
    })
  }

  async #run(): Promise<void> {
    for (const hook of this.#hooks.reverse()) {
      try {
        await hook.run()
      } catch (e) {
        this.#logger.error(`shutdown of ${hook.name} failed`, e)
      }
    }
  }
}
