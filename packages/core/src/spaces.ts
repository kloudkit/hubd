import { defineOperation, GLOBAL_SPACE, type History, inputs, Problem, type Scope, type Tx } from '@hubd/sdk'
import { and, asc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { SPACE } from './history.ts'
import { liveNames, nameConflicts, setDomain } from './names.ts'
import type { Records } from './records.ts'
import { space, subject } from './schema.ts'
import {
  assertInside,
  type Eyes,
  findPlace,
  type Place,
  Places,
  parent,
  placeColumns,
  toPlace,
  visibleTo,
} from './visibility.ts'
import { crossing, edges, FROM_HOME, refuse, TO_HOME } from './world.ts'

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

const path = inputs.spacePath
const description = z.string().trim().max(500).describe('what belongs here, one or two sentences')
const color = inputs.color

async function rows(tx: Tx, where: SQL | undefined) {
  const found = await tx
    .select({
      ...placeColumns,
      description: space.description,
      color: space.color,
      archivedAt: space.archivedAt,
      createdAt: space.createdAt,
    })
    .from(space)
    .leftJoin(parent, eq(parent.id, space.parent))
    .where(where)
    .orderBy(asc(sql`coalesce(${parent.name}, ${space.name})`), asc(space.parent), asc(space.name))
  return found.map((r) => {
    const { path, kind, name, isolated } = toPlace(r)
    return {
      path,
      kind,
      name,
      description: r.description,
      color: r.color,
      isolated,
      archivedAt: r.archivedAt,
      createdAt: r.createdAt,
    }
  })
}

const list = (tx: Tx, eyes: Eyes, where?: SQL) => rows(tx, and(visibleTo(eyes, space.id), where))

async function show(tx: Tx, id: string) {
  const [row] = await rows(tx, eq(space.id, id))
  return row
}

async function revised(tx: Tx, history: History, id: string) {
  const [row] = await tx.select().from(space).where(eq(space.id, id))
  if (row) {
    const { id: _id, createdAt: _created, updatedAt: _updated, ...rest } = row
    await history.record({ kind: SPACE, id }, id, rest)
  }
  return show(tx, id)
}

function editable(place: Place, scope: Scope): void {
  if (place.id === GLOBAL_SPACE) throw new Problem(403, 'global is reserved and cannot be changed')
  assertInside(scope, place.scope, 'changes spaces')
}

async function moveSpaces(
  tx: Tx,
  records: Records,
  what: string,
  ids: string[],
  moved: { id: string; scope: string; isolated: boolean },
  domain: string | null,
): Promise<string[]> {
  const subjects = await tx.select({ id: subject.id }).from(subject).where(inArray(subject.home, ids))
  const movers = [...subjects.map((m) => m.id), ...(await records.homedIn(tx, ids))]
  const conflicts = await nameConflicts(tx, await liveNames(tx, movers), domain, false, 'on the other side')
  const linked = await edges(tx, records, or(inArray(FROM_HOME, ids), inArray(TO_HOME, ids)) as SQL)
  conflicts.push(...(await crossing(new Places(tx, moved), linked)))
  refuse(what, conflicts)
  return movers
}

export const spaceOperations = (records: Records) => [
  defineOperation({
    id: 'spaces.list',
    summary: 'List the spaces this session can see',
    description: 'Scopes and their projects, as paths. Archived projects are left out unless asked for.',
    input: { archived: z.coerce.boolean().default(false).describe('include archived projects') },
    http: { method: 'GET', path: '/spaces' },
    mcp: { name: 'spaces_list', readOnly: true },
    run: ({ archived }, { tx, scope }) => list(tx, scope, archived ? undefined : isNull(space.archivedAt)),
  }),
  defineOperation({
    id: 'spaces.get',
    summary: 'Get one space by its path, with its revisions',
    input: { path },
    http: { method: 'GET', path: '/spaces/get' },
    mcp: { name: 'spaces_get', readOnly: true },
    async run({ path }, { tx, scope, history }) {
      const place = await findPlace(tx, scope, path)
      return { ...(await show(tx, place.id)), revisions: await history.revisions({ kind: SPACE, id: place.id }) }
    },
  }),
  defineOperation({
    id: 'spaces.create',
    summary: 'Create a scope, or a project inside a scope',
    description:
      'A path with one part makes a scope; scope/project makes a project. Only an open session makes scopes. Act only as the operator directs.',
    input: {
      path,
      description: description.optional(),
      color: color.optional(),
      isolated: z.boolean().default(false).describe('scopes only: hide it from every session not isolated to it'),
    },
    http: { method: 'POST', path: '/spaces' },
    mcp: { name: 'spaces_create' },
    async run({ path, description, color, isolated }, { tx, scope, history }) {
      const parts = path.split('/')
      const name = parts.at(-1) ?? ''
      if (parts.length > 2 || !NAME.test(name)) {
        throw new Problem(
          400,
          'A space name is 1 to 40 lowercase letters, digits or dashes; a path is scope or scope/project',
        )
      }
      let parentId: string | null = null
      if (parts.length === 2) {
        const owner = await findPlace(tx, scope, parts[0] ?? '')
        if (owner.kind !== 'scope') throw new Problem(400, 'A project sits inside a scope')
        if (isolated) throw new Problem(400, 'Only a scope can be isolated')
        editable(owner, scope)
        parentId = owner.id
      } else if (scope.mode === 'isolated') {
        throw new Problem(403, 'An isolated session cannot make scopes')
      }
      if (name === 'global') throw new Problem(409, 'global is reserved')
      const [row] = await tx
        .insert(space)
        .values({ kind: parentId ? 'project' : 'scope', name, parent: parentId, description, color, isolated })
        .onConflictDoNothing()
        .returning({ id: space.id })
      if (!row) throw new Problem(409, `A space "${path}" exists`)
      return revised(tx, history, row.id)
    },
  }),
  defineOperation({
    id: 'spaces.update',
    summary: "Change a space's description or colour",
    input: { path, description: description.nullable().optional(), color: color.nullable().optional() },
    http: { method: 'PATCH', path: '/spaces' },
    mcp: { name: 'spaces_update' },
    async run({ path, ...patch }, { tx, scope, history }) {
      const place = await findPlace(tx, scope, path)
      editable(place, scope)
      if (patch.description === undefined && patch.color === undefined) return show(tx, place.id)
      await tx.update(space).set(patch).where(eq(space.id, place.id))
      return revised(tx, history, place.id)
    },
  }),
  defineOperation({
    id: 'spaces.isolate',
    summary: 'Make a scope isolated, or open it again',
    description:
      'Refused, with every conflict listed (up to 50), when a name would collide or a link would cross the new boundary. Act only as the operator directs.',
    input: { path, isolated: z.boolean() },
    http: { method: 'POST', path: '/spaces/isolate' },
    mcp: { name: 'spaces_isolate', destructive: true },
    async run({ path, isolated }, { tx, scope, history }) {
      const place = await findPlace(tx, scope, path)
      editable(place, scope)
      if (place.kind !== 'scope') throw new Problem(400, 'Only a scope can be isolated')
      if (place.isolated === isolated) throw new Problem(400, `${path} is already ${isolated ? 'isolated' : 'open'}`)
      const ids = (
        await tx
          .select({ id: space.id })
          .from(space)
          .where(or(eq(space.id, place.id), eq(space.parent, place.id)))
      ).map((r) => r.id)
      const domain = isolated ? place.id : null
      const what = `${isolated ? 'Isolating' : 'Opening'} ${path}`
      const movers = await moveSpaces(tx, records, what, ids, { id: place.id, scope: place.id, isolated }, domain)
      await tx.update(space).set({ isolated }).where(eq(space.id, place.id))
      await setDomain(tx, movers, domain, false)
      return revised(tx, history, place.id)
    },
  }),
  defineOperation({
    id: 'spaces.move',
    summary: 'Move a project to another scope',
    description:
      'Refused, with every conflict listed (up to 50), when a name would collide or a link would cross isolation. Act only as the operator directs.',
    input: { path, to: z.string().min(1).max(40).describe('the scope it moves into') },
    http: { method: 'POST', path: '/spaces/move' },
    mcp: { name: 'spaces_move' },
    async run({ path, to }, { tx, scope, history }) {
      const place = await findPlace(tx, scope, path)
      const target = await findPlace(tx, scope, to)
      editable(place, scope)
      editable(target, scope)
      if (place.kind !== 'project') throw new Problem(400, 'Only a project moves between scopes')
      if (target.kind !== 'scope') throw new Problem(400, 'A project moves into a scope')
      if (target.id === place.scope) throw new Problem(400, `${path} is already in ${to}`)
      const domain = target.isolated ? target.id : null
      const moved = { id: place.id, scope: target.id, isolated: target.isolated }
      const movers = await moveSpaces(tx, records, `Moving ${path} to ${to}`, [place.id], moved, domain)
      const [clash] = await tx
        .select({ id: space.id })
        .from(space)
        .where(and(eq(space.parent, target.id), eq(space.name, place.name)))
      if (clash) throw new Problem(409, `${to} already has a project named ${place.name}`)
      await tx.update(space).set({ parent: target.id }).where(eq(space.id, place.id))
      await setDomain(tx, movers, domain, false)
      return revised(tx, history, place.id)
    },
  }),
  ...(['archive', 'restore'] as const).map((action) =>
    defineOperation({
      id: `spaces.${action}`,
      summary: action === 'archive' ? 'Archive a project' : 'Restore an archived project',
      description:
        action === 'archive'
          ? 'Its records stay readable but leave default listings. Act only as the operator directs.'
          : 'Brings an archived project back into default listings.',
      input: { path },
      http: { method: 'POST', path: `/spaces/${action}` },
      mcp: { name: `spaces_${action}` },
      async run({ path }, { tx, scope, history }) {
        const place = await findPlace(tx, scope, path)
        editable(place, scope)
        if (place.kind !== 'project') throw new Problem(400, 'Only a project can be archived')
        await tx
          .update(space)
          .set({ archivedAt: action === 'archive' ? new Date() : null })
          .where(eq(space.id, place.id))
        return revised(tx, history, place.id)
      },
    }),
  ),
]
