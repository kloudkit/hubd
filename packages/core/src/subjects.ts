import {
  type Actor,
  actorId,
  defineOperation,
  type Events,
  GLOBAL_SPACE,
  homePath,
  inputs,
  likePattern,
  Problem,
  type Scope,
  type SubjectInput,
  type SubjectKind,
  type SubjectPatch,
  type Subjects,
  type SubjectView,
  type Tx,
} from '@hubd/sdk'
import { and, asc, eq, ilike, inArray, isNull, sql } from 'drizzle-orm'
import { z } from 'zod'
import { type History, rehome, SUBJECT } from './history.ts'
import {
  checkName,
  claimName,
  endAll,
  endName,
  history,
  live,
  liveNames,
  nameConflicts,
  sameName,
  setDomain,
} from './names.ts'
import type { Records } from './records.ts'
import { names, subject } from './schema.ts'
import { assertInside, confirmGlobal, type Eyes, findPlace, homeForWrite, Places, visibleTo } from './visibility.ts'
import { crossing, edges, refuse } from './world.ts'

export type NewSubject = {
  kind: SubjectKind
  name: string
  home: string | null
  summary?: string
  type?: string
  endpoint?: string
  reachedBy?: string
  createdBy: string | null
}

export async function resolveSubject(tx: Tx, eyes: Eyes, kind: SubjectKind, name: string) {
  const [row] = await tx
    .select({ id: subject.id, kind: subject.kind, name: subject.name, home: subject.home })
    .from(names)
    .innerJoin(subject, eq(subject.id, names.subjectId))
    .where(and(eq(names.kind, kind), sameName(name), live, visibleTo(eyes, subject.home)))
  return row ?? null
}

async function mustResolve(tx: Tx, eyes: Eyes, kind: SubjectKind, name: string) {
  const found = await resolveSubject(tx, eyes, kind, name)
  if (!found) throw new Problem(404, `No ${kind} "${name}"`)
  return found
}

export async function reviseSubject(tx: Tx, history: History, id: string): Promise<void> {
  const [row] = await tx.select().from(subject).where(eq(subject.id, id))
  if (!row) return
  const { id: _id, createdAt: _created, updatedAt: _updated, createdBy: _by, ...rest } = row
  const aliases = (await liveNames(tx, [id])).map((n) => n.name).filter((n) => n !== row.name)
  await history.record({ kind: SUBJECT, id }, row.home, { ...rest, aliases: aliases.sort() })
}

export async function createSubject(tx: Tx, input: NewSubject): Promise<{ id: string; name: string }> {
  checkName(input.name)
  const [row] = await tx.insert(subject).values(input).returning({ id: subject.id })
  if (!row) throw new Error('subject was not stored')
  await claimName(tx, new Places(tx), input.kind, { subject: row.id }, input.name, input.home)
  return { id: row.id, name: input.name }
}

const columns = {
  id: subject.id,
  kind: subject.kind,
  name: subject.name,
  home: homePath(subject.home),
  summary: subject.summary,
  type: subject.type,
  endpoint: subject.endpoint,
  reachedBy: subject.reachedBy,
  createdAt: subject.createdAt,
  retiredAt: subject.retiredAt,
}

async function view(tx: Tx, id: string): Promise<SubjectView> {
  const [row] = await tx.select(columns).from(subject).where(eq(subject.id, id))
  if (!row) throw new Problem(404, 'No such subject')
  return row
}

function assetOnly(k: SubjectKind, fields: Record<string, unknown>): void {
  if (k === 'topic' && Object.values(fields).some((v) => v !== undefined && v !== null)) {
    throw new Problem(400, 'type, endpoint and reachedBy are for assets only')
  }
}

export class SubjectService implements Subjects {
  readonly #tx: Tx
  readonly #scope: Scope
  readonly #actor: Actor
  readonly #events: Events
  readonly #records: Records
  readonly #history: History

  constructor(tx: Tx, scope: Scope, actor: Actor, events: Events, records: Records, history: History) {
    this.#tx = tx
    this.#scope = scope
    this.#actor = actor
    this.#events = events
    this.#records = records
    this.#history = history
  }

  async #done(id: string): Promise<SubjectView> {
    await reviseSubject(this.#tx, this.#history, id)
    return view(this.#tx, id)
  }

  async find(kind: SubjectKind, name: string) {
    const found = await resolveSubject(this.#tx, this.#scope, kind, name)
    return found ? { id: found.id, home: found.home } : null
  }

  async legend(ids: string[]) {
    if (!ids.length) return []
    return this.#tx
      .select({ name: subject.name, type: subject.type, endpoint: subject.endpoint, reachedBy: subject.reachedBy })
      .from(subject)
      .where(
        and(inArray(subject.id, [...new Set(ids)]), eq(subject.kind, 'asset'), visibleTo(this.#scope, subject.home)),
      )
      .orderBy(asc(subject.name))
  }

  async #writable(kind: SubjectKind, name: string, confirmed: boolean) {
    const found = await mustResolve(this.#tx, this.#scope, kind, name)
    if (found.home === GLOBAL_SPACE) confirmGlobal(this.#scope, found.home, confirmed, kind)
    else if (this.#scope.mode === 'isolated') {
      const where = found.home ? (await new Places(this.#tx).get(found.home)).scope : GLOBAL_SPACE
      assertInside(this.#scope, where, 'changes subjects')
    }
    return found
  }

  async create(input: SubjectInput) {
    const { kind, name, home, ...rest } = input
    assetOnly(kind, { type: rest.type, endpoint: rest.endpoint, reachedBy: rest.reachedBy })
    if (kind === 'asset' && !rest.type) throw new Problem(400, 'An asset needs a type')
    const homeId = await homeForWrite(this.#tx, this.#scope, home)
    const made = await createSubject(this.#tx, { kind, name, home: homeId, ...rest, createdBy: actorId(this.#actor) })
    return this.#done(made.id)
  }

  async update(kind: SubjectKind, name: string, patch: SubjectPatch, confirmed = false) {
    const { home, ...fields } = patch
    assetOnly(kind, { type: fields.type, endpoint: fields.endpoint, reachedBy: fields.reachedBy })
    const found = await this.#writable(kind, name, confirmed)
    if (Object.values(fields).some((v) => v !== undefined)) {
      await this.#tx.update(subject).set(fields).where(eq(subject.id, found.id))
    }
    if (home !== undefined) {
      const target = await homeForWrite(this.#tx, this.#scope, home)
      if (target !== found.home) await this.#move(found, target)
    }
    return this.#done(found.id)
  }

  async #move(found: { id: string; kind: SubjectKind; name: string }, home: string | null) {
    const places = new Places(this.#tx)
    const domain = await places.domain(home)
    const global = home === GLOBAL_SPACE
    const own = await liveNames(this.#tx, [found.id])
    const conflicts = await nameConflicts(this.#tx, own, domain, global, 'where it would move')
    const linked = await edges(this.#tx, this.#records, sql`l.to_subject = ${found.id}::uuid`)
    conflicts.push(
      ...(await crossing(
        places,
        linked.map((e) => ({ ...e, toHome: home })),
      )),
    )
    refuse(`Moving ${found.kind} ${found.name}`, conflicts)
    await this.#tx.update(subject).set({ home }).where(eq(subject.id, found.id))
    await setDomain(this.#tx, [found.id], domain, global)
    await rehome(this.#tx, { kind: SUBJECT, id: found.id }, home)
  }

  async rename(kind: SubjectKind, name: string, to: string, confirmed = false) {
    const found = await this.#writable(kind, name, confirmed)
    await claimName(this.#tx, new Places(this.#tx), kind, { subject: found.id }, to, found.home)
    await endName(this.#tx, { subject: found.id }, found.name, to)
    await this.#tx.update(subject).set({ name: to }).where(eq(subject.id, found.id))
    return this.#done(found.id)
  }

  async alias(kind: SubjectKind, name: string, alias: string, remove = false, confirmed = false) {
    const found = await this.#writable(kind, name, confirmed)
    if (!remove) await claimName(this.#tx, new Places(this.#tx), kind, { subject: found.id }, alias, found.home)
    else {
      if (alias.toLowerCase() === found.name.toLowerCase())
        throw new Problem(400, 'That is its name; rename it instead')
      if (!(await endName(this.#tx, { subject: found.id }, alias))) {
        throw new Problem(404, `"${alias}" is not one of its names`)
      }
    }
    return this.#done(found.id)
  }

  async merge(kind: SubjectKind, from: string, into: string, confirmed = false) {
    const tx = this.#tx
    const loser = await this.#writable(kind, from, confirmed)
    const winner = await this.#writable(kind, into, confirmed)
    if (loser.id === winner.id) throw new Problem(400, `"${from}" and "${into}" are already one ${kind}`)
    const places = new Places(tx)
    if ((await places.domain(loser.home)) !== (await places.domain(winner.home))) {
      throw new Problem(400, 'Only subjects in the same name domain merge')
    }
    const linked = await edges(tx, this.#records, sql`l.to_subject = ${loser.id}::uuid`)
    refuse(
      `Merging into ${kind} ${into}`,
      await crossing(
        places,
        linked.map((e) => ({ ...e, toHome: winner.home })),
      ),
    )
    await tx.execute(sql`update hubd.link l set to_subject = ${winner.id}::uuid where l.to_subject = ${loser.id}::uuid
      and not exists (select 1 from hubd.link o where o.from_kind = l.from_kind and o.from_id = l.from_id
        and o.kind = l.kind and o.to_subject = ${winner.id}::uuid and o.path is not distinct from l.path)`)
    await tx.execute(sql`delete from hubd.link where to_subject = ${loser.id}::uuid`)
    await tx
      .update(names)
      .set({ subjectId: winner.id })
      .where(and(eq(names.subjectId, loser.id), live))
    await tx.update(subject).set({ mergedInto: winner.id }).where(eq(subject.mergedInto, loser.id))
    await tx.update(subject).set({ retiredAt: new Date(), mergedInto: winner.id }).where(eq(subject.id, loser.id))
    await this.#events.publish('subject.merged', { id: loser.id, home: loser.home, to: winner.id })
    await reviseSubject(tx, this.#history, loser.id)
    return this.#done(winner.id)
  }

  async retire(kind: SubjectKind, name: string, confirmed = false) {
    const found = await this.#writable(kind, name, confirmed)
    await this.#tx.update(subject).set({ retiredAt: new Date() }).where(eq(subject.id, found.id))
    await endAll(this.#tx, { subject: found.id })
    return this.#done(found.id)
  }
}

const kind = z.enum(['topic', 'asset']).describe('topic: anything records are about; asset: one particular thing')
const name = z
  .string()
  .regex(/^[A-Za-z0-9][\w.-]{0,79}$/)
  .describe('the name hubd: references use')
const summary = z.string().trim().max(120).describe('one line saying what it is, never facts that change')
const assetFields = {
  type: z.string().trim().min(1).max(40).describe('asset only: machine, cluster, store, app, repo, ...'),
  endpoint: z.string().trim().max(300).describe('asset only: where it is'),
  reachedBy: z.string().trim().max(300).describe('asset only: how it is reached'),
}

export const subjectOperations = [
  defineOperation({
    id: 'subjects.list',
    summary: 'List or search the topics and assets this session can see',
    input: {
      kind: kind.optional(),
      q: z.string().trim().max(80).optional().describe('part of a name'),
      home: inputs.spacePath.optional().describe('only subjects homed in this space path'),
      retired: z.coerce.boolean().default(false).describe('include retired subjects'),
      limit: z.coerce.number().int().min(1).max(500).default(100),
    },
    http: { method: 'GET', path: '/subjects' },
    mcp: { name: 'subjects_list', readOnly: true },
    async run({ kind, q, home, retired, limit }, { tx, scope }) {
      const homeId = home ? (await findPlace(tx, scope, home)).id : undefined
      return tx
        .select(columns)
        .from(subject)
        .where(
          and(
            visibleTo(scope, subject.home),
            kind ? eq(subject.kind, kind) : undefined,
            homeId ? eq(subject.home, homeId) : undefined,
            retired ? undefined : isNull(subject.retiredAt),
            q
              ? sql`exists (select 1 from ${names} where ${names.subjectId} = ${subject.id} and ${ilike(names.name, likePattern(q))})`
              : undefined,
          ),
        )
        .orderBy(asc(subject.kind), asc(sql`lower(${subject.name})`))
        .limit(limit)
    },
  }),
  defineOperation({
    id: 'subjects.get',
    summary: 'Get one topic or asset by name, with its name history and revisions',
    input: { kind, name },
    http: { method: 'GET', path: '/subjects/get' },
    mcp: { name: 'subjects_get', readOnly: true },
    async run({ kind, name }, { tx, scope, history: revisions }) {
      const found = await mustResolve(tx, scope, kind, name)
      return {
        ...(await view(tx, found.id)),
        names: await history(tx, { subject: found.id }),
        revisions: await revisions.revisions({ kind: SUBJECT, id: found.id }),
      }
    },
  }),
  defineOperation({
    id: 'subjects.create',
    summary: 'Create a topic or an asset',
    description:
      'Its home is the given space path; with none, an isolated session uses its scope and an open one leaves it unassigned. Names are unique per kind within a name domain.',
    input: {
      kind,
      name,
      home: inputs.spacePath.optional().describe('space path; omit for the default home'),
      summary: summary.optional(),
      type: assetFields.type.optional(),
      endpoint: assetFields.endpoint.optional(),
      reachedBy: assetFields.reachedBy.optional(),
    },
    http: { method: 'POST', path: '/subjects' },
    mcp: { name: 'subjects_create' },
    run: (input, { subjects }) => subjects.create(input),
  }),
  defineOperation({
    id: 'subjects.update',
    summary: "Change a topic's or asset's summary or asset fields",
    description:
      'Moving it (home) is refused, with every conflict listed, when its names are taken there or a record linking to it could no longer see it. home "global" makes it global.',
    input: {
      kind,
      name,
      home: inputs.spacePath.nullable().optional().describe('move to this space path; null leaves it unassigned'),
      summary: summary.nullable().optional(),
      type: assetFields.type.optional(),
      endpoint: assetFields.endpoint.nullable().optional(),
      reachedBy: assetFields.reachedBy.nullable().optional(),
      global: inputs.global,
    },
    http: { method: 'PATCH', path: '/subjects' },
    mcp: { name: 'subjects_update' },
    run: ({ kind, name, global, ...patch }, { subjects }) => subjects.update(kind, name, patch, global),
  }),
  defineOperation({
    id: 'subjects.rename',
    summary: 'Rename a topic or asset',
    description:
      'Its old name is freed at once; text that named it keeps pointing at it, because hubd stores references by id.',
    input: { kind, name, to: name, global: inputs.global },
    http: { method: 'POST', path: '/subjects/rename' },
    mcp: { name: 'subjects_rename' },
    run: ({ kind, name, to, global }, { subjects }) => subjects.rename(kind, name, to, global),
  }),
  defineOperation({
    id: 'subjects.alias',
    summary: 'Add or remove another name for a topic or asset',
    input: { kind, name, alias: name, remove: z.boolean().default(false), global: inputs.global },
    http: { method: 'POST', path: '/subjects/alias' },
    mcp: { name: 'subjects_alias' },
    run: ({ kind, name, alias, remove, global }, { subjects }) => subjects.alias(kind, name, alias, remove, global),
  }),
  defineOperation({
    id: 'subjects.merge',
    summary: 'Merge one topic or asset into another',
    description:
      'Links and names move to the one kept; the other stays as a retired redirect, so its id still leads here. Both must share a name domain. Act only as the operator directs.',
    input: {
      kind,
      from: name.describe('the one that goes'),
      into: name.describe('the one kept'),
      global: inputs.global,
    },
    http: { method: 'POST', path: '/subjects/merge' },
    mcp: { name: 'subjects_merge', destructive: true },
    run: ({ kind, from, into, global }, { subjects }) => subjects.merge(kind, from, into, global),
  }),
  defineOperation({
    id: 'subjects.retire',
    summary: 'Retire a topic or asset',
    description:
      'Nothing is deleted: links keep pointing at it, and its names are freed for a new subject. Act only as the operator directs.',
    input: { kind, name, global: inputs.global },
    http: { method: 'POST', path: '/subjects/retire' },
    mcp: { name: 'subjects_retire', destructive: true },
    run: ({ kind, name, global }, { subjects }) => subjects.retire(kind, name, global),
  }),
]
