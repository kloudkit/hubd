import { readFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import {
  type Actor,
  defineJob,
  type Logger,
  type Origin,
  type PluginModule,
  Problem,
  type Scope,
  VERSION,
} from '@hubd/sdk'
import { and, eq, isNull } from 'drizzle-orm'
import { type Context, Hono, type MiddlewareHandler } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { timeout } from 'hono/timeout'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import { Auth } from './auth.ts'
import { ClientProtocol } from './client.ts'
import { Clients } from './clients.ts'
import { ConfigService, type CoreConfig, hostname, LOOPBACK, storageOf } from './config.ts'
import { Contents } from './content.ts'
import { Database } from './database.ts'
import { historyOperations, squash } from './history.ts'
import { Jobs } from './jobs.ts'
import { Lifecycle } from './lifecycle.ts'
import { PinoLogger } from './logger.ts'
import { type Env, Operations } from './operations.ts'
import { PluginSystem } from './plugins.ts'
import { Records } from './records.ts'
import { space } from './schema.ts'
import { spaceOperations } from './spaces.ts'
import { storeFor } from './storage.ts'
import { subjectOperations } from './subjects.ts'
import { triageOperations } from './triage.ts'

export type HubdOptions = { plugins: PluginModule[]; env?: NodeJS.ProcessEnv; logger?: Logger }

export class Hubd {
  static readonly SPACE_HEADER = 'x-hubd-space'
  static readonly SESSION_HEADER = 'x-hubd-session'
  static readonly MODEL_HEADER = 'x-hubd-model'
  static readonly STAMP = /^[\w.:@/+-]{1,100}$/

  readonly app = new Hono<Env>()
  readonly settings: CoreConfig
  readonly logger: Logger
  readonly database: Database
  readonly lifecycle: Lifecycle
  readonly plugins: PluginSystem
  readonly jobs: Jobs
  readonly operations: Operations
  readonly records = new Records()
  readonly contents: Contents
  readonly clients: Clients
  readonly protocol: ClientProtocol
  readonly auth: Auth
  readonly #modules: PluginModule[]
  readonly #hosts: Set<string>

  constructor(options: HubdOptions) {
    this.#modules = options.plugins
    const config = ConfigService.load(options.plugins, options.env)
    const settings = config.core
    this.settings = settings
    this.logger = options.logger ?? PinoLogger.create(settings.logLevel, settings.logFormat)
    for (const name of config.unknown) this.logger.warn(`${name} is not a hubd setting; it is ignored`)
    this.lifecycle = new Lifecycle(this.logger.get('lifecycle'))
    this.database = new Database(settings.databaseUrl)
    this.lifecycle.onShutdown('database', () => this.database.close())
    this.plugins = new PluginSystem(options.plugins, config, this.logger.get('plugins'))
    this.jobs = new Jobs(this.database.db, this.logger.get('jobs'), {
      url: settings.databaseUrl,
      pollSeconds: settings.jobsPollSeconds,
    })
    const storage = storageOf(settings)
    this.contents = new Contents(this.database.db, storage && storeFor(storage), this.records, {
      maxBytes: settings.fileMaxBytes,
      base: settings.publicUrl ?? `http://${settings.host}:${settings.port}`,
    })
    this.operations = new Operations(this.database.db, this.jobs, this.records, this.contents)
    this.clients = new Clients(this.database.db)
    const named = [...(settings.publicUrl ? [new URL(settings.publicUrl).host] : []), ...settings.allowedHosts]
    this.#hosts = new Set([...LOOPBACK, ...named.map(hostname)])
    this.auth = new Auth(settings)
    this.protocol = new ClientProtocol(this.clients, {
      dir: settings.clientDir,
      publicUrl: settings.publicUrl,
      allows: (host) => this.#hosts.has(hostname(host)),
    })
  }

  async migrate(): Promise<string[]> {
    const sets = await this.database.migrate(this.#modules)
    await this.jobs.migrate()
    this.logger.info(`migrated: ${sets.join(', ')}`)
    return sets
  }

  async start(): Promise<this> {
    if (this.settings.migrate) this.logger.info(`migrated: ${(await this.database.migrate(this.#modules)).join(', ')}`)
    const db = this.database.db
    await this.plugins.setup((id) => ({
      db,
      operations: { add: (...ops) => this.operations.add(id, ...ops) },
      jobs: {
        add: (...jobs) => this.jobs.add(id, ...jobs),
        schedule: (name, cron, data) => this.jobs.schedule(id, name, cron, data),
      },
      records: { register: (kind) => this.records.register(id, kind) },
      events: { subscribe: (...handlers) => this.jobs.subscribe(id, ...handlers) },
    }))
    this.operations.add(
      'core',
      ...spaceOperations(this.records),
      ...subjectOperations,
      ...triageOperations(this.records),
      ...historyOperations,
    )
    this.jobs.add('core', defineJob({ name: 'sweep', run: async () => void (await this.contents.sweep()) }))
    this.jobs.schedule('core', 'sweep', '17 * * * *')
    const days = this.settings.revisionRetentionDays
    if (days) {
      this.jobs.add(
        'core',
        defineJob({
          name: 'squash',
          run: async (_data, { db, logger }) => {
            const done = await squash(db, days)
            logger.info(
              `squashed ${done.dropped} revisions older than ${days} days; ${done.commits} empty commits gone`,
            )
          },
        }),
      )
      this.jobs.schedule('core', 'squash', '43 3 * * *')
    }
    const kinds = await this.records.sync(db)
    this.logger.debug(`record kinds: ${kinds.join(', ') || 'none'}`)
    await this.jobs.start()
    this.lifecycle.onShutdown('jobs', () => this.jobs.stop())
    await this.plugins.start((id) => ({ db, jobs: this.jobs.queue(id) }))
    this.lifecycle.onShutdown('plugins', () => this.plugins.stop())
    this.#routes()
    return this
  }

  listen(port = this.settings.port): Promise<URL> {
    return new Promise((resolve) => {
      const server = serve({ fetch: this.app.fetch, hostname: this.settings.host, port }, (info: AddressInfo) => {
        const url = new URL(`http://${info.family === 'IPv6' ? `[${info.address}]` : info.address}:${info.port}`)
        this.logger.info(`listening on ${url.origin} (auth: ${this.settings.auth})`)
        resolve(url)
      })
      this.lifecycle.onShutdown('http', () => new Promise((done) => server.close(done)))
    })
  }

  shutdown(): Promise<void> {
    return this.lifecycle.shutdown()
  }

  #routes(): void {
    const limits = [
      bodyLimit({
        maxSize: this.settings.maxBodyBytes,
        onError: () => {
          throw new Problem(413, 'Request body too large')
        },
      }),
      timeout(
        this.settings.requestTimeoutSeconds * 1000,
        () => new HTTPException(504, { message: 'Request timed out' }),
      ),
    ]
    this.app.onError((e, c) => this.#problem(c, e))
    this.app.use('*', requestId(), secureHeaders(), this.#accessLog(), this.#hostGuard())
    this.app.use('/api/*', ...limits)
    this.app.use('/mcp', ...limits)
    this.app.get('/health', (c) => this.#health(c))
    this.protocol.mountPublic(this.app)
    this.auth.mount(this.app)
    this.app.put(
      '/upload/:code',
      bodyLimit({
        maxSize: this.settings.fileMaxBytes,
        onError: () => {
          throw new Problem(413, 'File too large')
        },
      }),
      async (c) => {
        const bytes = new Uint8Array(await c.req.arrayBuffer())
        const done = await this.contents.consume(c.req.param('code'), bytes, c.req.header('content-type'))
        return c.json(done, 201)
      },
    )
    this.app.use('/api/*', this.#authGuard(), this.#scopeGuard())
    this.app.use('/mcp', this.#authGuard(), this.#scopeGuard())
    this.app.get('/api/meta', (c) =>
      c.json({
        name: 'hubd',
        version: VERSION,
        plugins: this.plugins.manifests,
        disabled: this.plugins.disabled,
        actor: c.get('actor'),
        scope: c.get('scope'),
      }),
    )
    this.app.get('/api/openapi.json', (c) => c.json(this.operations.openApi(VERSION)))
    this.protocol.mount(this.app)
    this.app.get('/api/attachments/:id', async (c) => {
      const { file, body, inline } = await this.contents.open(c.req.param('id'), c.get('scope'))
      const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`
      return c.body(body, 200, {
        'content-type': inline ? file.type : 'application/octet-stream',
        'content-length': String(file.size),
        'content-disposition': disposition,
        'x-content-type-options': 'nosniff',
      })
    })
    this.operations.mount(this.app)
    this.app.all('/mcp', (c) =>
      this.operations.serveMcp(
        c.req.raw,
        { actor: c.get('actor'), scope: c.get('scope'), origin: c.get('origin') },
        {
          version: VERSION,
          onError: (e) => this.#report(e, c.get('requestId')),
        },
      ),
    )
    if (this.settings.webDir) this.#pages(this.settings.webDir)
  }

  #pages(dir: string): void {
    const index = readFileSync(join(dir, 'index.html'), 'utf8')
    this.app.use('*', async (c, next) => {
      if (/^\/(api|mcp|auth)(\/|$)/.test(c.req.path)) throw new Problem(404, 'Not found')
      if (this.auth.on && !(await this.auth.user(c))) return c.redirect('/auth/login')
      await next()
    })
    this.app.get('*', serveStatic({ root: dir }))
    this.app.get('*', (c) => (/\.[a-z0-9]+$/i.test(c.req.path) ? c.notFound() : c.html(index)))
  }

  async #health(c: Context<Env>): Promise<Response> {
    const headers = { 'content-type': 'application/health+json', 'cache-control': 'no-store' }
    if (c.req.query('ready') === undefined) return c.json({ status: 'pass', version: VERSION }, 200, headers)
    const checks = {
      'database:responseTime': [await this.#ping()],
      'jobs:started': [{ status: this.jobs.started ? 'pass' : 'fail' }],
    }
    const pass = Object.values(checks).every(([check]) => check?.status === 'pass')
    return c.json({ status: pass ? 'pass' : 'fail', version: VERSION, checks }, pass ? 200 : 503, headers)
  }

  async #ping(): Promise<{ status: 'pass' | 'fail'; observedValue?: number; observedUnit?: string }> {
    try {
      return { status: 'pass', observedValue: await this.database.ping(2000), observedUnit: 'ms' }
    } catch (e) {
      this.logger.warn(`readiness check failed: ${e instanceof Error ? e.message : String(e)}`)
      return { status: 'fail' }
    }
  }

  #report(e: unknown, request: string): void {
    if (Problem.from(e).status >= 500) this.logger.with({ request }).error('request failed', e)
  }

  #problem(c: Context<Env>, e: unknown): Response {
    this.#report(e, c.get('requestId'))
    const p = Problem.from(e)
    return c.json(p.toJSON(), p.status as ContentfulStatusCode, { 'content-type': 'application/problem+json' })
  }

  #accessLog(): MiddlewareHandler<Env> {
    return async (c, next) => {
      const started = performance.now()
      await next()
      this.logger
        .with({ request: c.get('requestId') })
        .debug(`${c.req.method} ${c.req.path} ${c.res.status} ${Math.round(performance.now() - started)}ms`)
    }
  }

  #hostGuard(): MiddlewareHandler<Env> {
    return async (c, next) => {
      if (!this.#hosts.has(hostname(c.req.header('host')))) throw new Problem(421, 'Misdirected request')
      const origin = c.req.header('origin')
      if (origin && !this.#hosts.has(hostname(URL.parse(origin)?.host))) throw new Problem(403, 'Forbidden origin')
      await next()
    }
  }

  #scopeGuard(): MiddlewareHandler<Env> {
    return async (c, next) => {
      const name = c.req.header(Hubd.SPACE_HEADER)
      let scope: Scope = { mode: 'open' }
      if (name) {
        const [row] = await this.database.db
          .select({ id: space.id, isolated: space.isolated })
          .from(space)
          .where(and(eq(space.name, name), isNull(space.parent)))
        if (!row?.isolated) throw new Problem(400, `${Hubd.SPACE_HEADER} names no isolated scope "${name}"`)
        scope = { mode: 'isolated', space: row.id, name }
      }
      c.set('scope', scope)
      c.set('origin', { session: this.#stamp(c, Hubd.SESSION_HEADER), model: this.#stamp(c, Hubd.MODEL_HEADER) })
      await next()
    }
  }

  #stamp(c: Context<Env>, header: string): Origin['session'] {
    const value = c.req.header(header)?.trim()
    if (!value) return null
    if (!Hubd.STAMP.test(value)) throw new Problem(400, `${header} is 1 to 100 letters, digits or . : @ / + - _`)
    return value
  }

  #authGuard(): MiddlewareHandler<Env> {
    return async (c, next) => {
      const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]
      const actor: Actor | null = bearer
        ? await this.clients.verify(bearer)
        : this.settings.auth === 'none'
          ? { kind: 'anonymous' }
          : await this.auth.user(c)
      if (!actor) {
        c.header('www-authenticate', 'Bearer')
        throw new Problem(401, 'Unauthorized')
      }
      c.set('actor', actor)
      await next()
    }
  }
}
