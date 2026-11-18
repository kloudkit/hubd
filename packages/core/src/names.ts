import { GLOBAL_SPACE, Problem, type Tx } from '@hubd/sdk'
import { and, desc, eq, inArray, isNull, type SQL, sql } from 'drizzle-orm'
import { names } from './schema.ts'
import type { Eyes, Places } from './visibility.ts'

export type Owner = { subject: string } | { record: string }

const NAME = /^[A-Za-z0-9][\w.-]{0,79}$/
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const sameName = (n: string) => sql`lower(${names.name}) = lower(${n})`
export const live = isNull(names.validUntil)
const ownerOf = sql<string>`coalesce(${names.subjectId}, ${names.recordId})`
const ownerColumns = (o: Owner) => ('subject' in o ? { subjectId: o.subject } : { recordId: o.record })
const ownerIs = (o: Owner) => ('subject' in o ? eq(names.subjectId, o.subject) : eq(names.recordId, o.record))
const noun = (kind: string) => kind.split('.').at(-1) ?? kind

export class NameTaken extends Problem {
  constructor(kind: string, name: string) {
    super(409, `The ${noun(kind)} name "${name}" is taken`)
  }
}

export function checkName(name: string): void {
  if (!NAME.test(name) || UUID.test(name)) {
    throw new Problem(400, 'A name is 1 to 80 letters, digits, dots, dashes or underscores, and not an id')
  }
}

async function nameClash(
  tx: Tx,
  kind: string,
  name: string,
  domain: string | null,
  global: boolean,
  except: string[] = [],
): Promise<boolean> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`${kind}:${name.toLowerCase()}`}))`)
  const [taken] = await tx
    .select({ id: names.id })
    .from(names)
    .where(
      and(
        eq(names.kind, kind),
        sameName(name),
        live,
        except.length
          ? sql`${ownerOf} not in (${sql.join(
              except.map((e) => sql`${e}::uuid`),
              sql`, `,
            )})`
          : undefined,
        global ? undefined : sql`(${names.domain} is not distinct from ${domain}::uuid or ${names.global})`,
      ),
    )
  return !!taken
}

export async function claimName(tx: Tx, places: Places, kind: string, owner: Owner, name: string, home: string | null) {
  checkName(name)
  const domain = await places.domain(home)
  const global = home === GLOBAL_SPACE
  const id = 'subject' in owner ? owner.subject : owner.record
  if (await nameClash(tx, kind, name, domain, global, [id])) throw new NameTaken(kind, name)
  const [own] = await tx
    .select({ id: names.id })
    .from(names)
    .where(and(ownerIs(owner), sameName(name), live))
  if (!own) await tx.insert(names).values({ kind, ...ownerColumns(owner), name, domain, global })
}

export async function endName(tx: Tx, owner: Owner, name: string, keep?: string): Promise<number> {
  const ended = await tx
    .update(names)
    .set({ validUntil: new Date() })
    .where(and(ownerIs(owner), sameName(name), keep ? sql`lower(${names.name}) <> lower(${keep})` : undefined, live))
    .returning({ id: names.id })
  return ended.length
}

export async function endAll(tx: Tx, owner: Owner) {
  await tx
    .update(names)
    .set({ validUntil: new Date() })
    .where(and(ownerIs(owner), live))
}

export function liveNames(tx: Tx, owners: string[]) {
  if (!owners.length) return Promise.resolve([])
  return tx
    .select({ kind: names.kind, name: names.name, owner: ownerOf })
    .from(names)
    .where(
      and(
        sql`${ownerOf} in (${sql.join(
          owners.map((o) => sql`${o}::uuid`),
          sql`, `,
        )})`,
        live,
      ),
    )
}

export function history(tx: Tx, owner: Owner) {
  return tx
    .select({ name: names.name, validFrom: names.validFrom, validUntil: names.validUntil })
    .from(names)
    .where(ownerIs(owner))
    .orderBy(names.validFrom)
}

export async function setDomain(tx: Tx, owners: string[], domain: string | null, global: boolean) {
  if (owners.length) {
    await tx
      .update(names)
      .set({ domain, global })
      .where(
        and(
          sql`${ownerOf} in (${sql.join(
            owners.map((o) => sql`${o}::uuid`),
            sql`, `,
          )})`,
          live,
        ),
      )
  }
}

export async function nameConflicts(
  tx: Tx,
  rows: { kind: string; name: string; owner: string }[],
  domain: string | null,
  global: boolean,
  where: string,
): Promise<string[]> {
  const movers = [...new Set(rows.map((r) => r.owner))]
  const out: string[] = []
  for (const r of rows) {
    if (await nameClash(tx, r.kind, r.name, domain, global, movers)) {
      out.push(`the ${noun(r.kind)} name "${r.name}" is taken ${where}`)
    }
  }
  return out
}

const visibleDomain = (eyes: Eyes): SQL =>
  eyes.mode === 'open'
    ? sql`${names.domain} is null`
    : eyes.mode === 'global'
      ? sql`${names.global}`
      : sql`(${names.domain} = ${eyes.space}::uuid or ${names.global})`

export async function resolveRecord(tx: Tx, kind: string, name: string, eyes: Eyes): Promise<string | null> {
  const [row] = await tx
    .select({ id: names.recordId })
    .from(names)
    .where(and(eq(names.kind, kind), sameName(name), live, visibleDomain(eyes)))
  return row?.id ?? null
}

export async function currentNames(tx: Tx, kind: string, records: string[]): Promise<Map<string, string>> {
  if (!records.length) return new Map()
  const rows = await tx
    .select({ id: names.recordId, name: names.name })
    .from(names)
    .where(and(eq(names.kind, kind), inArray(names.recordId, records), live))
    .orderBy(desc(names.validFrom))
  const out = new Map<string, string>()
  for (const r of rows) if (r.id && !out.has(r.id)) out.set(r.id, r.name)
  return out
}
