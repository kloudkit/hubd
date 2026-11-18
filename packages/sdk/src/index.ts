import { type SQL, sql } from 'drizzle-orm'
import { type AnyPgColumn, type PgTable, pgSchema, uuid } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { z } from 'zod'

export const VERSION = '0.0.0'

export type PluginId = string

export type Db = PostgresJsDatabase<Record<string, never>>

export type Actor =
  | { kind: 'client'; id: string; name: string }
  | { kind: 'user'; id: string; name: string; email: string }
  | { kind: 'anonymous' }

export const GLOBAL_SPACE = '00000000-0000-7000-8000-000000000001'

export type Scope = { mode: 'open' } | { mode: 'isolated'; space: string; name: string }

export type Origin = { session: string | null; model: string | null }

const spaceRef = pgSchema('hubd').table('space', { id: uuid().primaryKey() })

export const home = () => uuid().references((): AnyPgColumn => spaceRef.id, { onDelete: 'restrict' })

export const homePath = (column: AnyPgColumn): SQL<string | null> =>
  sql<
    string | null
  >`(select case when hp.name is null then hs.name else hp.name || '/' || hs.name end from hubd.space hs left join hubd.space hp on hp.id = hs.parent where hs.id = ${column})`

export const actorId = (actor: Actor): string | null => (actor.kind === 'client' ? actor.id : null)

export const actorName = (actor: Actor): string => (actor.kind === 'anonymous' ? 'anonymous' : actor.name)

export const likePattern = (q: string): string => `%${q.replace(/[\\%_]/g, '\\$&')}%`

export const inputs = {
  spacePath: z.string().min(1).max(81).describe('space path: scope or scope/project'),
  color: z
    .string()
    .regex(/^(#[0-9a-f]{6}|[a-z]{3,20})$/)
    .describe('a colour name or #rrggbb'),
  subjectRefs: z
    .array(
      z.object({
        kind: z.enum(['topic', 'asset']),
        name: z.string().min(1).max(80),
        path: z.string().max(200).optional(),
      }),
    )
    .max(20),
  ids: z.array(z.uuid()).max(20),
  global: z
    .union([z.boolean(), z.stringbool()])
    .default(false)
    .describe('set only after the operator approved changing something homed in global from an isolated session'),
}

export type RecordKind = { kind: string; table: PgTable; id: AnyPgColumn; home: AnyPgColumn; mention?: string }

export type SubjectKind = 'topic' | 'asset'

export type SubjectRef = { kind: SubjectKind; name: string; path?: string }

export type RecordRef = { kind: string; id: string }

export type LinkInput = { texts?: string[]; about?: SubjectRef[]; refs?: RecordRef[] }

export type Link = {
  kind: 'about' | 'mentions' | 'ref'
  to: { subject: { id: string; kind: SubjectKind; name: string } } | { record: RecordRef }
  path: string | null
}

export type CommitView = {
  id: string
  at: Date
  actor: string
  session: string | null
  model: string | null
  operation: string
  reason: string | null
}

export type RevisionView = { n: number; baseline: boolean; deleted: boolean; commit: CommitView }

export interface History {
  record(target: RecordRef, home: string | null, snapshot: object | null): Promise<number>
  commit(reason?: string): Promise<string>
  revisions(target: RecordRef): Promise<RevisionView[]>
  snapshot(target: RecordRef, n: number): Promise<(RevisionView & { snapshot: object | null }) | null>
}

export type FileInput = { name: string; bytes: Uint8Array; type?: string }

export type Attachment = { id: string; name: string; type: string; size: number; createdAt: Date }

export interface Attachments {
  add(from: RecordRef, file: FileInput, options?: { maxBytes?: number }): Promise<Attachment>
  list(from: RecordRef): Promise<Attachment[]>
  listMany(from: RecordRef[]): Promise<Map<string, Attachment[]>>
  uploadUrl(from: RecordRef, name: string): Promise<{ url: string; expiresAt: Date; command: string }>
}

export interface Links {
  set(from: RecordRef, input: LinkInput): Promise<{ lint: string[]; texts: string[]; created: string[] }>
  pointingAt(target: { subject: string }, fromKind: string): Promise<{ id: string; kind: Link['kind'] }[]>
  list(from: RecordRef): Promise<Link[]>
  listMany(from: RecordRef[]): Promise<Map<string, Link[]>>
  render(texts: string[]): Promise<string[]>
}

export interface Moves {
  move(record: RecordRef, home: string | null): Promise<void>
}

export type SubjectInput = {
  kind: SubjectKind
  name: string
  home?: string | null
  summary?: string
  type?: string
  endpoint?: string
  reachedBy?: string
}

export type SubjectPatch = {
  home?: string | null
  summary?: string | null
  type?: string
  endpoint?: string | null
  reachedBy?: string | null
}

export type SubjectView = {
  id: string
  kind: SubjectKind
  name: string
  home: string | null
  summary: string | null
  type: string | null
  endpoint: string | null
  reachedBy: string | null
  createdAt: Date
  retiredAt: Date | null
}

export type LegendEntry = { name: string; type: string | null; endpoint: string | null; reachedBy: string | null }

export interface Subjects {
  find(kind: SubjectKind, name: string): Promise<{ id: string; home: string | null } | null>
  legend(ids: string[]): Promise<LegendEntry[]>
  create(input: SubjectInput): Promise<SubjectView>
  update(kind: SubjectKind, name: string, patch: SubjectPatch, confirmed?: boolean): Promise<SubjectView>
  rename(kind: SubjectKind, name: string, to: string, confirmed?: boolean): Promise<SubjectView>
  alias(kind: SubjectKind, name: string, alias: string, remove?: boolean, confirmed?: boolean): Promise<SubjectView>
  merge(kind: SubjectKind, from: string, into: string, confirmed?: boolean): Promise<SubjectView>
  retire(kind: SubjectKind, name: string, confirmed?: boolean): Promise<SubjectView>
}

export interface Names {
  claim(owner: RecordRef, name: string): Promise<void>
  end(owner: RecordRef, name: string): Promise<boolean>
  resolve(kind: string, name: string): Promise<string | null>
  current(kind: string, ids: string[]): Promise<Map<string, string>>
  history(owner: RecordRef): Promise<{ name: string; validFrom: Date; validUntil: Date | null }[]>
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(message: string): void
  info(message: string): void
  warn(message: string): void
  error(message: string, error?: unknown): void
  get(name: string): Logger
  with(bindings: Record<string, unknown>): Logger
}

export const setting = {
  boolean: () => z.union([z.boolean(), z.stringbool()]),
  number: () => z.coerce.number(),
  list: () =>
    z.union([
      z.array(z.string()),
      z.string().transform((s) =>
        s
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      ),
    ]),
}

export type PluginManifest = {
  id: PluginId
  version: string
  requiredPlugins?: PluginId[]
  optionalPlugins?: PluginId[]
  database?: boolean
}

export type PluginInitializerContext<Config = unknown> = {
  manifest: PluginManifest
  logger: Logger
  config: Config
}

export type Contracts = Record<PluginId, unknown>

export interface Plugin<
  Setup = void,
  Start = void,
  SetupDeps extends Contracts = Contracts,
  StartDeps extends Contracts = Contracts,
> {
  setup(core: CoreSetup, deps: SetupDeps): Setup | Promise<Setup>
  start?(core: CoreStart, deps: StartDeps): Start | Promise<Start>
  stop?(): void | Promise<void>
}

export type ConfigSchema = z.ZodObject

export type PluginModule<Schema extends ConfigSchema = ConfigSchema> = {
  manifest: PluginManifest
  path: URL
  config?: Schema
  plugin(context: PluginInitializerContext<z.output<Schema>>): Plugin<unknown, unknown>
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]

export type JobOptions = { retryLimit?: number; retryDelay?: number; retryBackoff?: boolean; expireInSeconds?: number }

export type SendOptions = { startAfter?: number | string | Date; singletonKey?: string; tx?: Tx }

export type JobContext = { db: Db; logger: Logger; attempt: number }

export type Job<T extends object = object> = {
  name: string
  options?: JobOptions
  run(data: T, context: JobContext): Promise<void>
}

export const defineJob = <T extends object>(job: Job<T>): Job<T> => job

export type EventData = { id: string; home: string | null; to?: string }

export interface Events {
  publish(name: string, data: EventData): Promise<void>
}

export type EventHandler = {
  event: string
  options?: JobOptions
  run(data: EventData, context: JobContext): Promise<void>
}

export const defineEventHandler = (handler: EventHandler): EventHandler => handler

export interface JobQueue {
  send<T extends object>(name: string, data: T, options?: SendOptions): Promise<string | null>
}

export type ContextBase = {
  actor: Actor
  scope: Scope
  origin: Origin
  visible(home: AnyPgColumn | SQL): SQL
  jobs: JobQueue
  events: Events
}

export type OperationContext = ContextBase & {
  tx: Tx
  links: Links
  attachments: Attachments
  moves: Moves
  subjects: Subjects
  names: Names
  history: History
  homeFor(path?: string | null): Promise<string | null>
  confirmGlobal(home: string | null, confirmed: boolean): void
  sees(fromHome: string | null, toHome: string | null): Promise<boolean>
}

export type PlainOperationContext = ContextBase & {
  db: Db
  transaction<T>(run: (context: OperationContext) => Promise<T>): Promise<T>
}

type OperationBase<I extends z.ZodRawShape> = {
  id: string
  summary: string
  description?: string
  input: I
  http?: { method: HttpMethod; path: `/${string}` }
  mcp?: false | { name?: string; title?: string; readOnly?: boolean; destructive?: boolean }
}

export type Operation<I extends z.ZodRawShape = z.ZodRawShape, O = unknown> = OperationBase<I> &
  (
    | { transaction?: true; run(input: z.infer<z.ZodObject<I>>, context: OperationContext): Promise<O> }
    | { transaction: false; run(input: z.infer<z.ZodObject<I>>, context: PlainOperationContext): Promise<O> }
  )

export const defineOperation = <I extends z.ZodRawShape, O>(operation: Operation<I, O>): Operation<I, O> => operation

export type CoreSetup = {
  db: Db
  operations: { add(...operations: Operation[]): void }
  jobs: { add(...jobs: Job[]): void; schedule(name: string, cron: string, data?: object): void }
  records: { register(kind: RecordKind): void }
  events: { subscribe(...handlers: EventHandler[]): void }
  getStartServices(): Promise<[CoreStart, Contracts]>
}

export type CoreStart = { db: Db; jobs: JobQueue }

export class Problem extends Error {
  readonly status: number
  readonly detail?: string[]

  constructor(status: number, title: string, detail?: string[]) {
    super(title)
    this.status = status
    this.detail = detail
  }

  static from(error: unknown): Problem {
    if (error instanceof Problem) return error
    const status = (error as { status?: unknown } | null)?.status
    if (error instanceof Error && typeof status === 'number' && status >= 400 && status < 600) {
      return new Problem(status, error.message)
    }
    return new Problem(500, 'Internal error')
  }

  toJSON() {
    return { title: this.message, status: this.status, ...(this.detail?.length ? { detail: this.detail } : {}) }
  }

  toText(): string {
    return [this.message, ...(this.detail ?? [])].join('\n')
  }
}
