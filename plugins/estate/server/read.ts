import { homePath, type OperationContext, Problem } from '@hubd/sdk'
import { and, eq, inArray } from 'drizzle-orm'
import { claim } from './schema.ts'

export const CLAIM = 'estate.claim'
export const REVIEW_DAYS = 90

export const nextReview = (days: number | null): Date | null =>
  days === null ? null : new Date(Date.now() + days * 86_400_000)

export type ClaimRow = typeof claim.$inferSelect

export async function claimBySlug(ctx: Pick<OperationContext, 'tx' | 'names' | 'visible'>, name: string) {
  const id = await ctx.names.resolve(CLAIM, name)
  const [row] = id
    ? await ctx.tx
        .select()
        .from(claim)
        .where(and(eq(claim.id, id), ctx.visible(claim.home)))
    : []
  if (!row) throw new Problem(404, `No claim "${name}"`)
  return row
}

export async function shown(ctx: Pick<OperationContext, 'tx' | 'names' | 'links'>, rows: ClaimRow[]) {
  if (!rows.length) return []
  const ids = rows.map((r) => r.id)
  const [slugs, texts] = await Promise.all([
    ctx.names.current(CLAIM, ids),
    ctx.links.render(rows.flatMap((r) => [r.statement, r.detail])),
  ])
  const paths = new Map(
    (
      await ctx.tx
        .select({ id: claim.id, home: homePath(claim.home) })
        .from(claim)
        .where(inArray(claim.id, ids))
    ).map((p) => [p.id, p.home]),
  )
  return rows.map((r, i) => ({
    slug: slugs.get(r.id) ?? r.id,
    id: r.id,
    type: r.type,
    statement: texts[2 * i] ?? r.statement,
    detail: texts[2 * i + 1] ?? r.detail,
    home: paths.get(r.id) ?? null,
    strength: r.strength,
    loading: r.loading,
    status: r.status,
    statusReason: r.statusReason,
    reconfirmAt: r.reconfirmAt,
    reviewDays: r.reviewDays,
    stale: r.reconfirmAt !== null && r.reconfirmAt.getTime() < Date.now(),
    contradicted: r.contradictedAt !== null,
    revision: r.revision,
    updatedAt: r.updatedAt,
  }))
}
