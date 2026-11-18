import {
  type Actor,
  type ContextBase,
  type Db,
  type HttpMethod,
  type Operation,
  type OperationContext,
  type Origin,
  type PluginId,
  Problem,
  type Scope,
  type Tx,
} from '@hubd/sdk'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { sha256 } from './codes.ts'
import type { Contents } from './content.ts'
import { History, rehome } from './history.ts'
import type { Jobs } from './jobs.ts'
import { LinkService } from './links.ts'
import { claimName, currentNames, endName, history as nameHistory, resolveRecord } from './names.ts'
import type { Records } from './records.ts'
import { SubjectService } from './subjects.ts'
import { confirmGlobal, homeForWrite, Places, visibleTo } from './visibility.ts'
import { moveRecord } from './world.ts'

export type Env = { Variables: { actor: Actor; scope: Scope; origin: Origin; requestId: string } }

export type Caller = { actor: Actor; scope: Scope; origin: Origin }

const PARAM = /:([A-Za-z0-9_]+)/g

const MCP_INSTRUCTIONS =
  "hubd holds the operator's records. Its standing instructions are not here: global ones are rules files in ~/.claude/rules/hubd/, and a scope's reach its session at start through hubridge."

type Registered = {
  plugin: PluginId
  op: Operation
  schema: z.ZodObject
  key: string
  tool: string | null
  http: { method: HttpMethod; path: string; readsQuery: boolean } | null
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new Problem(400, 'The request body is not JSON')
  }
}

function parse(r: Registered, raw: unknown): Record<string, unknown> {
  const result = r.schema.safeParse(raw)
  if (result.success) return result.data
  throw new Problem(
    400,
    'Invalid input',
    result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  )
}

export class Operations {
  readonly #all: Registered[] = []
  readonly #db: Db
  readonly #jobs: Jobs
  readonly #records: Records
  readonly #contents: Contents
  #openApi: object | null = null

  constructor(db: Db, jobs: Jobs, records: Records, contents: Contents) {
    this.#db = db
    this.#jobs = jobs
    this.#records = records
    this.#contents = contents
  }

  add(plugin: PluginId, ...ops: Operation[]): void {
    for (const op of ops) {
      const r: Registered = {
        plugin,
        op,
        schema: z.object(op.input),
        key: `${plugin}.${op.id}`,
        tool: op.mcp === false ? null : op.mcp?.name || `${plugin}_${op.id}`,
        http: op.http
          ? {
              method: op.http.method,
              path: `/api/${plugin}${op.http.path}`,
              readsQuery: op.http.method === 'GET' || op.http.method === 'DELETE',
            }
          : null,
      }
      if (this.#all.some((o) => o.key === r.key || (r.tool && o.tool === r.tool))) {
        throw new Error(`operation "${r.key}" is registered twice`)
      }
      this.#all.push(r)
    }
  }

  #base(r: Registered, { actor, scope, origin }: Caller, tx?: Tx): ContextBase {
    return {
      actor,
      scope,
      origin,
      visible: (home: AnyPgColumn | SQL) => visibleTo(scope, home),
      jobs: this.#jobs.queue(r.plugin, tx),
      events: this.#jobs.events(r.plugin, tx),
    }
  }

  #context(r: Registered, tx: Tx, caller: Caller): OperationContext {
    const { actor, scope, origin } = caller
    const history = new History(
      tx,
      scope,
      { actor, origin, operation: r.key },
      r.plugin === 'core' ? null : { plugin: r.plugin, records: this.#records },
    )
    const core = history.core()
    return {
      ...this.#base(r, caller, tx),
      tx,
      links: new LinkService(tx, scope, r.plugin, actor, this.#records, core),
      attachments: this.#contents.bind(tx, r.plugin, scope, actor),
      moves: {
        move: async (record, home) => {
          await this.#records.own(tx, r.plugin, record, scope, 'moves it')
          await moveRecord(tx, new Places(tx), this.#records, record, home)
          await rehome(tx, record, home)
        },
      },
      subjects: new SubjectService(tx, scope, actor, this.#jobs.events('core', tx), this.#records, core),
      history,
      names: {
        claim: async (owner, name) => {
          const { home } = await this.#records.own(tx, r.plugin, owner, scope, 'names it')
          await claimName(tx, new Places(tx), owner.kind, { record: owner.id }, name, home)
        },
        end: async (owner, name) => {
          await this.#records.own(tx, r.plugin, owner, scope, 'names it')
          return (await endName(tx, { record: owner.id }, name)) > 0
        },
        resolve: async (kind, name) => {
          const id = await resolveRecord(tx, kind, name, scope)
          return id && (await this.#records.home(tx, { kind, id }, scope)) ? id : null
        },
        current: (kind, ids) => currentNames(tx, kind, ids),
        history: (owner) => nameHistory(tx, { record: owner.id }),
      },
      homeFor: (path) => homeForWrite(tx, scope, path),
      confirmGlobal: (home, confirmed) => confirmGlobal(scope, home, confirmed, 'record'),
      sees: async (fromHome, toHome) => {
        const places = new Places(tx)
        return places.sees(await places.eyes(fromHome), toHome)
      },
    }
  }

  #invoke(r: Registered, raw: unknown, caller: Caller): Promise<unknown> {
    const input = parse(r, raw)
    const op = r.op
    if (op.transaction === false) {
      return op.run(input, {
        ...this.#base(r, caller),
        db: this.#db,
        transaction: (run) => this.#db.transaction((tx) => run(this.#context(r, tx, caller))),
      })
    }
    return this.#db.transaction((tx) => op.run(input, this.#context(r, tx, caller)))
  }

  mount(app: Hono<Env>): void {
    for (const r of this.#all) {
      const http = r.http
      if (!http) continue
      app.on(http.method, http.path, async (c) => {
        const body = http.readsQuery ? c.req.query() : await readJson(c)
        const out = await this.#invoke(
          r,
          { ...(body as object), ...c.req.param() },
          { actor: c.get('actor'), scope: c.get('scope'), origin: c.get('origin') },
        )
        if (http.method !== 'GET') return c.json(out as object, http.method === 'POST' ? 201 : 200)
        const json = JSON.stringify(out)
        const etag = `W/"${sha256(json).slice(0, 32)}"`
        if (c.req.header('if-none-match') === etag) return c.body(null, 304, { etag })
        return c.body(json, 200, { 'content-type': 'application/json', etag })
      })
    }
  }

  async serveMcp(
    req: Request,
    caller: Caller,
    info: { version: string; onError(e: unknown): void },
  ): Promise<Response> {
    const server = new McpServer({ name: 'hubd', version: info.version }, { instructions: MCP_INSTRUCTIONS })
    for (const r of this.#all) {
      if (!r.tool) continue
      const mcp = r.op.mcp || {}
      server.registerTool(
        r.tool,
        {
          title: mcp.title ?? r.op.summary,
          description: r.op.description ?? r.op.summary,
          inputSchema: r.schema,
          annotations: { readOnlyHint: mcp.readOnly, destructiveHint: mcp.destructive },
        },
        async (args: unknown) => {
          try {
            const out = await this.#invoke(r, args, caller)
            return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 2) }] }
          } catch (e) {
            info.onError(e)
            return { isError: true, content: [{ type: 'text' as const, text: Problem.from(e).toText() }] }
          }
        },
      )
    }
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    await server.connect(transport)
    return transport.handleRequest(req)
  }

  openApi(version: string): object {
    this.#openApi ??= this.#describe(version)
    return this.#openApi
  }

  #describe(version: string) {
    const paths: Record<string, Record<string, unknown>> = {}
    for (const r of this.#all) {
      const http = r.http
      if (!http) continue
      const pathParams = [...http.path.matchAll(PARAM)].map((m) => m[1] as string)
      const schema = z.toJSONSchema(r.schema, { io: 'input' }) as {
        properties?: Record<string, unknown>
        required?: string[]
      }
      const parameters = Object.entries(schema.properties ?? {})
        .filter(([name]) => http.readsQuery || pathParams.includes(name))
        .map(([name, s]) => ({
          name,
          in: pathParams.includes(name) ? 'path' : 'query',
          required: pathParams.includes(name) || (schema.required ?? []).includes(name),
          schema: s,
        }))
      const oaPath = http.path.replace(PARAM, '{$1}')
      paths[oaPath] = {
        ...paths[oaPath],
        [http.method.toLowerCase()]: {
          operationId: r.key,
          tags: [r.plugin],
          summary: r.op.summary,
          description: r.op.description,
          parameters: parameters.length ? parameters : undefined,
          requestBody: http.readsQuery ? undefined : { required: true, content: { 'application/json': { schema } } },
          responses: { default: { description: r.op.summary } },
        },
      }
    }
    return {
      openapi: '3.1.0',
      info: { title: 'hubd', version },
      components: { securitySchemes: { token: { type: 'http', scheme: 'bearer' } } },
      security: [{ token: [] }],
      paths,
    }
  }
}
