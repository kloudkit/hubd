import type { Db, EventHandler, Events, Job, JobOptions, JobQueue, Logger, PluginId, SendOptions, Tx } from '@hubd/sdk'
import { sql } from 'drizzle-orm'
import { fromDrizzle, PgBoss } from 'pg-boss'

type Registered = { plugin: PluginId; queue: string; options?: JobOptions; run: Job['run']; event?: string }

type Schedule = { queue: string; cron: string; data?: object }

export class Jobs {
  static readonly SCHEMA = 'hubd_jobs'
  static readonly POOL = 4

  readonly #db: Db
  readonly #url: string
  readonly #logger: Logger
  readonly #pollSeconds: number
  readonly #jobs: Registered[] = []
  readonly #schedules: Schedule[] = []
  #boss: PgBoss | null = null

  constructor(db: Db, logger: Logger, options: { url: string; pollSeconds: number }) {
    this.#db = db
    this.#url = options.url
    this.#logger = logger
    this.#pollSeconds = options.pollSeconds
  }

  static #queue(plugin: PluginId, name: string): string {
    if (name.includes('.')) throw new Error(`job "${name}" may not contain "."; a plugin names only its own jobs`)
    return `${plugin}.${name}`
  }

  #create(active: boolean): PgBoss {
    const boss = new PgBoss({
      connectionString: this.#url,
      max: Jobs.POOL,
      schema: Jobs.SCHEMA,
      supervise: active,
      schedule: active,
    })
    boss.on('error', (e) => this.#logger.error('job queue error', e))
    return boss
  }

  async migrate(): Promise<void> {
    const boss = this.#create(false)
    await boss.start()
    await boss.stop({ graceful: false })
  }

  add(plugin: PluginId, ...jobs: Job[]): void {
    for (const job of jobs) {
      const queue = Jobs.#queue(plugin, job.name)
      if (this.#jobs.some((j) => j.queue === queue)) throw new Error(`job "${queue}" is registered twice`)
      this.#jobs.push({ plugin, queue, options: job.options, run: job.run })
    }
  }

  subscribe(plugin: PluginId, ...handlers: EventHandler[]): void {
    for (const h of handlers) {
      if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(h.event)) {
        throw new Error(`event "${h.event}" must be <plugin>.<name>, lowercase, dot separated`)
      }
      const queue = Jobs.#queue(plugin, `on-${h.event.replaceAll('.', '-')}`)
      if (this.#jobs.some((j) => j.queue === queue)) throw new Error(`"${plugin}" subscribes to "${h.event}" twice`)
      this.#jobs.push({ plugin, queue, event: h.event, options: h.options, run: h.run })
    }
  }

  events(plugin: PluginId, tx?: Tx): Events {
    return {
      publish: async (name, data) => {
        await this.#started().publish(`${plugin}.${name}`, data, Jobs.#via(tx))
      },
    }
  }

  schedule(plugin: PluginId, name: string, cron: string, data?: object): void {
    this.#schedules.push({ queue: Jobs.#queue(plugin, name), cron, data })
  }

  queue(plugin: PluginId, tx?: Tx): JobQueue {
    return { send: (name, data, options) => this.#send(Jobs.#queue(plugin, name), data, { tx, ...options }) }
  }

  async #send(queue: string, data: object, options: SendOptions = {}): Promise<string | null> {
    const { tx, ...rest } = options
    return this.#started().send(queue, data, { ...rest, ...Jobs.#via(tx) })
  }

  #started(): PgBoss {
    if (!this.#boss) throw new Error('jobs are not started')
    return this.#boss
  }

  static #via(tx: Tx | undefined) {
    return tx ? { db: fromDrizzle(tx, sql) } : {}
  }

  async start(): Promise<void> {
    const boss = this.#create(this.#jobs.length > 0 || this.#schedules.length > 0)
    await boss.start()
    this.#boss = boss
    for (const { plugin, queue, options, run, event } of this.#jobs) {
      if (!(await boss.getQueue(queue))) await boss.createQueue(queue, options)
      else if (options) await boss.updateQueue(queue, options)
      if (event) await boss.subscribe(event, queue)
      const logger = this.#logger.get(queue)
      await boss.work<object>(queue, { pollingIntervalSeconds: this.#pollSeconds }, async ([j]) => {
        if (j) {
          await run(j.data, {
            db: this.#db,
            logger: logger.with({ job: j.id }),
            attempt: j.retryCount + 1,
            events: this.events(plugin),
          })
        }
      })
    }
    for (const s of this.#schedules) await boss.schedule(s.queue, s.cron, s.data ?? null)
    this.#logger.info(`jobs ready: ${this.#jobs.map((j) => j.queue).join(', ') || 'none'}`)
  }

  get started(): boolean {
    return this.#boss !== null
  }

  async stop(): Promise<void> {
    await this.#boss?.stop({ graceful: true })
    this.#boss = null
  }
}
