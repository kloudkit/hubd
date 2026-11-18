import { GLOBAL_SPACE, inputs, type Link, type OperationContext, Problem } from '@hubd/sdk'
import { and, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { inheritingScopes, scopeOf } from './budget.ts'
import { CLAIM, type ClaimRow, claimBySlug, nextReview, REVIEW_DAYS } from './read.ts'
import {
  CLAIM_RELATIONS,
  claim,
  claimCheck,
  claimRelation,
  claimSource,
  LOADINGS,
  profile,
  SOURCE_KINDS,
  STATUSES,
  STRENGTHS,
  SUBJECT_RELATIONS,
  source,
  subjectRelation,
  TYPES,
} from './schema.ts'
import { DETAIL_MAX, STATEMENT_MAX } from './text.ts'

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9.-]{0,79}$/)
  .describe('the claim slug: lowercase letters, digits, dots and dashes')
const subjectKind = z.enum(['topic', 'asset'])
const subjectRef = z.object({
  kind: subjectKind,
  name: z.string().min(1).max(80),
  path: z.string().max(200).optional(),
})
const subjectName = z.string().min(1).max(80)
const reconfirmAt = z.iso.datetime().describe('when the claim is next due for review; default now plus reviewDays')
const reviewDays = z
  .number()
  .int()
  .min(1)
  .max(3650)
  .nullable()
  .describe('days between reviews, counted from the last edit or holds result; null: never due; default 90')
const trueAt = z.iso.datetime().nullable().describe('when this became true or stopped being true; null clears')
const statement = z.string().trim().min(1).max(STATEMENT_MAX)
const detail = z.string().max(DETAIL_MAX)

export const step = z.discriminatedUnion('step', [
  z.object({
    step: z.literal('claim.record'),
    slug,
    type: z.enum(TYPES),
    statement,
    detail: detail.default(''),
    home: inputs.spacePath.optional(),
    strength: z.enum(STRENGTHS).optional(),
    loading: z.enum(LOADINGS).default('on-request'),
    reconfirmAt: reconfirmAt.optional(),
    reviewDays: reviewDays.optional(),
    trueFrom: trueAt.optional(),
    trueUntil: trueAt.optional(),
    about: inputs.subjectRefs.default([]),
  }),
  z.object({
    step: z.literal('claim.edit'),
    slug,
    revision: z.number().int().describe('the revision this edit starts from'),
    type: z.enum(TYPES).optional(),
    statement: statement.optional(),
    detail: detail.optional(),
    strength: z.enum(STRENGTHS).nullable().optional(),
    reconfirmAt: reconfirmAt.optional(),
    reviewDays: reviewDays.optional(),
    trueFrom: trueAt.optional(),
    trueUntil: trueAt.optional(),
    about: inputs.subjectRefs.optional(),
  }),
  z.object({
    step: z.literal('claim.retire'),
    slug,
    status: z.enum(STATUSES).exclude(['current']),
    reason: z.string().trim().min(1).max(500),
  }),
  z.object({ step: z.literal('claim.move'), slug, home: inputs.spacePath.nullable() }),
  z.object({ step: z.literal('claim.load'), slug, loading: z.enum(LOADINGS) }),
  z.object({ step: z.literal('claim.rename'), slug, to: slug }),
  z.object({
    step: z.literal('claim.cite'),
    slug,
    kind: z.enum(SOURCE_KINDS),
    ref: z.string().trim().min(1).max(2000),
    locator: z.string().max(500).optional(),
  }),
  z.object({ step: z.literal('claim.relate'), slug, relation: z.enum(CLAIM_RELATIONS), to: slug }),
  z.object({
    step: z.literal('subject.relate'),
    slug,
    from: subjectRef,
    relation: z.enum(SUBJECT_RELATIONS),
    to: subjectRef,
  }),
  z.object({
    step: z.literal('check.add'),
    slug,
    command: z.string().trim().min(1).max(2000),
    needs: z.array(z.string().max(100)).max(20).default([]),
    timeout: z.number().int().positive().max(3600).optional(),
    runsOn: subjectName.optional().describe('the asset that runs it'),
  }),
  z.object({
    step: z.literal('profile.set'),
    space: inputs.spacePath.default('global'),
    voice: z.string().max(4000).nullable().optional(),
    style: z.string().max(4000).nullable().optional(),
    loadCap: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional()
      .describe('characters of always-loaded claims and enabled instructions the scope may load; null inherits global'),
  }),
  z.object({
    step: z.literal('subject.create'),
    kind: subjectKind,
    name: subjectName,
    home: inputs.spacePath.optional(),
    summary: z.string().max(120).optional(),
    type: z.string().max(40).optional(),
    endpoint: z.string().max(300).optional(),
    reachedBy: z.string().max(300).optional(),
  }),
  z.object({ step: z.literal('subject.rename'), kind: subjectKind, name: subjectName, to: subjectName }),
  z.object({
    step: z.literal('subject.alias'),
    kind: subjectKind,
    name: subjectName,
    alias: subjectName,
    remove: z.boolean().default(false),
  }),
  z.object({ step: z.literal('subject.merge'), kind: subjectKind, from: subjectName, into: subjectName }),
  z.object({ step: z.literal('subject.retire'), kind: subjectKind, name: subjectName }),
  z.object({ step: z.literal('subject.revive'), kind: subjectKind, name: subjectName }),
])

export type Step = z.infer<typeof step>

export type Run = {
  ctx: OperationContext
  lint: string[]
  homes: Set<string | null>
  budget: Set<string | null>
}

const ref = (row: { id: string }) => ({ kind: CLAIM, id: row.id })

async function snapshot(run: Run, id: string) {
  const [row] = await run.ctx.tx
    .update(claim)
    .set({ revision: sql`${claim.revision} + 1`, updatedAt: new Date() })
    .where(eq(claim.id, id))
    .returning()
  if (!row) throw new Error('claim vanished')
  await write(run, row)
}

async function write(run: Run, row: ClaimRow) {
  const { search: _search, id: _id, ...rest } = row
  await run.ctx.history.record(ref(row), row.home, rest)
}

const RESOLVABLE = new Set(['Question', 'KnownIssue', 'Intent'])
const CLOSES: Partial<Record<(typeof CLAIM_RELATIONS)[number], 'superseded' | 'resolved'>> = {
  supersedes: 'superseded',
  answers: 'resolved',
}

function resolvable(row: Pick<ClaimRow, 'type'>, slug: string) {
  if (!RESOLVABLE.has(row.type)) {
    throw new Problem(400, `Only a Question, KnownIssue or Intent is resolved; claim ${slug} is a ${row.type}`)
  }
}

function trueDates(from: Date | null, until: Date | null) {
  if (from && until && until < from) throw new Problem(400, 'trueUntil comes before trueFrom')
}

const at = (value: string | null | undefined, kept: Date | null) =>
  value === undefined ? kept : value === null ? null : new Date(value)

const loaded = (row: Pick<ClaimRow, 'loading' | 'status'>) => row.loading === 'always' && row.status === 'current'

function grows(run: Run, home: string | null) {
  if (home === null) run.lint.push('an unassigned claim loads in no session until it has a home')
  run.budget.add(home)
}

const keptAbout = (links: Link[]) =>
  links.flatMap((l) =>
    l.kind === 'about' && 'subject' in l.to
      ? [{ kind: l.to.subject.kind, name: l.to.subject.id, ...(l.path ? { path: l.path } : {}) }]
      : [],
  )

type About = z.infer<typeof inputs.subjectRefs>

async function relink(run: Run, row: { id: string }, text: { statement: string; detail: string }, about?: About) {
  const { ctx } = run
  const current = about ?? keptAbout(await ctx.links.list(ref(row)))
  const set = await ctx.links.set(ref(row), { texts: [text.statement, text.detail], about: current })
  run.lint.push(...set.lint, ...set.created.map((c) => `creates ${c}`))
  const [statement = text.statement, detail = text.detail] = set.texts
  await ctx.tx.update(claim).set({ statement, detail }).where(eq(claim.id, row.id))
}

export async function apply(run: Run, s: Step): Promise<void> {
  const { ctx } = run
  switch (s.step) {
    case 'claim.record': {
      const home = await ctx.homeFor(s.home)
      if (s.strength && s.type !== 'Rule') throw new Problem(400, 'Only a Rule has a strength')
      trueDates(at(s.trueFrom, null), at(s.trueUntil, null))
      const [row] = await ctx.tx
        .insert(claim)
        .values({
          home,
          type: s.type,
          statement: s.statement,
          detail: s.detail,
          strength: s.strength,
          loading: s.loading,
          reviewDays: s.reviewDays === undefined ? REVIEW_DAYS : s.reviewDays,
          trueFrom: at(s.trueFrom, null),
          trueUntil: at(s.trueUntil, null),
          reconfirmAt: s.reconfirmAt
            ? new Date(s.reconfirmAt)
            : nextReview(s.reviewDays === undefined ? REVIEW_DAYS : s.reviewDays),
        })
        .returning()
      if (!row) throw new Error('claim was not stored')
      await ctx.names.claim(ref(row), s.slug)
      await relink(run, row, s, s.about)
      const [stored] = await ctx.tx.select().from(claim).where(eq(claim.id, row.id))
      if (stored) await write(run, stored)
      if (s.loading === 'always') grows(run, home)
      run.homes.add(home)
      return
    }
    case 'claim.edit': {
      const row = await claimBySlug(ctx, s.slug)
      if (row.revision !== s.revision) {
        throw new Problem(409, `Claim ${s.slug} is at revision ${row.revision}, not ${s.revision}`)
      }
      const type = s.type ?? row.type
      const strength = s.strength === undefined ? row.strength : s.strength
      if (strength && type !== 'Rule') throw new Problem(400, 'Only a Rule has a strength')
      trueDates(at(s.trueFrom, row.trueFrom), at(s.trueUntil, row.trueUntil))
      await ctx.tx
        .update(claim)
        .set({
          type,
          strength,
          ...(s.reviewDays === undefined ? {} : { reviewDays: s.reviewDays }),
          trueFrom: at(s.trueFrom, row.trueFrom),
          trueUntil: at(s.trueUntil, row.trueUntil),
          reconfirmAt: s.reconfirmAt
            ? new Date(s.reconfirmAt)
            : nextReview(s.reviewDays === undefined ? row.reviewDays : s.reviewDays),
          contradictedAt: null,
        })
        .where(eq(claim.id, row.id))
      if (s.statement !== undefined || s.detail !== undefined || s.about) {
        const [shown = row.statement, detail = row.detail] = await ctx.links.render([row.statement, row.detail])
        await relink(run, row, { statement: s.statement ?? shown, detail: s.detail ?? detail }, s.about)
        if (loaded(row)) run.budget.add(row.home)
      }
      await snapshot(run, row.id)
      run.homes.add(row.home)
      return
    }
    case 'claim.retire': {
      const row = await claimBySlug(ctx, s.slug)
      if (s.status === 'resolved') resolvable(row, s.slug)
      await ctx.tx.update(claim).set({ status: s.status, statusReason: s.reason }).where(eq(claim.id, row.id))
      await snapshot(run, row.id)
      run.homes.add(row.home)
      return
    }
    case 'claim.move': {
      const row = await claimBySlug(ctx, s.slug)
      const home = await ctx.homeFor(s.home)
      await ctx.moves.move(ref(row), home)
      await ctx.tx.update(claim).set({ home }).where(eq(claim.id, row.id))
      await snapshot(run, row.id)
      if (loaded(row)) grows(run, home)
      run.homes.add(row.home).add(home)
      return
    }
    case 'claim.load': {
      const row = await claimBySlug(ctx, s.slug)
      await ctx.tx.update(claim).set({ loading: s.loading }).where(eq(claim.id, row.id))
      await snapshot(run, row.id)
      if (s.loading === 'always') grows(run, row.home)
      run.homes.add(row.home)
      return
    }
    case 'claim.rename': {
      const row = await claimBySlug(ctx, s.slug)
      await ctx.names.claim(ref(row), s.to)
      run.homes.add(row.home)
      return
    }
    case 'claim.cite': {
      const row = await claimBySlug(ctx, s.slug)
      const [found] = await ctx.tx
        .select({ id: source.id })
        .from(source)
        .where(
          and(
            eq(source.kind, s.kind),
            eq(source.ref, s.ref),
            row.home ? eq(source.home, row.home) : sql`${source.home} is null`,
          ),
        )
      const [made] = found
        ? [found]
        : await ctx.tx.insert(source).values({ home: row.home, kind: s.kind, ref: s.ref }).returning({ id: source.id })
      if (!made) throw new Error('source was not stored')
      await ctx.tx
        .insert(claimSource)
        .values({ claimId: row.id, sourceId: made.id, locator: s.locator })
        .onConflictDoNothing()
      run.homes.add(row.home)
      return
    }
    case 'claim.relate': {
      const from = await claimBySlug(ctx, s.slug)
      const to = await claimBySlug(ctx, s.to)
      if (!(await ctx.sees(from.home, to.home))) {
        throw new Problem(409, `Claim ${s.to} is not visible from claim ${s.slug}'s home`)
      }
      await ctx.tx
        .insert(claimRelation)
        .values({ fromClaim: from.id, relation: s.relation, toClaim: to.id })
        .onConflictDoNothing()
      run.homes.add(from.home)
      const closes = CLOSES[s.relation]
      if (closes && to.status === 'current') {
        if (!(await ctx.sees(to.home, from.home))) {
          throw new Problem(409, `Claim ${s.slug} cannot retire claim ${s.to}, which sits outside its isolated scope`)
        }
        if (closes === 'resolved') resolvable(to, s.to)
        const reason = `${closes === 'superseded' ? 'superseded by' : 'answered by'} claim ${s.slug}`
        await ctx.tx.update(claim).set({ status: closes, statusReason: reason }).where(eq(claim.id, to.id))
        await snapshot(run, to.id)
        run.homes.add(to.home)
      }
      return
    }
    case 'subject.relate': {
      const row = await claimBySlug(ctx, s.slug)
      const ends = []
      for (const end of [s.from, s.to]) {
        const found = await ctx.subjects.find(end.kind, end.name)
        if (!found || !(await ctx.sees(row.home, found.home))) {
          throw new Problem(409, `hubd:${end.kind}/${end.name} is not visible from claim ${s.slug}'s home`)
        }
        ends.push(found.id)
      }
      const [fromSubject = '', toSubject = ''] = ends
      if (fromSubject === toSubject) throw new Problem(400, 'A subject does not relate to itself')
      await ctx.tx.insert(subjectRelation).values({
        claimId: row.id,
        fromSubject,
        fromPath: s.from.path ?? '',
        relation: s.relation,
        toSubject,
        toPath: s.to.path ?? '',
      })
      run.homes.add(row.home)
      return
    }
    case 'check.add': {
      const row = await claimBySlug(ctx, s.slug)
      const runsOn = s.runsOn ? await ctx.subjects.find('asset', s.runsOn) : null
      if (s.runsOn && !runsOn) throw new Problem(404, `No asset "${s.runsOn}"`)
      await ctx.tx.insert(claimCheck).values({
        claimId: row.id,
        command: s.command,
        needs: s.needs,
        timeout: s.timeout,
        runsOn: runsOn?.id,
      })
      run.homes.add(row.home)
      return
    }
    case 'profile.set': {
      const space = await ctx.homeFor(s.space)
      if (!space || (await scopeOf(ctx, space)) !== space) throw new Problem(400, 'A profile belongs to a scope')
      const { step: _step, space: _space, ...fields } = s
      await ctx.tx
        .insert(profile)
        .values({ space, ...fields })
        .onConflictDoUpdate({ target: profile.space, set: fields })
      if (s.loadCap !== undefined) {
        run.budget.add(space)
        if (space === GLOBAL_SPACE) for (const scope of await inheritingScopes(ctx)) run.budget.add(scope)
      }
      run.homes.add(space)
      return
    }
    case 'subject.create': {
      const { step: _step, ...input } = s
      const made = await ctx.subjects.create(input)
      run.homes.add((await ctx.subjects.find(made.kind, made.name))?.home ?? null)
      return
    }
    case 'subject.rename':
      run.homes.add((await ctx.subjects.find(s.kind, s.name))?.home ?? null)
      await ctx.subjects.rename(s.kind, s.name, s.to, true)
      return
    case 'subject.alias':
      run.homes.add((await ctx.subjects.find(s.kind, s.name))?.home ?? null)
      await ctx.subjects.alias(s.kind, s.name, s.alias, s.remove, true)
      return
    case 'subject.merge':
      run.homes.add((await ctx.subjects.find(s.kind, s.from))?.home ?? null)
      run.homes.add((await ctx.subjects.find(s.kind, s.into))?.home ?? null)
      await ctx.subjects.merge(s.kind, s.from, s.into, true)
      return
    case 'subject.retire':
      run.homes.add((await ctx.subjects.find(s.kind, s.name))?.home ?? null)
      await ctx.subjects.retire(s.kind, s.name, true)
      return
    case 'subject.revive':
      await ctx.subjects.revive(s.kind, s.name, true)
      run.homes.add((await ctx.subjects.find(s.kind, s.name))?.home ?? null)
      return
  }
}
