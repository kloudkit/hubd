import { GLOBAL_SPACE, type OperationContext, Problem } from '@hubd/sdk'
import { inArray, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { claim, instruction, profile } from './schema.ts'

export const DEFAULT_LOAD_CAP = 8_000

type Ctx = Pick<OperationContext, 'tx' | 'visible'>

const count = (n: number) => n.toLocaleString('en')

const inScope = (home: AnyPgColumn, scope: string) =>
  sql`${home} in (select bs.id from hubd.space bs where bs.id = ${scope}::uuid or bs.parent = ${scope}::uuid)`

export async function loadedSize(ctx: Ctx, scope: string): Promise<number> {
  const [row] = await ctx.tx.execute<{ n: string }>(sql`select
    (select coalesce(sum(char_length(${claim.statement}) + char_length(${claim.detail})), 0) from ${claim}
      where ${claim.loading} = 'always' and ${claim.status} = 'current' and ${inScope(claim.home, scope)})
    + (select coalesce(sum(char_length(${instruction.body})), 0) from ${instruction}
      where ${instruction.enabled} and ${inScope(instruction.home, scope)}) as n`)
  return Number(row?.n ?? 0)
}

async function loadCap(ctx: Ctx, scope: string): Promise<number> {
  const rows = await ctx.tx
    .select({ space: profile.space, cap: profile.loadCap })
    .from(profile)
    .where(inArray(profile.space, [scope, GLOBAL_SPACE]))
  const own = rows.find((r) => r.space === scope)?.cap
  return own ?? rows.find((r) => r.space === GLOBAL_SPACE)?.cap ?? DEFAULT_LOAD_CAP
}

export async function scopeOf(ctx: Ctx, home: string): Promise<string> {
  const [row] = await ctx.tx.execute<{ scope: string }>(
    sql`select coalesce(parent, id) as scope from hubd.space where id = ${home}::uuid`,
  )
  if (!row) throw new Problem(404, 'No such space')
  return row.scope
}

export async function inheritingScopes(ctx: Ctx): Promise<string[]> {
  const rows = await ctx.tx.execute<{ id: string }>(sql`select s.id from hubd.space s
    where s.parent is null and not exists (select 1 from ${profile} where ${profile.space} = s.id and ${profile.loadCap} is not null)`)
  return rows.map((r) => r.id)
}

export async function checkBudget(ctx: Ctx, homes: Iterable<string | null>): Promise<void> {
  const ids = [...new Set(homes)].filter((h): h is string => h !== null)
  if (!ids.length) return
  const scopes = await ctx.tx.execute<{ id: string; name: string; seen: boolean }>(sql`select distinct
      coalesce(s.parent, s.id) as id, coalesce(p.name, s.name) as name, ${ctx.visible(sql`coalesce(s.parent, s.id)`)} as seen
    from hubd.space s left join hubd.space p on p.id = s.parent
    where s.id in (${sql.join(
      ids.map((id) => sql`${id}::uuid`),
      sql`, `,
    )})`)
  const over: string[] = []
  for (const s of scopes) {
    const [size, cap] = await Promise.all([loadedSize(ctx, s.id), loadCap(ctx, s.id)])
    if (size <= cap) continue
    const who = s.seen ? `"${s.name}"` : 'A scope this session cannot see'
    over.push(`${who} would load ${count(size)} characters, over its cap of ${count(cap)}`)
  }
  if (over.length) {
    throw new Problem(
      409,
      'Always-loaded text would exceed a load cap: switch a claim or instruction off, or raise the cap',
      over,
    )
  }
}
