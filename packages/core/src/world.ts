import { GLOBAL_SPACE, Problem, type RecordRef, type SubjectKind, type Tx } from '@hubd/sdk'
import { type SQL, sql } from 'drizzle-orm'
import { liveNames, nameConflicts, setDomain } from './names.ts'
import type { Records } from './records.ts'
import type { Places } from './visibility.ts'

export type Edge = {
  fromKind: string
  fromId: string
  fromHome: string | null
  toSubject: string | null
  subjectKind: SubjectKind | null
  subjectName: string | null
  toKind: string | null
  toId: string | null
  toHome: string | null
}

const MAX_CONFLICTS = 50

export function refuse(what: string, conflicts: string[]): void {
  if (!conflicts.length) return
  const shown = conflicts.slice(0, MAX_CONFLICTS)
  const more = conflicts.length - shown.length
  throw new Problem(409, `${what} is refused: ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'}`, [
    ...shown,
    ...(more ? [`and ${more} more`] : []),
  ])
}

export const FROM_HOME = sql.raw('fh.home')
export const TO_HOME = sql.raw('coalesce(s.home, th.home)')

export async function edges(tx: Tx, records: Records, where: SQL): Promise<Edge[]> {
  const homes = records.homesSql()
  if (!homes) return []
  return tx.execute<Edge>(sql`with homes as not materialized (${homes})
    select l.from_kind as "fromKind", l.from_id as "fromId", fh.home as "fromHome",
      l.to_subject as "toSubject", s.kind as "subjectKind", s.name as "subjectName",
      l.to_kind as "toKind", l.to_id as "toId", ${TO_HOME} as "toHome"
    from hubd.link l
    join homes fh on fh.kind = l.from_kind and fh.id = l.from_id
    left join hubd.subject s on s.id = l.to_subject
    left join homes th on th.kind = l.to_kind and th.id = l.to_id
    where (l.to_subject is not null or th.id is not null) and (${where})`)
}

export async function crossing(places: Places, linked: Edge[]): Promise<string[]> {
  await places.load(linked.flatMap((e) => [e.fromHome, e.toHome]))
  const out: string[] = []
  for (const e of linked) {
    if (await places.sees(await places.eyes(e.fromHome), e.toHome)) continue
    const target = e.toSubject ? `${e.subjectKind} ${e.subjectName}` : `${e.toKind} ${e.toId}`
    out.push(`the link from ${e.fromKind} ${e.fromId} to ${target} would cross isolation`)
  }
  return out
}

export async function moveRecord(tx: Tx, places: Places, records: Records, record: RecordRef, home: string | null) {
  const mine = (kind: string | null, id: string | null) => kind === record.kind && id === record.id
  const linked = await edges(
    tx,
    records,
    sql`(l.from_kind = ${record.kind} and l.from_id = ${record.id}::uuid) or (l.to_kind = ${record.kind} and l.to_id = ${record.id}::uuid)`,
  )
  const moved = linked.map((e) => ({
    ...e,
    fromHome: mine(e.fromKind, e.fromId) ? home : e.fromHome,
    toHome: mine(e.toKind, e.toId) ? home : e.toHome,
  }))
  const domain = await places.domain(home)
  const global = home === GLOBAL_SPACE
  const conflicts = await nameConflicts(tx, await liveNames(tx, [record.id]), domain, global, 'where it would move')
  conflicts.push(...(await crossing(places, moved)))
  refuse(`Moving ${record.kind} ${record.id}`, conflicts)
  await setDomain(tx, [record.id], domain, global)
}
