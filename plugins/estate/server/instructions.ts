import { actorName, defineOperation, homePath, inputs, type OperationContext, Problem, setting } from '@hubd/sdk'
import { and, asc, eq, getTableColumns, isNull, max, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { checkBudget } from './budget.ts'
import { claimBySlug } from './read.ts'
import { instruction } from './schema.ts'
import {
  BODY_MAX,
  CLAIMS_FILE,
  checkBody,
  fileName,
  LINE_GUIDE,
  lineCount,
  numbered,
  quoteImports,
  TITLE_MAX,
} from './text.ts'

export const INSTRUCTION = 'estate.instruction'

type Ctx = OperationContext
type Row = typeof instruction.$inferSelect

const name = z
  .string()
  .min(1)
  .max(83)
  .transform((n) => n.replace(/\.md$/, ''))
  .describe('the instruction file name, with or without .md')
const title = z.string().trim().min(1).max(TITLE_MAX)
const body = z.string().max(BODY_MAX).describe('Markdown; not starting with --- and with no @path import')
const machines = z
  .array(
    z
      .string()
      .trim()
      .regex(/^[\w.@-]{1,40}$/),
  )
  .min(1)
  .max(50)
  .nullable()
  .describe('client names it loads on; null for every machine')

const ref = (id: string) => ({ kind: INSTRUCTION, id })
const columns = { ...getTableColumns(instruction), path: homePath(instruction.home) }
const inHome = (home: string | null): SQL => (home ? eq(instruction.home, home) : isNull(instruction.home))
const sorted = (list: string[] | null | undefined) => (list ? [...new Set(list)].sort() : null)

async function rows(ctx: Ctx, where: SQL | undefined) {
  return ctx.tx
    .select(columns)
    .from(instruction)
    .where(and(ctx.visible(instruction.home), where))
    .orderBy(sql`${columns.path} nulls first`, asc(instruction.position), asc(instruction.createdAt))
}

async function byName(ctx: Ctx, file: string): Promise<Row> {
  const id = await ctx.names.resolve(INSTRUCTION, file)
  const [row] = id ? await rows(ctx, eq(instruction.id, id)) : []
  if (!row) throw new Problem(404, `No instruction "${file}"`)
  return row
}

function warnings(row: Pick<Row, 'body' | 'home'>): string[] {
  const lines = lineCount(row.body)
  return [
    ...(lines > LINE_GUIDE ? [`${lines} lines, over Claude Code's ${LINE_GUIDE}-line guidance for one file`] : []),
    ...(row.home === null ? ['unassigned: it loads in no session until it has a home'] : []),
  ]
}

async function views(ctx: Ctx, found: (Row & { path: string | null })[], withBody: boolean) {
  const files = await ctx.names.current(
    INSTRUCTION,
    found.map((r) => r.id),
  )
  return found.map((r) => ({
    name: files.get(r.id) ?? r.id,
    title: r.title,
    home: r.path,
    enabled: r.enabled,
    machines: r.machines,
    position: r.position,
    revision: r.revision,
    chars: r.body.length,
    lines: lineCount(r.body),
    warnings: warnings(r),
    ...(withBody ? { body: r.body } : {}),
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }))
}

async function one(ctx: Ctx, id: string) {
  const [view] = await views(ctx, await rows(ctx, eq(instruction.id, id)), true)
  if (!view) throw new Error('instruction vanished')
  return view
}

async function revise(ctx: Ctx, row: Row): Promise<void> {
  const { title, body, enabled, machines, home, position } = row
  await ctx.history.record(ref(row.id), home, { title, body, enabled, machines, home, position })
}

async function nameFor(ctx: Ctx, id: string, from: string): Promise<void> {
  const base = fileName(from)
  for (let n = 1; n <= 50; n++) {
    const candidate = numbered(base, n)
    if (candidate === CLAIMS_FILE) continue
    try {
      await ctx.names.claim(ref(id), candidate)
      return
    } catch (e) {
      if (!(e instanceof Problem && e.status === 409)) throw e
    }
  }
  throw new Problem(409, `Every file name from "${base}" is taken; choose another title`)
}

async function nextPosition(ctx: Ctx, home: string | null): Promise<number> {
  const [top] = await ctx.tx
    .select({ n: max(instruction.position) })
    .from(instruction)
    .where(inHome(home))
  return (top?.n ?? -1) + 1
}

async function draft(ctx: Ctx, slug: string) {
  const c = await claimBySlug(ctx, slug)
  const [statement = c.statement, detail = c.detail] = await ctx.links.render([c.statement, c.detail])
  const text = quoteImports(detail).trim()
  return { title: statement.slice(0, TITLE_MAX), body: `# ${quoteImports(statement)}\n${text ? `\n${text}\n` : ''}` }
}

const OPERATOR =
  'An operator action: instructions reach every session in their home, so act only as the operator directs.'

export const instructionOperations = [
  defineOperation({
    id: 'instructions.list',
    summary: 'List instructions',
    description:
      'Instructions this session can see, by home and order, without their bodies. An enabled global instruction is a rules file on every machine it names; one in a scope or project reaches only sessions there, at session start.',
    input: {
      home: inputs.spacePath.optional(),
      enabled: setting.boolean().optional(),
    },
    http: { method: 'GET', path: '/instructions' },
    mcp: { name: 'instructions_list', readOnly: true },
    run: async (a, ctx) =>
      views(
        ctx,
        await rows(
          ctx,
          and(
            a.home ? sql`${columns.path} = ${a.home}` : undefined,
            a.enabled === undefined ? undefined : eq(instruction.enabled, a.enabled),
          ),
        ),
        false,
      ),
  }),
  defineOperation({
    id: 'instructions.get',
    summary: 'Get an instruction with its body and revisions',
    description: 'One instruction by file name; with revision, that revision as it was.',
    input: { name, revision: z.coerce.number().int().min(1).optional() },
    http: { method: 'GET', path: '/instructions/get' },
    mcp: { name: 'instructions_get', readOnly: true },
    async run(a, ctx) {
      const row = await byName(ctx, a.name)
      if (a.revision !== undefined) {
        const old = await ctx.history.snapshot(ref(row.id), a.revision)
        if (!old) throw new Problem(404, `Instruction ${a.name} has no revision ${a.revision}`)
        return { name: a.name, ...old }
      }
      return { ...(await one(ctx, row.id)), revisions: await ctx.history.revisions(ref(row.id)) }
    },
  }),
  defineOperation({
    id: 'instructions.add',
    summary: 'Add an instruction',
    description: `Its file name comes from the title. With claim, the title and body are drafted from that claim's text once; nothing links them after. Its home is the given space path; with none, an isolated session uses its scope and an open one leaves it unassigned, where it loads nowhere. Refused when an enabled instruction would take its scope over the load cap. ${OPERATOR}`,
    input: {
      title: title.optional(),
      body: body.optional(),
      claim: z.string().min(1).max(80).optional().describe('the slug of a claim to draft from'),
      home: inputs.spacePath.optional(),
      enabled: z.boolean().default(true),
      machines: machines.optional(),
    },
    http: { method: 'POST', path: '/instructions' },
    mcp: { name: 'instructions_add' },
    async run(a, ctx) {
      const drafted = a.claim ? await draft(ctx, a.claim) : null
      const text = { title: a.title ?? drafted?.title, body: a.body ?? drafted?.body ?? '' }
      if (!text.title) throw new Problem(400, 'An instruction needs a title')
      checkBody(text.body)
      const home = await ctx.homeFor(a.home)
      const [row] = await ctx.tx
        .insert(instruction)
        .values({
          home,
          title: text.title,
          body: text.body,
          enabled: a.enabled,
          machines: sorted(a.machines),
          position: await nextPosition(ctx, home),
          createdBy: actorName(ctx.actor),
        })
        .returning()
      if (!row) throw new Error('instruction was not stored')
      await nameFor(ctx, row.id, text.title)
      await revise(ctx, row)
      if (row.enabled) await checkBudget(ctx, [home])
      return one(ctx, row.id)
    },
  }),
  defineOperation({
    id: 'instructions.update',
    summary: 'Change an instruction',
    description: `Pass the revision from instructions_get: if it changed since, the update is refused. home moves it; its file name stays. Refused when it would take its scope over the load cap. ${OPERATOR}`,
    input: {
      name,
      revision: z.number().int().describe('the revision this change starts from'),
      title: title.optional(),
      body: body.optional(),
      enabled: z.boolean().optional(),
      machines: machines.optional(),
      home: inputs.spacePath.nullable().optional().describe('move it to this space path'),
      global: inputs.global,
    },
    http: { method: 'PATCH', path: '/instructions' },
    mcp: { name: 'instructions_update' },
    async run({ name: file, revision, home, global, machines: targets, ...patch }, ctx) {
      const row = await byName(ctx, file)
      ctx.confirmGlobal(row.home, global)
      if (row.revision !== revision) {
        throw new Problem(409, `Instruction ${file} is at revision ${row.revision}, not ${revision}`)
      }
      if (patch.body !== undefined) checkBody(patch.body)
      const to = home === undefined ? row.home : await ctx.homeFor(home)
      const moved = to !== row.home
      if (moved) await ctx.moves.move(ref(row.id), to)
      const [next] = await ctx.tx
        .update(instruction)
        .set({
          ...patch,
          ...(targets === undefined ? {} : { machines: sorted(targets) }),
          ...(moved ? { home: to, position: await nextPosition(ctx, to) } : {}),
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(eq(instruction.id, row.id))
        .returning()
      if (!next) throw new Error('instruction vanished')
      await revise(ctx, next)
      const grew = next.enabled && (!row.enabled || moved || next.body.length > row.body.length)
      if (grew) await checkBudget(ctx, [next.home])
      return one(ctx, row.id)
    },
  }),
  defineOperation({
    id: 'instructions.order',
    summary: 'Order the instructions of one home',
    description: `Name every instruction of one home once, in the new order. ${OPERATOR}`,
    input: { names: z.array(name).min(1).max(200), global: inputs.global },
    http: { method: 'PUT', path: '/instructions/order' },
    mcp: { name: 'instructions_order' },
    async run({ names, global }, ctx) {
      const picked = await Promise.all(names.map((n) => byName(ctx, n)))
      const homes = new Set(picked.map((p) => p.home))
      const [home = null] = homes
      if (homes.size > 1) throw new Problem(400, 'Order the instructions of one home at a time')
      ctx.confirmGlobal(home, global)
      const all = await rows(ctx, inHome(home))
      const ids = new Set(picked.map((p) => p.id))
      if (ids.size !== picked.length || all.length !== ids.size) {
        throw new Problem(400, `Name every instruction of ${all[0]?.path ?? 'unassigned'} once, in the new order`)
      }
      for (const [position, p] of picked.entries()) {
        if (p.position === position) continue
        const [next] = await ctx.tx
          .update(instruction)
          .set({ position, revision: p.revision + 1, updatedAt: new Date() })
          .where(eq(instruction.id, p.id))
          .returning()
        if (next) await revise(ctx, next)
      }
      return views(ctx, await rows(ctx, inHome(home)), false)
    },
  }),
  defineOperation({
    id: 'instructions.remove',
    summary: 'Remove an instruction',
    description: `Its revisions stay in history, the last marked deleted. To stop it loading but keep it, switch it off with instructions_update instead. ${OPERATOR}`,
    input: { name, global: inputs.global },
    http: { method: 'DELETE', path: '/instructions' },
    mcp: { name: 'instructions_remove', destructive: true },
    async run({ name: file, global }, ctx) {
      const row = await byName(ctx, file)
      ctx.confirmGlobal(row.home, global)
      await ctx.history.record(ref(row.id), row.home, null)
      await ctx.tx.delete(instruction).where(eq(instruction.id, row.id))
      return { name: file, removed: true }
    },
  }),
]
