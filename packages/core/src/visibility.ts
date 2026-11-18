import { type Db, GLOBAL_SPACE, Problem, type Scope, type Tx } from '@hubd/sdk'
import { eq, inArray, type SQL, sql } from 'drizzle-orm'
import { type AnyPgColumn, alias } from 'drizzle-orm/pg-core'
import { space } from './schema.ts'

export type Eyes = { mode: 'open' } | { mode: 'global' } | { mode: 'isolated'; space: string }

type Home = AnyPgColumn | SQL

export function visibleTo(eyes: Eyes, home: Home): SQL {
  switch (eyes.mode) {
    case 'global':
      return sql`${home} = ${GLOBAL_SPACE}::uuid`
    case 'isolated':
      return sql`${home} in (select vs.id from hubd.space vs where vs.id = ${eyes.space}::uuid or vs.parent = ${eyes.space}::uuid or vs.id = ${GLOBAL_SPACE}::uuid)`
    case 'open':
      return sql`(${home} is null or ${home} in (select vs.id from hubd.space vs left join hubd.space vp on vp.id = vs.parent where not coalesce(vp.isolated, vs.isolated)))`
  }
}

export const parent = alias(space, 'parent_space')

export type Place = {
  id: string
  kind: 'scope' | 'project'
  name: string
  path: string
  scope: string
  isolated: boolean
}

type Where = Pick<Place, 'scope' | 'isolated'>

export const placeColumns = {
  id: space.id,
  kind: space.kind,
  name: space.name,
  parentName: parent.name,
  parent: space.parent,
  isolated: sql<boolean>`coalesce(${parent.isolated}, ${space.isolated})`,
}

export const toPlace = (r: {
  id: string
  kind: 'scope' | 'project'
  name: string
  parentName: string | null
  parent: string | null
  isolated: boolean
}): Place => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  path: r.parentName ? `${r.parentName}/${r.name}` : r.name,
  scope: r.parent ?? r.id,
  isolated: r.isolated,
})

const places = (db: Db | Tx, where: SQL) =>
  db.select(placeColumns).from(space).leftJoin(parent, eq(parent.id, space.parent)).where(where)

export async function findPlace(db: Db | Tx, eyes: Eyes, path: string): Promise<Place> {
  const [scopeName, projectName, ...rest] = path.split('/')
  if (!scopeName || rest.length) throw new Problem(400, `"${path}" is not a space path; write scope or scope/project`)
  const where = projectName
    ? sql`${parent.name} = ${scopeName} and ${space.name} = ${projectName}`
    : sql`${space.parent} is null and ${space.name} = ${scopeName}`
  const [row] = await places(db, sql`${where} and ${visibleTo(eyes, space.id)}`)
  if (!row) throw new Problem(404, `No space "${path}"`)
  return toPlace(row)
}

const domainOf = (eyes: Eyes): string | null => (eyes.mode === 'isolated' ? eyes.space : null)

export class Places {
  readonly #db: Db | Tx
  readonly #cache = new Map<string, Place>()
  readonly #moved: ({ id: string } & Where) | null

  constructor(db: Db | Tx, moved: ({ id: string } & Where) | null = null) {
    this.#db = db
    this.#moved = moved
  }

  async load(ids: (string | null)[]): Promise<void> {
    const missing = [...new Set(ids)].filter((id): id is string => !!id && id !== GLOBAL_SPACE && !this.#cache.has(id))
    if (!missing.length) return
    for (const row of await places(this.#db, inArray(space.id, missing))) this.#cache.set(row.id, toPlace(row))
  }

  async get(id: string): Promise<Place> {
    await this.load([id])
    const place = this.#cache.get(id)
    if (!place) throw new Problem(404, 'No such space')
    const moved = this.#moved
    if (moved?.id === id) return { ...place, scope: moved.scope, isolated: moved.isolated }
    if (moved?.id === place.scope) return { ...place, isolated: moved.isolated }
    return place
  }

  async eyes(home: string | null): Promise<Eyes> {
    if (home === null) return { mode: 'open' }
    if (home === GLOBAL_SPACE) return { mode: 'global' }
    const place = await this.get(home)
    return place.isolated ? { mode: 'isolated', space: place.scope } : { mode: 'open' }
  }

  async domain(home: string | null): Promise<string | null> {
    return domainOf(await this.eyes(home))
  }

  async sees(eyes: Eyes, home: string | null): Promise<boolean> {
    if (home === GLOBAL_SPACE) return true
    if (eyes.mode === 'global') return false
    if (home === null) return eyes.mode === 'open'
    const place = await this.get(home)
    return eyes.mode === 'open' ? !place.isolated : place.scope === eyes.space
  }
}

export const eyesOfHome = (db: Db | Tx, home: string | null): Promise<Eyes> => new Places(db).eyes(home)

export function assertInside(scope: Scope, placeScope: string, what: string): void {
  if (scope.mode === 'isolated' && placeScope !== scope.space) {
    throw new Problem(403, `An isolated session ${what} only inside ${scope.name}`)
  }
}

export function confirmGlobal(scope: Scope, home: string | null, confirmed: boolean, what: string): void {
  if (scope.mode !== 'isolated' || home !== GLOBAL_SPACE || confirmed) return
  throw new Problem(
    428,
    `This ${what} is global: anything an isolated session writes here is readable by every session. Ask the operator, then repeat with global: true`,
  )
}

export async function homeForWrite(db: Db | Tx, scope: Scope, path: string | null | undefined): Promise<string | null> {
  if (path === undefined) return scope.mode === 'isolated' ? scope.space : null
  if (path === null) {
    if (scope.mode === 'isolated') throw new Problem(403, 'An isolated session cannot unassign')
    return null
  }
  const place = await findPlace(db, scope, path)
  assertInside(scope, place.scope, 'writes')
  return place.id
}
