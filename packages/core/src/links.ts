import {
  type Actor,
  actorId,
  type Link,
  type LinkInput,
  type Links,
  type PluginId,
  Problem,
  type RecordRef,
  type Scope,
  type SubjectKind,
  type Tx,
} from '@hubd/sdk'
import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { History } from './history.ts'
import { currentNames, NameTaken, resolveRecord, UUID } from './names.ts'
import type { Records } from './records.ts'
import { link, subject } from './schema.ts'
import { createSubject, resolveSubject, reviseSubject } from './subjects.ts'
import { type Eyes, eyesOfHome, visibleTo } from './visibility.ts'

const MENTION = /\bhubd:([a-z][a-z-]*)\/([A-Za-z0-9][\w.-]*)(\/[^\s)`'"\]>]+)?/g

type Row = typeof link.$inferInsert

type Mention = { start: number; end: number; kind: string; name: string; path?: string }

function mentions(text: string): Mention[] {
  return [...text.matchAll(MENTION)].map((m) => {
    const whole = (m[2] ?? '') + (m[3] ?? '')
    const clean = whole.replace(/[.,;:!?]+$/, '')
    const [name = '', ...rest] = clean.split('/')
    const start = m.index ?? 0
    const end = start + m[0].length - (whole.length - clean.length)
    return { start, end, kind: m[1] ?? '', name, ...(rest.length ? { path: rest.join('/') } : {}) }
  })
}

function rewrite(text: string, found: Mention[], to: (m: Mention) => string | null): string {
  let out = ''
  let at = 0
  for (const m of found) {
    const next = to(m)
    if (next === null) continue
    out += text.slice(at, m.start) + next
    at = m.end
  }
  return out + text.slice(at)
}

const ref = (kind: string, key: string, path?: string) => `hubd:${kind}/${key}${path ? `/${path}` : ''}`

const target = alias(subject, 'target')

const isSubject = (kind: string): kind is SubjectKind => kind === 'topic' || kind === 'asset'

function redirected(tx: Tx, ids: string[], eyes: Eyes, kind?: SubjectKind) {
  return tx
    .select({ from: subject.id, id: target.id, name: target.name })
    .from(subject)
    .innerJoin(target, eq(target.id, sql`coalesce(${subject.mergedInto}, ${subject.id})`))
    .where(and(inArray(subject.id, ids), kind ? eq(target.kind, kind) : undefined, visibleTo(eyes, target.home)))
}

export class LinkService implements Links {
  readonly #tx: Tx
  readonly #scope: Scope
  readonly #plugin: PluginId
  readonly #actor: Actor
  readonly #records: Records
  readonly #history: History

  constructor(tx: Tx, scope: Scope, plugin: PluginId, actor: Actor, records: Records, history: History) {
    this.#tx = tx
    this.#scope = scope
    this.#plugin = plugin
    this.#actor = actor
    this.#records = records
    this.#history = history
  }

  async set(from: RecordRef, input: LinkInput): Promise<{ lint: string[]; texts: string[]; created: string[] }> {
    const record = await this.#records.own(this.#tx, this.#plugin, from, this.#scope, 'links from it')
    const eyes = await eyesOfHome(this.#tx, record.home)
    const seen = new Map<string, Promise<string | null>>()
    const resolve = (kind: SubjectKind, name: string) => {
      const key = `${kind}:${name.toLowerCase()}`
      let found = seen.get(key)
      if (!found) {
        found = this.#subject(eyes, record.home, kind, name, lint, created)
        seen.set(key, found)
      }
      return found
    }
    const lint: string[] = []
    const created: string[] = []
    const rows: Row[] = []
    const base = { fromKind: from.kind, fromId: from.id }
    const texts: string[] = []
    for (const text of input.texts ?? []) {
      const found = mentions(text)
      const ids = new Map<Mention, string>()
      for (const m of found) {
        if (isSubject(m.kind)) {
          const id = await resolve(m.kind, m.name)
          if (!id) continue
          ids.set(m, id)
          rows.push({ ...base, kind: 'mentions', toSubject: id, path: m.path ?? null })
          continue
        }
        const kind = this.#records.byMention(m.kind)
        if (!kind) continue
        const id = await this.#record(eyes, kind, m.kind, m.name, lint)
        if (!id || (kind === from.kind && id === from.id)) continue
        ids.set(m, id)
        rows.push({ ...base, kind: 'mentions', toKind: kind, toId: id })
      }
      texts.push(rewrite(text, found, (m) => (ids.has(m) ? ref(m.kind, ids.get(m) as string, m.path) : null)))
    }
    for (const a of input.about ?? []) {
      const id = await resolve(a.kind, a.name)
      if (id) rows.push({ ...base, kind: 'about', toSubject: id, path: a.path ?? null })
    }
    for (const ref of input.refs ?? []) {
      if (ref.kind === from.kind && ref.id === from.id) {
        lint.push('a record cannot refer to itself')
        continue
      }
      if (await this.#records.home(this.#tx, ref, eyes))
        rows.push({ ...base, kind: 'ref', toKind: ref.kind, toId: ref.id })
      else lint.push(`${ref.kind} ${ref.id} is not visible from this record's home`)
    }
    await this.#tx.delete(link).where(and(eq(link.fromKind, from.kind), eq(link.fromId, from.id)))
    if (rows.length) await this.#tx.insert(link).values(rows).onConflictDoNothing()
    return { lint, texts, created }
  }

  async render(texts: string[]): Promise<string[]> {
    const found = texts.map(mentions)
    const byPrefix = new Map<string, string[]>()
    for (const m of found.flat()) {
      if (UUID.test(m.name)) byPrefix.set(m.kind, [...(byPrefix.get(m.kind) ?? []), m.name.toLowerCase()])
    }
    if (!byPrefix.size) return texts
    const names = new Map<string, string>()
    for (const [prefix, ids] of byPrefix) {
      if (isSubject(prefix)) {
        for (const r of await redirected(this.#tx, ids, this.#scope)) names.set(`${prefix}:${r.from}`, r.name)
        continue
      }
      const kind = this.#records.byMention(prefix)
      if (!kind) continue
      const seen = await this.#records.visible(this.#tx, kind, ids, this.#scope)
      for (const [id, n] of await currentNames(this.#tx, kind, [...seen.keys()])) names.set(`${prefix}:${id}`, n)
    }
    return texts.map((text, i) =>
      rewrite(text, found[i] ?? [], (m) => {
        const name = names.get(`${m.kind}:${m.name.toLowerCase()}`)
        return UUID.test(m.name) && name ? ref(m.kind, name, m.path) : null
      }),
    )
  }

  async #record(eyes: Eyes, kind: string, prefix: string, name: string, lint: string[]) {
    const id = UUID.test(name) ? name.toLowerCase() : await resolveRecord(this.#tx, kind, name, eyes)
    if (id && (await this.#records.home(this.#tx, { kind, id }, eyes))) return id
    lint.push(`hubd:${prefix}/${name} is not visible from this record's home`)
    return null
  }

  async #subject(eyes: Eyes, home: string | null, kind: SubjectKind, name: string, lint: string[], created: string[]) {
    if (UUID.test(name)) {
      const [row] = await redirected(this.#tx, [name.toLowerCase()], eyes, kind)
      if (!row) lint.push(`hubd:${kind}/${name} is not visible from this record's home`)
      return row?.id ?? null
    }
    const found = await resolveSubject(this.#tx, eyes, kind, name)
    if (found) return found.id
    try {
      const made = await this.#tx.transaction((savepoint) =>
        createSubject(savepoint, {
          kind,
          name,
          home,
          ...(kind === 'asset' ? { type: 'unknown' } : {}),
          createdBy: actorId(this.#actor),
        }),
      )
      await reviseSubject(this.#tx, this.#history, made.id)
      created.push(`hubd:${kind}/${name}`)
      return made.id
    } catch (e) {
      if (e instanceof NameTaken) lint.push(`hubd:${kind}/${name} is not visible from this record's home`)
      else if (e instanceof Problem && e.status === 400) lint.push(`hubd:${kind}/${name} is not a valid name`)
      else throw e
      return null
    }
  }

  async pointingAt(target: { subject: string }, fromKind: string) {
    return this.#tx
      .select({ id: link.fromId, kind: link.kind })
      .from(link)
      .where(and(eq(link.toSubject, target.subject), eq(link.fromKind, fromKind)))
  }

  async list(from: RecordRef): Promise<Link[]> {
    return (await this.listMany([from])).get(from.id) ?? []
  }

  async listMany(from: RecordRef[]): Promise<Map<string, Link[]>> {
    const out = new Map<string, Link[]>(from.map((f) => [f.id, []]))
    if (!from.length) return out
    const byKind = new Map<string, string[]>()
    for (const f of from) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f.id])
    const rows = await this.#tx
      .select({
        fromId: link.fromId,
        kind: link.kind,
        path: link.path,
        toKind: link.toKind,
        toId: link.toId,
        subjectId: subject.id,
        subjectKind: subject.kind,
        subjectName: subject.name,
        subjectVisible: visibleTo(this.#scope, subject.home).mapWith(Boolean),
      })
      .from(link)
      .leftJoin(subject, eq(subject.id, link.toSubject))
      .where(or(...[...byKind].map(([kind, ids]) => and(eq(link.fromKind, kind), inArray(link.fromId, ids)))))
    const targets = new Map<string, string[]>()
    for (const r of rows) if (r.toKind && r.toId) targets.set(r.toKind, [...(targets.get(r.toKind) ?? []), r.toId])
    const seen = new Set<string>()
    for (const [kind, ids] of targets) {
      for (const id of (await this.#records.visible(this.#tx, kind, ids, this.#scope)).keys()) seen.add(`${kind}:${id}`)
    }
    for (const r of rows) {
      const list = out.get(r.fromId)
      if (!list) continue
      if (r.subjectId && r.subjectKind && r.subjectName && r.subjectVisible) {
        list.push({
          kind: r.kind,
          path: r.path,
          to: { subject: { id: r.subjectId, kind: r.subjectKind, name: r.subjectName } },
        })
      } else if (r.toKind && r.toId && seen.has(`${r.toKind}:${r.toId}`)) {
        list.push({ kind: r.kind, path: r.path, to: { record: { kind: r.toKind, id: r.toId } } })
      }
    }
    return out
  }
}
