import {
  actorName,
  defineOperation,
  homePath,
  inputs,
  type Link,
  likePattern,
  type OperationContext,
  Problem,
  type Tx,
} from '@hubd/sdk'
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, or, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TodosConfig } from './config.ts'
import { label, PRIORITIES, STATUSES, todo, todoLabel } from './schema.ts'

const KIND = 'todos.todo'
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/
const PRIORITY_NAMES: Record<string, (typeof PRIORITIES)[number]> = {
  urgent: 'p1',
  high: 'p2',
  normal: 'p3',
  someday: 'p4',
}
const COLORS = ['blue', 'green', 'amber', 'red', 'violet', 'teal', 'pink', 'gray']

const status = z.enum(STATUSES)
const priority = z
  .preprocess(
    (v) => (typeof v === 'string' ? (PRIORITY_NAMES[v.trim().toLowerCase()] ?? v.trim().toLowerCase()) : v),
    z.enum(PRIORITIES),
  )
  .describe('urgent, high, normal or someday (or p1 to p4)')
const due = z.iso.date().describe('yyyy-mm-dd')
const labelName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .transform((n) => n.replace(/^#/, '').toLowerCase())
const about = inputs.subjectRefs.describe('topics and assets this todo is about')
const refs = inputs.ids.describe('ids of other todos this one refers to')
const id = z.uuid().describe('the todo id')

const fields = {
  title: z.string().trim().min(1).max(300).describe('worded as a prompt, e.g. "Add retries to the upload job"'),
  body: z.string().max(20_000).describe('Markdown; hubd:asset/<name> and hubd:topic/<name> become links'),
  labels: z.array(labelName).max(20).describe('replaces the whole list; each must exist (labels_list)'),
  status,
  priority,
  due,
  about,
  refs,
}

type Ctx = Pick<OperationContext, 'tx' | 'visible' | 'links' | 'attachments'>

async function view(ctx: Ctx, where: SQL | undefined, options: { limit?: number; order?: SQL[] } = {}) {
  const rows = await ctx.tx
    .select({
      id: todo.id,
      home: homePath(todo.home),
      title: todo.title,
      body: todo.body,
      status: todo.status,
      priority: todo.priority,
      due: todo.due,
      session: todo.session,
      done: sql<boolean>`${todo.doneAt} is not null`,
      doneAt: todo.doneAt,
      version: todo.version,
      createdBy: todo.createdBy,
      createdAt: todo.createdAt,
      updatedAt: todo.updatedAt,
    })
    .from(todo)
    .where(and(ctx.visible(todo.home), where))
    .orderBy(...(options.order ?? [asc(todo.createdAt)]))
    .limit(options.limit ?? 500)
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const refsOf = ids.map((i) => ({ kind: KIND, id: i }))
  const [tags, links, attachments, texts] = await Promise.all([
    ctx.tx.select().from(todoLabel).where(inArray(todoLabel.todoId, ids)),
    ctx.links.listMany(refsOf),
    ctx.attachments.listMany(refsOf),
    ctx.links.render(rows.flatMap((r) => [r.title, r.body])),
  ])
  const labelsOf = Map.groupBy(tags, (t) => t.todoId)
  return rows.map((r, i) => ({
    ...r,
    title: texts[2 * i] ?? r.title,
    body: texts[2 * i + 1] ?? r.body,
    labels: (labelsOf.get(r.id) ?? []).map((t) => t.label),
    links: links.get(r.id) ?? [],
    attachments: attachments.get(r.id) ?? [],
  }))
}

async function one(ctx: Ctx, todoId: string) {
  const [found] = await view(ctx, eq(todo.id, todoId))
  if (!found) throw new Problem(404, `No todo ${todoId}`)
  return found
}

async function find(ctx: Pick<Ctx, 'tx' | 'visible'>, todoId: string) {
  const [found] = await ctx.tx
    .select({ version: todo.version, title: todo.title, body: todo.body, doneAt: todo.doneAt, home: todo.home })
    .from(todo)
    .where(and(eq(todo.id, todoId), ctx.visible(todo.home)))
  if (!found) throw new Problem(404, `No todo ${todoId}`)
  return found
}

async function setLabels(tx: Tx, todoId: string, names: string[]) {
  const wanted = [...new Set(names)]
  if (wanted.length) {
    const known = await tx.select({ name: label.name }).from(label).where(inArray(label.name, wanted))
    const missing = wanted.filter((n) => !known.some((k) => k.name === n))
    if (missing.length) throw new Problem(400, `No label ${missing.join(', ')}; see labels_list`)
  }
  await tx.delete(todoLabel).where(eq(todoLabel.todoId, todoId))
  if (wanted.length) await tx.insert(todoLabel).values(wanted.map((l) => ({ todoId, label: l })))
}

const kept = (links: Link[]) => ({
  about: links.flatMap((l) =>
    l.kind === 'about' && 'subject' in l.to
      ? [{ kind: l.to.subject.kind, name: l.to.subject.id, ...(l.path ? { path: l.path } : {}) }]
      : [],
  ),
  refs: links.flatMap((l) => (l.kind === 'ref' && 'record' in l.to ? [l.to.record.id] : [])),
})

async function relink(
  ctx: Ctx,
  todoId: string,
  text: { title: string; body: string },
  given: { about?: z.infer<typeof about>; refs?: string[] },
) {
  const from = { kind: KIND, id: todoId }
  const current = given.about && given.refs ? { about: [], refs: [] } : kept(await ctx.links.list(from))
  const { lint, texts } = await ctx.links.set(from, {
    texts: [text.title, text.body],
    about: given.about ?? current.about,
    refs: (given.refs ?? current.refs).map((r) => ({ kind: KIND, id: r })),
  })
  const [title = text.title, body = text.body] = texts
  await ctx.tx.update(todo).set({ title, body }).where(eq(todo.id, todoId))
  return { lint }
}

const publish = (ctx: Pick<OperationContext, 'events'>, name: string, row: { id: string; home: string | null }) =>
  ctx.events.publish(name, { id: row.id, home: row.home })

const bump = () => ({ updatedAt: new Date(), version: sql`${todo.version} + 1` })

const changed = { id: todo.id, home: todo.home }

function decode(data: string, max: number, type?: string) {
  const m = data.match(/^data:([^;,]*)(?:;[^,]*)?;base64,/)
  const raw = (m ? data.slice(m[0].length) : data).replace(/\s+/g, '')
  if (raw.length > Math.ceil(max / 3) * 4) {
    throw new Problem(413, `todo_attach takes at most ${max / 1048576} MiB as data; omit data to get an upload link`)
  }
  if (!raw || raw.length % 4 === 1 || !BASE64.test(raw)) throw new Problem(400, 'data is not base64')
  return { bytes: new Uint8Array(Buffer.from(raw, 'base64')), type: type ?? m?.[1] }
}

export const todoOperations = (config: TodosConfig) => [
  defineOperation({
    id: 'list',
    summary: 'List todos',
    description:
      'Open todos this session can see, most urgent first. Filter by home (a space path; a scope includes its projects), label, status, or text in title and body.',
    input: {
      home: inputs.spacePath.optional(),
      label: labelName.optional(),
      status: status.optional(),
      q: z.string().trim().max(200).optional(),
      includeDone: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    },
    http: { method: 'GET', path: '/items' },
    mcp: { name: 'todo_list', readOnly: true },
    run: (a, ctx) =>
      view(
        ctx,
        and(
          a.includeDone ? undefined : isNull(todo.doneAt),
          a.home
            ? sql`${todo.home} in (select s.id from hubd.space s left join hubd.space p on p.id = s.parent where s.name = ${a.home} and s.parent is null or p.name || '/' || s.name = ${a.home} or (p.name = ${a.home} and p.parent is null))`
            : undefined,
          a.status ? eq(todo.status, a.status) : undefined,
          a.label
            ? sql`exists (select 1 from ${todoLabel} where ${todoLabel.todoId} = ${todo.id} and ${todoLabel.label} = ${a.label})`
            : undefined,
          a.q ? or(ilike(todo.title, likePattern(a.q)), ilike(todo.body, likePattern(a.q))) : undefined,
        ),
        {
          limit: a.limit,
          order: [
            asc(sql`${todo.doneAt} is not null`),
            asc(todo.priority),
            sql`${todo.due} asc nulls last`,
            asc(todo.createdAt),
          ],
        },
      ),
  }),
  defineOperation({
    id: 'get',
    summary: 'Get a todo',
    description: 'One todo by id, with its version (pass it to todo_update).',
    input: { id },
    http: { method: 'GET', path: '/items/:id' },
    mcp: { name: 'todo_get', readOnly: true },
    run: ({ id }, ctx) => one(ctx, id),
  }),
  defineOperation({
    id: 'add',
    summary: 'Add a todo',
    description:
      'Add a todo. Its home is the given space path; with none, an isolated session uses its scope and an open one leaves it unassigned. Labels must already exist (labels_list). The answer carries lint for hubd: references that could not be linked.',
    input: {
      ...fields,
      body: fields.body.default(''),
      labels: fields.labels.default([]),
      status: status.default('todo'),
      priority: priority.default('p3'),
      due: due.optional(),
      about: about.default([]),
      refs: refs.default([]),
      home: inputs.spacePath.optional().describe('space path; omit for the default home'),
      session: z
        .string()
        .max(100)
        .optional()
        .describe('the calling Claude Code session id; default the one hubridge stamps'),
    },
    http: { method: 'POST', path: '/items' },
    mcp: { name: 'todo_add' },
    async run({ labels, about, refs, home, ...a }, ctx) {
      const [row] = await ctx.tx
        .insert(todo)
        .values({
          ...a,
          session: a.session ?? ctx.origin.session,
          home: await ctx.homeFor(home),
          createdBy: actorName(ctx.actor),
        })
        .returning(changed)
      if (!row) throw new Error('todo was not stored')
      await setLabels(ctx.tx, row.id, labels)
      const { lint } = await relink(ctx, row.id, a, { about, refs })
      await publish(ctx, 'todo.added', row)
      return { ...(await one(ctx, row.id)), lint }
    },
  }),
  defineOperation({
    id: 'update',
    summary: 'Update a todo',
    description:
      'Change fields of a todo. Pass the version from todo_get or todo_list: if the todo changed since, the update is refused. labels, about and refs replace the whole list.',
    input: {
      id,
      version: z.number().int().optional(),
      title: fields.title.optional(),
      body: fields.body.optional(),
      labels: fields.labels.optional(),
      status: status.optional(),
      priority: priority.optional(),
      due: due.nullable().optional(),
      about: about.optional(),
      refs: refs.optional(),
      home: inputs.spacePath
        .nullable()
        .optional()
        .describe('move it to this space path; refused if a link would cross isolation'),
      global: inputs.global,
    },
    http: { method: 'PATCH', path: '/items/:id' },
    mcp: { name: 'todo_update' },
    async run({ id, version, labels, about, refs, home, global, ...patch }, ctx) {
      const current = await find(ctx, id)
      ctx.confirmGlobal(current.home, global)
      if (version !== undefined && version !== current.version) {
        throw new Problem(409, `Todo ${id} changed since version ${version}; it is at version ${current.version}`)
      }
      const moved = home === undefined ? {} : { home: await ctx.homeFor(home) }
      if (moved.home !== undefined) await ctx.moves.move({ kind: KIND, id }, moved.home)
      const [row] = await ctx.tx
        .update(todo)
        .set({ ...patch, ...moved, ...bump() })
        .where(eq(todo.id, id))
        .returning(changed)
      if (labels) await setLabels(ctx.tx, id, labels)
      const text = { title: patch.title ?? current.title, body: patch.body ?? current.body }
      const relinked = patch.title !== undefined || patch.body !== undefined || about || refs
      const { lint } = relinked ? await relink(ctx, id, text, { about, refs }) : { lint: [] }
      if (row) await publish(ctx, 'todo.updated', row)
      return { ...(await one(ctx, id)), lint }
    },
  }),
  defineOperation({
    id: 'done',
    summary: 'Mark a todo done',
    description: 'Mark a todo done; todo_undo restores it.',
    input: { id, global: inputs.global },
    http: { method: 'POST', path: '/items/:id/done' },
    mcp: { name: 'todo_done' },
    async run({ id, global }, ctx) {
      const current = await find(ctx, id)
      ctx.confirmGlobal(current.home, global)
      if (!current.doneAt) {
        const [row] = await ctx.tx
          .update(todo)
          .set({ doneAt: new Date(), ...bump() })
          .where(eq(todo.id, id))
          .returning(changed)
        if (row) await publish(ctx, 'todo.done', row)
      }
      return one(ctx, id)
    },
  }),
  defineOperation({
    id: 'undo',
    summary: 'Undo done',
    description: 'Restore a done todo; without id, the most recently done one this session can see.',
    input: { id: id.optional(), global: inputs.global },
    http: { method: 'POST', path: '/items/undo' },
    mcp: { name: 'todo_undo' },
    async run({ id, global }, ctx) {
      const [latest] = id
        ? [{ id }]
        : await ctx.tx
            .select({ id: todo.id })
            .from(todo)
            .where(and(isNotNull(todo.doneAt), ctx.visible(todo.home)))
            .orderBy(desc(todo.doneAt))
            .limit(1)
      if (!latest) throw new Problem(404, 'Nothing to undo')
      const current = await find(ctx, latest.id)
      if (!current.doneAt) throw new Problem(400, `Todo ${latest.id} is not done`)
      ctx.confirmGlobal(current.home, global)
      const [row] = await ctx.tx
        .update(todo)
        .set({ doneAt: null, ...bump() })
        .where(eq(todo.id, latest.id))
        .returning(changed)
      if (row) await publish(ctx, 'todo.undone', row)
      return one(ctx, latest.id)
    },
  }),
  defineOperation({
    id: 'attach',
    summary: 'Attach a file to a todo',
    description: `Attach a file while working: a screenshot, a log. Pass data as base64 (a data: URL works too) for files up to ${config.mcpMaxBytes / 1048576} MiB. For a larger file omit data: the answer is a single-use upload link and the curl command that sends the file.`,
    input: {
      id,
      name: z.string().min(1).max(200).describe('the file name, e.g. build.log or shot.png'),
      data: z.string().optional(),
      type: z.string().max(100).optional().describe('the MIME type, if known'),
      global: inputs.global,
    },
    http: { method: 'POST', path: '/items/:id/attachments' },
    mcp: { name: 'todo_attach' },
    async run(a, ctx) {
      ctx.confirmGlobal((await find(ctx, a.id)).home, a.global)
      const from = { kind: KIND, id: a.id }
      if (!a.data) return { upload: await ctx.attachments.uploadUrl(from, a.name) }
      const { bytes, type } = decode(a.data, config.mcpMaxBytes, a.type)
      await ctx.attachments.add(from, { name: a.name, bytes, type }, { maxBytes: config.mcpMaxBytes })
      await ctx.tx.update(todo).set(bump()).where(eq(todo.id, a.id))
      return one(ctx, a.id)
    },
  }),
]

const color = inputs.color

export const labelOperations = [
  defineOperation({
    id: 'labels.list',
    summary: 'List labels',
    description:
      'Every label (the state of work), with how many open todos this session can see carry it. Use only these.',
    input: {},
    http: { method: 'GET', path: '/labels' },
    mcp: { name: 'labels_list', readOnly: true },
    run: (_, { tx, visible }) =>
      tx
        .select({
          name: label.name,
          color: label.color,
          open: sql<number>`(select count(*)::int from ${todoLabel} join ${todo} on ${todo.id} = ${todoLabel.todoId} where ${todoLabel.label} = ${label.name} and ${todo.doneAt} is null and ${visible(todo.home)})`,
        })
        .from(label)
        .orderBy(asc(label.name)),
  }),
  defineOperation({
    id: 'labels.add',
    summary: 'Add a label',
    description:
      'A label names a state of work (blocked, waiting-on-review), never its content; every session sees it.',
    input: { name: labelName, color: color.optional() },
    http: { method: 'POST', path: '/labels' },
    mcp: { name: 'labels_add' },
    async run({ name, color }, { tx }) {
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(*)::int` }).from(label)
      const [row] = await tx
        .insert(label)
        .values({ name, color: color ?? (COLORS[n % COLORS.length] as string) })
        .onConflictDoNothing()
        .returning()
      if (!row) throw new Problem(409, `A label "${name}" exists`)
      return row
    },
  }),
  defineOperation({
    id: 'labels.update',
    summary: 'Rename or recolour a label',
    input: { name: labelName, rename: labelName.optional(), color: color.optional() },
    http: { method: 'PATCH', path: '/labels/:name' },
    mcp: { name: 'labels_update' },
    async run({ name, rename, color }, { tx }) {
      if (!rename && !color) throw new Problem(400, 'Give rename or color')
      const [row] = await tx
        .update(label)
        .set({ ...(rename ? { name: rename } : {}), ...(color ? { color } : {}) })
        .where(eq(label.name, name))
        .returning()
      if (!row) throw new Problem(404, `No label "${name}"`)
      return row
    },
  }),
  defineOperation({
    id: 'labels.remove',
    summary: 'Remove a label from every todo and delete it',
    input: { name: labelName },
    http: { method: 'DELETE', path: '/labels/:name' },
    mcp: { name: 'labels_remove', destructive: true },
    async run({ name }, { tx }) {
      const [row] = await tx.delete(label).where(eq(label.name, name)).returning()
      if (!row) throw new Problem(404, `No label "${name}"`)
      return row
    },
  }),
]
