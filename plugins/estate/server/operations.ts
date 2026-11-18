import { actorId, actorName, defineOperation, type OperationContext, Problem } from '@hubd/sdk'
import { and, asc, desc, eq, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import { checkBudget } from './budget.ts'
import { CLAIM, claimBySlug, nextReview, shown } from './read.ts'
import {
  claim,
  claimCheck,
  claimRelation,
  claimSource,
  OUTCOMES,
  source,
  subjectRelation,
  suggestion,
  verification,
} from './schema.ts'
import { legendOf, searchOperation } from './search.ts'
import { apply, type Run, step } from './steps.ts'

const ROLLBACK = Symbol('dry run')

type Ctx = OperationContext

const scopeOf = (ctx: Ctx) => (ctx.scope.mode === 'isolated' ? ctx.scope.space : null)

const suggestionVisible = (ctx: Ctx): SQL =>
  sql`not exists (select 1 from unnest(${suggestion.homes}) as h(id) where not ${ctx.visible(sql.raw('h.id'))}) and (not ${suggestion.unassigned} or ${ctx.scope.mode === 'open'})`

async function run(ctx: Ctx, steps: z.infer<typeof step>[]) {
  const r: Run = { ctx, lint: [], homes: new Set(), budget: new Set() }
  for (const s of steps) await apply(r, s)
  await checkBudget(ctx, r.budget)
  return r
}

export const suggestionOperations = [
  defineOperation({
    id: 'suggestions.add',
    summary: 'Suggest a change to estate',
    description:
      'A suggestion is a list of steps (record, edit, retire, move, load, rename, cite and relate claims; add checks; set a profile; create, rename, alias, merge or retire subjects). It is tried at once and kept pending with its lint, including the subjects it would create; nothing is written until the operator approves it.',
    input: {
      steps: z.array(step).min(1).max(50),
      reason: z.string().trim().max(2000).default(''),
    },
    http: { method: 'POST', path: '/suggestions' },
    mcp: { name: 'suggestions_add' },
    async run({ steps, reason }, ctx) {
      const [row] = await ctx.tx
        .insert(suggestion)
        .values({
          author: actorName(ctx.actor),
          clientId: actorId(ctx.actor),
          ...ctx.origin,
          scope: scopeOf(ctx),
          reason,
          steps,
        })
        .returning({ id: suggestion.id })
      if (!row) throw new Error('suggestion was not stored')
      let tried: Run | null = null
      await ctx.tx
        .transaction(async () => {
          tried = await run(ctx, steps)
          throw ROLLBACK
        })
        .catch((e) => {
          if (e !== ROLLBACK) throw e
        })
      const done = tried as Run | null
      if (!done) throw new Error('dry run did not finish')
      const homes = [...done.homes]
      await ctx.tx
        .update(suggestion)
        .set({
          homes: homes.filter((h): h is string => h !== null),
          unassigned: homes.includes(null),
          lint: done.lint,
        })
        .where(eq(suggestion.id, row.id))
      return { id: row.id, state: 'pending', lint: done.lint }
    },
  }),
  defineOperation({
    id: 'suggestions.list',
    summary: 'List suggestions this session can see',
    input: { state: z.enum(['pending', 'accepted', 'rejected']).default('pending') },
    http: { method: 'GET', path: '/suggestions' },
    mcp: { name: 'suggestions_list', readOnly: true },
    run: ({ state }, ctx) =>
      ctx.tx
        .select({
          id: suggestion.id,
          author: suggestion.author,
          session: suggestion.session,
          model: suggestion.model,
          state: suggestion.state,
          reason: suggestion.reason,
          steps: suggestion.steps,
          lint: suggestion.lint,
          createdAt: suggestion.createdAt,
          decidedAt: suggestion.decidedAt,
          decidedBy: suggestion.decidedBy,
          commit: suggestion.commitId,
        })
        .from(suggestion)
        .where(and(eq(suggestion.state, state), suggestionVisible(ctx)))
        .orderBy(asc(suggestion.createdAt)),
  }),
  defineOperation({
    id: 'suggestions.accept',
    summary: 'Accept a pending suggestion and apply it',
    description:
      'Applies every step in one transaction, resolving names again; a name taken since the suggestion was made refuses all of it. Accept from a session in the scope it was made in. Act only as the operator directs.',
    input: { id: z.uuid() },
    http: { method: 'POST', path: '/suggestions/:id/accept' },
    mcp: { name: 'suggestions_accept', destructive: true },
    async run({ id }, ctx) {
      const [row] = await ctx.tx
        .select()
        .from(suggestion)
        .where(and(eq(suggestion.id, id), suggestionVisible(ctx)))
      if (!row) throw new Problem(404, `No suggestion ${id}`)
      if (row.state !== 'pending') throw new Problem(409, `Suggestion ${id} is already ${row.state}`)
      if (row.scope !== scopeOf(ctx))
        throw new Problem(403, 'Accept a suggestion from a session in the scope it was made in')
      const done = await run(ctx, z.array(step).parse(row.steps))
      const commitId = await ctx.history.commit(row.reason || `suggestion ${id}`)
      await ctx.tx
        .update(suggestion)
        .set({ state: 'accepted', decidedAt: new Date(), decidedBy: actorName(ctx.actor), lint: done.lint, commitId })
        .where(eq(suggestion.id, id))
      const homes = [...done.homes]
      await ctx.events.publish('suggestion.accepted', { id, home: homes.length === 1 ? (homes[0] ?? null) : null })
      return { id, state: 'accepted', commit: commitId, lint: done.lint }
    },
  }),
  defineOperation({
    id: 'suggestions.reject',
    summary: 'Reject a pending suggestion',
    input: { id: z.uuid(), reason: z.string().trim().max(2000).optional() },
    http: { method: 'POST', path: '/suggestions/:id/reject' },
    mcp: { name: 'suggestions_reject' },
    async run({ id, reason }, ctx) {
      const [row] = await ctx.tx
        .update(suggestion)
        .set({
          state: 'rejected',
          decidedAt: new Date(),
          decidedBy: actorName(ctx.actor),
          ...(reason ? { reason } : {}),
        })
        .where(and(eq(suggestion.id, id), eq(suggestion.state, 'pending'), suggestionVisible(ctx)))
        .returning({ id: suggestion.id })
      if (!row) throw new Problem(404, `No pending suggestion ${id}`)
      return { id, state: 'rejected' }
    },
  }),
]

const slugInput = z.string().min(1).max(80)
const subjectKind = z.enum(['topic', 'asset'])

export const claimOperations = [
  searchOperation,
  defineOperation({
    id: 'claims.get',
    summary: 'Get one claim with its slugs, revisions, checks, sources and relations',
    input: { slug: slugInput },
    http: { method: 'GET', path: '/claims/get' },
    mcp: { name: 'claims_get', readOnly: true },
    async run({ slug }, ctx) {
      const row = await claimBySlug(ctx, slug)
      const [main] = await shown(ctx, [row])
      const [slugs, revisions, checks, results, sources, related, subjects, links] = await Promise.all([
        ctx.names.history({ kind: CLAIM, id: row.id }),
        ctx.history.revisions({ kind: CLAIM, id: row.id }),
        ctx.tx.select().from(claimCheck).where(eq(claimCheck.claimId, row.id)),
        ctx.tx
          .select()
          .from(verification)
          .where(eq(verification.claimId, row.id))
          .orderBy(desc(verification.lastSeen))
          .limit(20),
        ctx.tx
          .select({ kind: source.kind, ref: source.ref, locator: claimSource.locator, capturedAt: source.capturedAt })
          .from(claimSource)
          .innerJoin(source, eq(source.id, claimSource.sourceId))
          .where(eq(claimSource.claimId, row.id)),
        ctx.tx
          .select({ relation: claimRelation.relation, to: claimRelation.toClaim })
          .from(claimRelation)
          .where(eq(claimRelation.fromClaim, row.id)),
        ctx.tx.select().from(subjectRelation).where(eq(subjectRelation.claimId, row.id)),
        ctx.links.list({ kind: CLAIM, id: row.id }),
      ])
      const seen = related.length
        ? await ctx.tx
            .select({ id: claim.id })
            .from(claim)
            .where(
              and(
                inArray(
                  claim.id,
                  related.map((r) => r.to),
                ),
                ctx.visible(claim.home),
              ),
            )
        : []
      const relSlugs = await ctx.names.current(
        CLAIM,
        seen.map((s) => s.id),
      )
      return {
        ...main,
        slugs,
        revisions,
        checks,
        results,
        sources,
        relations: related.flatMap((r) => {
          const to = relSlugs.get(r.to)
          return to ? [{ relation: r.relation, to }] : []
        }),
        subjectRelations: subjects,
        links,
        legend: await ctx.subjects.legend(
          links.flatMap((l) => ('subject' in l.to && l.to.subject.kind === 'asset' ? [l.to.subject.id] : [])),
        ),
      }
    },
  }),
  defineOperation({
    id: 'claims.about',
    summary: 'Everything estate knows about one topic or asset',
    input: { kind: subjectKind, name: z.string().min(1).max(80) },
    http: { method: 'GET', path: '/claims/about' },
    mcp: { name: 'claims_about', readOnly: true },
    async run({ kind, name }, ctx) {
      const found = await ctx.subjects.find(kind, name)
      if (!found) throw new Problem(404, `No ${kind} "${name}"`)
      const pointing = await ctx.links.pointingAt({ subject: found.id }, CLAIM)
      const ids = [...new Set(pointing.map((p) => p.id))]
      const rows = ids.length
        ? await ctx.tx
            .select()
            .from(claim)
            .where(
              and(
                inArray(claim.id, ids),
                ctx.visible(claim.home),
                eq(claim.status, 'current'),
                isNull(claim.contradictedAt),
              ),
            )
            .orderBy(desc(sql`${claim.type} = 'Trap'`), desc(claim.updatedAt))
        : []
      const how = new Map(pointing.map((p) => [p.id, p.kind]))
      const relations = await ctx.tx
        .select()
        .from(subjectRelation)
        .innerJoin(claim, eq(claim.id, subjectRelation.claimId))
        .where(
          and(
            or(eq(subjectRelation.fromSubject, found.id), eq(subjectRelation.toSubject, found.id)),
            ctx.visible(claim.home),
          ),
        )
      return {
        subject: { kind, name, id: found.id },
        claims: (await shown(ctx, rows)).map((c) => ({ ...c, link: how.get(c.id) })),
        relations: relations.map((r) => r.subject_relation),
        legend: await legendOf(
          ctx,
          rows.map((r) => r.id),
        ),
      }
    },
  }),
  defineOperation({
    id: 'claims.map',
    summary: 'The topics and assets claims are about, with how many current claims each',
    input: {},
    http: { method: 'GET', path: '/claims/map' },
    mcp: { name: 'claims_map', readOnly: true },
    run: (_, ctx) =>
      ctx.tx.execute(sql`select s.kind, s.name, count(distinct ${claim.id})::int as claims
        from hubd.link l join hubd.subject s on s.id = l.to_subject
        join ${claim} on ${claim.id} = l.from_id
        where l.from_kind = ${CLAIM} and l.kind = 'about' and ${claim.status} = 'current'
          and ${ctx.visible(claim.home)} and ${ctx.visible(sql.raw('s.home'))}
        group by s.kind, s.name order by claims desc, s.name`),
  }),
]

export const verificationOperations = [
  defineOperation({
    id: 'verifications.due',
    summary: 'What is due for verification: claims past their review date, and checks to run here',
    description:
      'claims: current claims this session can see whose review date has passed and that have no check (a check is their review). checks: checks of current claims with no result in the last day, for any machine or for the asset named like this client.',
    input: { limit: z.coerce.number().int().min(1).max(200).default(50) },
    http: { method: 'GET', path: '/verifications/due' },
    mcp: { name: 'verifications_due', readOnly: true },
    async run({ limit }, ctx) {
      const me = ctx.actor.kind === 'client' ? await ctx.subjects.find('asset', ctx.actor.name) : null
      const [stale, rows] = await Promise.all([
        ctx.tx
          .select()
          .from(claim)
          .where(
            and(
              ctx.visible(claim.home),
              eq(claim.status, 'current'),
              lte(claim.reconfirmAt, new Date()),
              sql`not exists (select 1 from ${claimCheck} k where k.claim_id = ${claim.id})`,
            ),
          )
          .orderBy(asc(claim.reconfirmAt))
          .limit(limit),
        ctx.tx
          .select({ check: claimCheck, claimId: claim.id })
          .from(claimCheck)
          .innerJoin(claim, eq(claim.id, claimCheck.claimId))
          .where(
            and(
              ctx.visible(claim.home),
              eq(claim.status, 'current'),
              me ? or(isNull(claimCheck.runsOn), eq(claimCheck.runsOn, me.id)) : isNull(claimCheck.runsOn),
              sql`not exists (select 1 from ${verification} r where r.check_id = ${claimCheck.id} and r.last_seen > now() - interval '1 day')`,
            ),
          )
          .limit(limit),
      ])
      const slugs = await ctx.names.current(
        CLAIM,
        rows.map((r) => r.claimId),
      )
      return {
        claims: await shown(ctx, stale),
        checks: rows.map((r) => ({ slug: slugs.get(r.claimId), ...r.check })),
      }
    },
  }),
  defineOperation({
    id: 'verifications.report',
    summary: 'Report what a check or an observation found about a claim (verified, contradicted, could not run)',
    description:
      "holds, contradicted or could-not-run. holds moves the claim's review date forward; contradicted takes it out of default search until it is edited, retired or holds again. The same outcome again extends the last result; a different one starts a new result.",
    input: {
      slug: slugInput,
      check: z.uuid().optional().describe('the check id, when a check ran'),
      outcome: z.enum(OUTCOMES),
      note: z.string().max(2000).optional(),
    },
    http: { method: 'POST', path: '/verifications' },
    mcp: { name: 'verifications_report' },
    async run({ slug, check, outcome, note }, ctx) {
      const row = await claimBySlug(ctx, slug)
      if (outcome === 'holds') {
        await ctx.tx
          .update(claim)
          .set({ reconfirmAt: nextReview(row.reviewDays), contradictedAt: null })
          .where(eq(claim.id, row.id))
      } else if (outcome === 'contradicted') {
        await ctx.tx.update(claim).set({ contradictedAt: new Date() }).where(eq(claim.id, row.id))
      }
      const by = check ? 'check' : ctx.actor.kind === 'user' ? 'user' : 'agent'
      const [last] = await ctx.tx
        .select()
        .from(verification)
        .where(
          and(
            eq(verification.claimId, row.id),
            check ? eq(verification.checkId, check) : isNull(verification.checkId),
            eq(verification.by, by),
          ),
        )
        .orderBy(desc(verification.lastSeen))
        .limit(1)
      if (last && last.outcome === outcome && last.revision === row.revision) {
        const [updated] = await ctx.tx
          .update(verification)
          .set({ lastSeen: new Date(), note: note ?? last.note })
          .where(eq(verification.id, last.id))
          .returning()
        return updated
      }
      const me = ctx.actor.kind === 'client' ? await ctx.subjects.find('asset', ctx.actor.name) : null
      const [made] = await ctx.tx
        .insert(verification)
        .values({
          claimId: row.id,
          checkId: check,
          revision: row.revision,
          by,
          reporter: actorName(ctx.actor),
          ranOn: me?.id,
          outcome,
          note,
        })
        .returning()
      return made
    },
  }),
]
