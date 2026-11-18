import {
  type Actor,
  actorId,
  actorName,
  type History as Contract,
  type Db,
  defineOperation,
  type Origin,
  type PluginId,
  Problem,
  type RecordRef,
  type RevisionView,
  type Tx,
} from '@hubd/sdk'
import { and, desc, eq, lt, type SQL, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { Records } from './records.ts'
import { commit, revision } from './schema.ts'
import { type Eyes, visibleTo } from './visibility.ts'

export const SUBJECT = 'core.subject'
export const SPACE = 'core.space'

export type Stamp = { actor: Actor; origin: Origin; operation: string }

const commitColumns = {
  id: commit.id,
  at: commit.at,
  actor: commit.actor,
  session: commit.session,
  model: commit.model,
  operation: commit.operation,
  reason: commit.reason,
}

const revisionColumns = {
  n: revision.n,
  baseline: revision.baseline,
  deleted: sql<boolean>`${revision.snapshot} is null`,
  commit: commitColumns,
}

const label = sql<string | null>`coalesce(case
  when ${revision.kind} = ${SUBJECT} then (select s.name from hubd.subject s where s.id = ${revision.targetId})
  when ${revision.kind} = ${SPACE} then (select case when hp.name is null then hs.name else hp.name || '/' || hs.name end
    from hubd.space hs left join hubd.space hp on hp.id = hs.parent where hs.id = ${revision.targetId})
  else (select n.name from hubd.name n where n.record_id = ${revision.targetId} and n.valid_until is null
    order by n.valid_from desc limit 1) end,
  ${revision.snapshot} ->> 'title')`

const of = (target: RecordRef): SQL => and(eq(revision.kind, target.kind), eq(revision.targetId, target.id)) as SQL

export class History implements Contract {
  readonly #tx: Tx
  readonly #eyes: Eyes
  readonly #stamp: Stamp
  readonly #plugin: PluginId | null
  readonly #records: Records | null
  readonly #shared: { id: string | null }

  constructor(
    tx: Tx,
    eyes: Eyes,
    stamp: Stamp,
    owner: { plugin: PluginId; records: Records } | null = null,
    shared: { id: string | null } = { id: null },
  ) {
    this.#tx = tx
    this.#eyes = eyes
    this.#stamp = stamp
    this.#plugin = owner?.plugin ?? null
    this.#records = owner?.records ?? null
    this.#shared = shared
  }

  core(): History {
    return new History(this.#tx, this.#eyes, this.#stamp, null, this.#shared)
  }

  async #current(): Promise<string> {
    const cached = this.#shared.id
    if (cached) {
      const [kept] = await this.#tx.select({ id: commit.id }).from(commit).where(eq(commit.id, cached))
      if (kept) return cached
    }
    const { actor, origin, operation } = this.#stamp
    const [made] = await this.#tx
      .insert(commit)
      .values({ actor: actorName(actor), clientId: actorId(actor), ...origin, operation })
      .returning({ id: commit.id })
    if (!made) throw new Error('commit was not stored')
    this.#shared.id = made.id
    return made.id
  }

  async commit(reason?: string): Promise<string> {
    const id = await this.#current()
    if (reason) await this.#tx.update(commit).set({ reason }).where(eq(commit.id, id))
    return id
  }

  async record(target: RecordRef, home: string | null, snapshot: object | null): Promise<number> {
    if (this.#plugin && this.#records?.owner(target.kind) !== this.#plugin) {
      throw new Problem(403, `Only the plugin that registered "${target.kind}" records its revisions`)
    }
    const id = await this.#current()
    const [row] = await this.#tx.execute<{
      n: number
    }>(sql`insert into hubd.revision (commit_id, kind, target_id, n, home, snapshot)
      select ${id}::uuid, ${target.kind}, ${target.id}::uuid, coalesce(max(r.n), 0) + 1, ${home}::uuid, ${snapshot === null ? null : JSON.stringify(snapshot)}::jsonb
      from hubd.revision r where r.kind = ${target.kind} and r.target_id = ${target.id}::uuid
      returning n`)
    return Number(row?.n)
  }

  revisions(target: RecordRef): Promise<RevisionView[]> {
    return this.#tx
      .select(revisionColumns)
      .from(revision)
      .innerJoin(commit, eq(commit.id, revision.commitId))
      .where(and(of(target), visibleTo(this.#eyes, revision.home)))
      .orderBy(desc(revision.n))
  }

  async snapshot(target: RecordRef, n: number) {
    const [row] = await this.#tx
      .select({ ...revisionColumns, snapshot: revision.snapshot })
      .from(revision)
      .innerJoin(commit, eq(commit.id, revision.commitId))
      .where(and(of(target), eq(revision.n, n), visibleTo(this.#eyes, revision.home)))
    return row ? { ...row, snapshot: row.snapshot as object | null } : null
  }
}

export async function rehome(tx: Tx, target: RecordRef, home: string | null): Promise<void> {
  await tx.update(revision).set({ home }).where(of(target))
}

export async function squash(db: Db, days: number): Promise<{ dropped: number; commits: number }> {
  return db.transaction(async (tx) => {
    const cutoff = new Date(Date.now() - days * 86_400_000)
    const old = sql`select r.id, r.kind, r.target_id, row_number() over (partition by r.kind, r.target_id order by r.n desc) as k
      from hubd.revision r join hubd.commit c on c.id = r.commit_id where c.at < ${cutoff.toISOString()}::timestamptz`
    await tx.execute(sql`update hubd.revision set baseline = true where id in (
      select o.id from (${old}) o where o.k = 1 and exists (select 1 from (${old}) e where e.kind = o.kind and e.target_id = o.target_id and e.k > 1))`)
    const dropped = await tx.execute(
      sql`delete from hubd.revision where id in (select o.id from (${old}) o where o.k > 1)`,
    )
    const emptied = await tx
      .delete(commit)
      .where(
        and(lt(commit.at, cutoff), sql`not exists (select 1 from hubd.revision r where r.commit_id = ${commit.id})`),
      )
      .returning({ id: commit.id })
    return { dropped: dropped.count ?? 0, commits: emptied.length }
  })
}

const target = { kind: z.string().min(3).max(60).describe('estate.claim, core.subject, core.space, ...'), id: z.uuid() }

export const historyOperations = [
  defineOperation({
    id: 'history.list',
    summary: 'Recent commits, or the revisions of one record',
    description:
      "Every write is one commit: who made it (client, Claude session, model), the operation and when, with a numbered revision of each claim, instruction, subject and space it changed. Lists only revisions this session can see and counts the rest. With kind and id, that record's revisions instead.",
    input: {
      kind: target.kind.optional(),
      id: target.id.optional(),
      session: z.string().max(100).optional().describe('only commits made from this Claude session'),
      before: z.iso.datetime().optional().describe('only commits before this time, for the next page'),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    },
    http: { method: 'GET', path: '/history' },
    mcp: { name: 'history_list', readOnly: true },
    async run({ kind, id, session, before, limit }, { tx, scope, history }) {
      if (kind && id) return { revisions: await history.revisions({ kind, id }) }
      if (kind || id) throw new Problem(400, 'Give both kind and id, or neither')
      const seen = visibleTo(scope, revision.home)
      const rows = await tx
        .select({
          ...commitColumns,
          revisions: sql<
            { kind: string; id: string; n: number; name: string | null }[]
          >`coalesce(json_agg(json_build_object(
            'kind', ${revision.kind}, 'id', ${revision.targetId}, 'n', ${revision.n}, 'name', ${label}) order by ${revision.kind}, ${revision.n})
            filter (where ${seen}), '[]')`,
          hidden: sql<number>`(count(*) filter (where not ${seen}))::int`,
        })
        .from(commit)
        .innerJoin(revision, eq(revision.commitId, commit.id))
        .where(
          and(session ? eq(commit.session, session) : undefined, before ? lt(commit.at, new Date(before)) : undefined),
        )
        .groupBy(commit.id)
        .having(sql`count(*) filter (where ${seen}) > 0`)
        .orderBy(desc(commit.at))
        .limit(limit)
      return { commits: rows }
    },
  }),
  defineOperation({
    id: 'history.get',
    summary: 'One commit with its revisions, or one revision as it was',
    description: 'With commit, what it changed that this session can see; with kind, id and n, that revision whole.',
    input: {
      commit: z.uuid().optional(),
      kind: target.kind.optional(),
      id: target.id.optional(),
      n: z.coerce.number().int().min(1).optional(),
    },
    http: { method: 'GET', path: '/history/get' },
    mcp: { name: 'history_get', readOnly: true },
    async run(a, { tx, scope, history }) {
      if (a.kind && a.id && a.n) {
        const found = await history.snapshot({ kind: a.kind, id: a.id }, a.n)
        if (!found) throw new Problem(404, `No revision ${a.n} of ${a.kind} ${a.id}`)
        return found
      }
      if (!a.commit) throw new Problem(400, 'Give commit, or kind, id and n')
      const seen = visibleTo(scope, revision.home)
      const [made] = await tx.select(commitColumns).from(commit).where(eq(commit.id, a.commit))
      const rows = made
        ? await tx
            .select({
              kind: revision.kind,
              id: revision.targetId,
              n: revision.n,
              name: label,
              baseline: revision.baseline,
              snapshot: revision.snapshot,
              seen: sql<boolean>`${seen}`,
            })
            .from(revision)
            .where(eq(revision.commitId, a.commit))
            .orderBy(revision.kind, revision.n)
        : []
      const shown = rows.filter((r) => r.seen).map(({ seen: _seen, ...r }) => r)
      if (!made || !shown.length) throw new Problem(404, `No commit ${a.commit}`)
      return { ...made, revisions: shown, hidden: rows.length - shown.length }
    },
  }),
]
