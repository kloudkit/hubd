import {
  defineOperation,
  GLOBAL_SPACE,
  homePath,
  type LegendEntry,
  likePattern,
  type OperationContext,
  Problem,
  type SubjectKind,
  setting,
} from '@hubd/sdk'
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { CLAIM, type ClaimRow, shown } from './read.ts'
import { claim, STATUSES, subjectRelation, TYPES } from './schema.ts'

type Ctx = OperationContext

const CANDIDATES = 500
const PIVOT = 2
const BOOST = { whole: 1.3, place: 2, project: 2, scope: 1.5, global: 1.2, trap: 1.5, stale: 0.8, slug: 1.5 }
const SLUG_FLOOR = 0.1

const segments = (path: string | null | undefined) => (path ?? '').split('/').filter(Boolean)

function distance(a: string | null | undefined, b: string | null | undefined): number {
  const x = segments(a)
  const y = segments(b)
  let common = 0
  while (common < x.length && common < y.length && x[common] === y[common]) common++
  return x.length - common + (y.length - common)
}

const related = (a: string | null, b: string | null | undefined) => {
  const x = segments(a).join('/')
  const y = segments(b).join('/')
  return !x || !y || x.startsWith(y) || y.startsWith(x)
}

function parseRef(value: string, kinds: SubjectKind[]) {
  const [kind = '', name = '', ...rest] = value.split('/')
  if (!kinds.includes(kind as SubjectKind) || !name) {
    throw new Problem(400, `"${value}" is not ${kinds.map((k) => `${k}/<name>[/path]`).join(' or ')}`)
  }
  return { kind: kind as SubjectKind, name, path: rest.join('/') || null }
}

export async function legendOf(ctx: Ctx, claimIds: string[]): Promise<LegendEntry[]> {
  const links = await ctx.links.listMany(claimIds.map((id) => ({ kind: CLAIM, id })))
  const assets = [...links.values()]
    .flat()
    .flatMap((l) => ('subject' in l.to && l.to.subject.kind === 'asset' ? [l.to.subject.id] : []))
  return ctx.subjects.legend(assets)
}

export const searchOperation = defineOperation({
  id: 'claims.search',
  summary: 'Search claims',
  description:
    'Current claims this session can see, matched by words in the statement, the names of what they are about and the detail, or by slug (typos tolerated). about (kind/name[/path], e.g. asset/nas/volume1) keeps only claims about that subject. place (asset[/path], e.g. bdsoha.kloud-home/kubernetes/resources/litellm) is where the work is: claims about it rank first, nearer paths higher, then claims about what it is part of, its project and scope, global and Traps. Contradicted claims are left out unless asked for; stale ones rank lower. The answer carries a legend of the assets the hits reference.',
  input: {
    q: z.string().trim().max(200).optional(),
    type: z.enum(TYPES).optional(),
    about: z.string().max(300).optional().describe('kind/name[/path]: only claims about this topic or asset'),
    place: z.string().max(300).optional().describe('asset[/path] where the work is'),
    project: z.string().max(81).optional().describe('scope/project path the work is in, when no place says it'),
    status: z.enum(STATUSES).default('current'),
    contradicted: setting.boolean().default(false).describe('include claims a check contradicted'),
    order: z.enum(['rank', 'oldest']).default('rank').describe('oldest lists e.g. open KnownIssues by age'),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  },
  http: { method: 'GET', path: '/claims' },
  mcp: { name: 'claims_search', readOnly: true },
  async run(a, ctx) {
    const about = a.about ? parseRef(a.about, ['topic', 'asset']) : null
    const aboutSubject = about ? await ctx.subjects.find(about.kind, about.name) : null
    if (about && !aboutSubject) throw new Problem(404, `No ${about.kind} "${about.name}"`)
    const place = a.place ? parseRef(`asset/${a.place}`, ['asset']) : null
    const placeAsset = place ? await ctx.subjects.find('asset', place.name) : null
    const [assetHome] =
      placeAsset?.home && !a.project
        ? await ctx.tx.execute<{
            path: string
          }>(sql`select case when hp.name is null then hs.name else hp.name || '/' || hs.name end as path
            from hubd.space hs left join hubd.space hp on hp.id = hs.parent where hs.id = ${placeAsset.home}::uuid`)
        : []
    const wholes = new Set(
      placeAsset
        ? (
            await ctx.tx
              .select({ id: subjectRelation.toSubject })
              .from(subjectRelation)
              .innerJoin(claim, eq(claim.id, subjectRelation.claimId))
              .where(
                and(
                  eq(subjectRelation.fromSubject, placeAsset.id),
                  eq(subjectRelation.relation, 'part-of'),
                  eq(claim.status, 'current'),
                  ctx.visible(claim.home),
                ),
              )
          ).map((r) => r.id)
        : [],
    )
    const project = a.project ?? assetHome?.path ?? null
    const scope = project?.split('/')[0] ?? null

    const aboutIds = aboutSubject
      ? [
          ...new Set(
            (await ctx.links.pointingAt({ subject: aboutSubject.id }, CLAIM))
              .filter((p) => p.kind === 'about')
              .map((p) => p.id),
          ),
        ]
      : null
    if (aboutIds && !aboutIds.length) return { claims: [], legend: [] }

    const query = a.q ? sql`websearch_to_tsquery('english', ${a.q})` : null
    const names = sql`setweight(to_tsvector('english', coalesce((select string_agg(s.name, ' ') from hubd.link l
      join hubd.subject s on s.id = l.to_subject
      where l.from_kind = ${CLAIM} and l.from_id = ${claim.id} and l.kind = 'about'), '')), 'B')`
    const slugHit = a.q
      ? sql`exists (select 1 from hubd.name n where n.kind = ${CLAIM} and n.record_id = ${claim.id} and n.valid_until is null and (lower(n.name) % lower(${a.q}) or n.name ilike ${likePattern(a.q)}))`
      : sql`false`
    const text = query ? sql`ts_rank_cd(${claim.search} || ${names}, ${query}, 32)` : sql`0`
    const where = and(
      ctx.visible(claim.home),
      eq(claim.status, a.status),
      a.type ? eq(claim.type, a.type) : undefined,
      a.contradicted ? undefined : isNull(claim.contradictedAt),
      aboutIds ? inArray(claim.id, aboutIds) : undefined,
      query ? (or(sql`(${claim.search} || ${names}) @@ ${query}`, slugHit) as SQL) : undefined,
    )
    if (a.order === 'oldest') {
      const rows = await ctx.tx.select().from(claim).where(where).orderBy(asc(claim.createdAt)).limit(a.limit)
      return {
        claims: await shown(ctx, rows),
        legend: await legendOf(
          ctx,
          rows.map((r) => r.id),
        ),
      }
    }
    const found = await ctx.tx
      .select({ row: claim, text: sql<number>`${text}`, slug: sql<boolean>`${slugHit}`, path: homePath(claim.home) })
      .from(claim)
      .where(where)
      .orderBy(desc(sql`${text}`), desc(claim.updatedAt))
      .limit(CANDIDATES)
    const links = await ctx.links.listMany(found.map((f) => ({ kind: CLAIM, id: f.row.id })))
    const now = Date.now()
    const scored = found
      .map((f) => {
        const own = (links.get(f.row.id) ?? []).filter((l) => l.kind === 'about' && 'subject' in l.to)
        const on = (id: string | undefined) => own.filter((l) => 'subject' in l.to && l.to.subject.id === id)
        if (about?.path && !on(aboutSubject?.id).some((l) => related(l.path, about.path))) return null
        const atPlace = on(placeAsset?.id)
        const near = atPlace.length ? Math.min(...atPlace.map((l) => distance(l.path, place?.path))) : null
        const ofWhole = near === null && own.some((l) => 'subject' in l.to && wholes.has(l.to.subject.id))
        const base = query ? Math.max(Number(f.text), f.slug ? SLUG_FLOOR : 0) * (f.slug ? BOOST.slug : 1) : 1
        const stale = f.row.reconfirmAt !== null && f.row.reconfirmAt.getTime() < now
        const home =
          project && f.path === project
            ? BOOST.project
            : scope && f.path === scope
              ? BOOST.scope
              : f.row.home === GLOBAL_SPACE
                ? BOOST.global
                : 1
        const score =
          base *
          (near === null ? (ofWhole ? BOOST.whole : 1) : 1 + (BOOST.place * PIVOT) / (PIVOT + near)) *
          home *
          (f.row.type === 'Trap' ? BOOST.trap : 1) *
          (stale ? BOOST.stale : 1)
        return { row: f.row, score }
      })
      .filter((s): s is { row: ClaimRow; score: number } => s !== null)
      .sort((x, y) => y.score - x.score || y.row.updatedAt.getTime() - x.row.updatedAt.getTime())
      .slice(0, a.limit)
    const rows = scored.map((s) => s.row)
    const claims = await shown(ctx, rows)
    return {
      claims: claims.map((c, i) => ({ ...c, score: Math.round((scored[i]?.score ?? 0) * 1000) / 1000 })),
      legend: await legendOf(
        ctx,
        rows.map((r) => r.id),
      ),
    }
  },
})
