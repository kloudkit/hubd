import {
  type Actor,
  type Attachment,
  type Attachments,
  actorId,
  type Db,
  type FileInput,
  type PluginId,
  Problem,
  type RecordRef,
  type Scope,
  type Tx,
} from '@hubd/sdk'
import { and, asc, eq, gt, lt, notExists, or, sql } from 'drizzle-orm'
import { fileTypeFromBuffer } from 'file-type'
import { CODE_TTL_MS, oneTimeCode, sha256 } from './codes.ts'
import type { Records } from './records.ts'
import { attachment, content, upload } from './schema.ts'
import { fileKey, type Store } from './storage.ts'
import type { Eyes } from './visibility.ts'

const INLINE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']
const CHECK_MS = 60_000
const KEEP_UNREFERENCED_MS = 86_400_000
const MiB = 1024 * 1024

const mib = (n: number) => `${Math.round((n / MiB) * 10) / 10} MiB`

function cleanName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ''
  return (
    base
      .replace(/\p{Cc}/gu, '')
      .trim()
      .slice(0, 200) || 'file'
  )
}

async function sniff(bytes: Uint8Array, declared = '') {
  const found = await fileTypeFromBuffer(bytes)
  if (found) return found.mime
  const d = (declared.split(';')[0] ?? '').trim().toLowerCase()
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(d) && !INLINE.includes(d) ? d : 'application/octet-stream'
}

const lock = (tx: Tx, digest: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`content:${digest}`}, 0))`)

const meta = {
  id: attachment.id,
  name: attachment.name,
  type: content.mediaType,
  size: content.size,
  createdAt: attachment.createdAt,
}

export class Contents {
  readonly #db: Db
  readonly #store: Store | null
  readonly #records: Records
  readonly #base: string
  readonly maxBytes: number
  #checked: { at: number; reason: string | null } | null = null

  constructor(db: Db, store: Store | null, records: Records, options: { maxBytes: number; base: string }) {
    this.#db = db
    this.#store = store
    this.#records = records
    this.maxBytes = options.maxBytes
    this.#base = options.base.replace(/\/+$/, '')
  }

  async status(now = Date.now()): Promise<{ on: boolean; reason: string | null; where: string | null }> {
    if (!this.#store)
      return { on: false, reason: 'no storage is set (HUBD_STORAGE_DIR or HUBD_S3_BUCKET)', where: null }
    if (!this.#checked || now - this.#checked.at > CHECK_MS) {
      this.#checked = { at: now, reason: await this.#store.check() }
    }
    return { on: this.#checked.reason === null, reason: this.#checked.reason, where: this.#store.where }
  }

  async #storeOn(): Promise<Store> {
    const st = await this.status()
    if (!st.on || !this.#store) throw new Problem(503, `Attachments are off: ${st.reason}`)
    return this.#store
  }

  async add(tx: Tx, from: RecordRef, file: FileInput, by: string | null, limit = this.maxBytes): Promise<Attachment> {
    const store = await this.#storeOn()
    if (!file.bytes.byteLength) throw new Problem(400, 'The file is empty')
    if (file.bytes.byteLength > limit) {
      throw new Problem(413, `A file here is at most ${mib(limit)}; this one is ${mib(file.bytes.byteLength)}`)
    }
    const digest = sha256(file.bytes)
    const mediaType = await sniff(file.bytes, file.type)
    await lock(tx, digest)
    await tx.insert(content).values({ hash: digest, size: file.bytes.byteLength, mediaType }).onConflictDoNothing()
    if (!(await store.has(fileKey(digest)))) await store.put(fileKey(digest), file.bytes)
    const [row] = await tx
      .insert(attachment)
      .values({ fromKind: from.kind, fromId: from.id, hash: digest, name: cleanName(file.name), createdBy: by })
      .returning({ id: attachment.id })
    if (!row) throw new Error('attachment was not stored')
    const [out] = await tx
      .select(meta)
      .from(attachment)
      .innerJoin(content, eq(content.hash, attachment.hash))
      .where(eq(attachment.id, row.id))
    return out as Attachment
  }

  list(tx: Tx, from: RecordRef): Promise<Attachment[]> {
    return tx
      .select(meta)
      .from(attachment)
      .innerJoin(content, eq(content.hash, attachment.hash))
      .where(and(eq(attachment.fromKind, from.kind), eq(attachment.fromId, from.id)))
      .orderBy(asc(attachment.createdAt))
  }

  async open(id: string, scope: Scope) {
    const store = await this.#storeOn()
    const found = await this.#db.transaction(async (tx) => {
      const [row] = await tx
        .select({ ...meta, fromKind: attachment.fromKind, fromId: attachment.fromId, hash: attachment.hash })
        .from(attachment)
        .innerJoin(content, eq(content.hash, attachment.hash))
        .where(eq(attachment.id, id))
      if (!row) return null
      const seen = await this.#records.home(tx, { kind: row.fromKind, id: row.fromId }, scope)
      return seen ? row : null
    })
    if (!found) throw new Problem(404, 'No such attachment')
    const body = await store.get(fileKey(found.hash))
    if (!body) throw new Problem(404, `Attachment ${found.name} has no content in storage`)
    return { file: found, body, inline: INLINE.includes(found.type) }
  }

  async uploadUrl(tx: Tx, from: RecordRef, name: string, scope: Scope, actor: Actor) {
    await this.#storeOn()
    const code = oneTimeCode()
    const expiresAt = new Date(Date.now() + CODE_TTL_MS)
    await tx.insert(upload).values({
      codeHash: sha256(code),
      fromKind: from.kind,
      fromId: from.id,
      name: cleanName(name),
      clientId: actorId(actor),
      isolatedTo: scope.mode === 'isolated' ? scope.space : null,
      expiresAt,
    })
    const url = `${this.#base}/upload/${code}`
    return { url, expiresAt, command: `curl -fsS -T '<file>' '${url}'` }
  }

  consume(code: string, bytes: Uint8Array, type?: string): Promise<Attachment> {
    return this.#db.transaction(async (tx) => {
      const [used] = await tx
        .delete(upload)
        .where(and(eq(upload.codeHash, sha256(code)), gt(upload.expiresAt, new Date())))
        .returning()
      if (!used) throw new Problem(401, 'This upload link is unknown, used or expired')
      const from = { kind: used.fromKind, id: used.fromId }
      const eyes: Eyes = used.isolatedTo ? { mode: 'isolated', space: used.isolatedTo } : { mode: 'open' }
      if (!(await this.#records.home(tx, from, eyes))) throw new Problem(404, 'The record this upload was for is gone')
      return this.add(tx, from, { name: used.name, bytes, type }, used.clientId)
    })
  }

  async sweep(now = Date.now()): Promise<number> {
    await this.#db.delete(upload).where(lt(upload.expiresAt, new Date(now)))
    if (!this.#store || !(await this.status(now)).on) return 0
    const unreferenced = notExists(
      this.#db.select({ one: sql`1` }).from(attachment).where(eq(attachment.hash, content.hash)),
    )
    const stale = await this.#db
      .select({ hash: content.hash })
      .from(content)
      .where(and(lt(content.createdAt, new Date(now - KEEP_UNREFERENCED_MS)), unreferenced))
    let gone = 0
    for (const { hash: digest } of stale) {
      await this.#db.transaction(async (tx) => {
        await lock(tx, digest)
        const dropped = await tx
          .delete(content)
          .where(and(eq(content.hash, digest), unreferenced))
          .returning()
        if (!dropped.length) return
        gone++
        await this.#store?.remove(fileKey(digest))
      })
    }
    return gone
  }

  bind(tx: Tx, plugin: PluginId, scope: Scope, actor: Actor): Attachments {
    const own = (from: RecordRef) => this.#records.own(tx, plugin, from, scope, 'attaches to it')
    return {
      add: async (from, file, options) => {
        await own(from)
        return this.add(tx, from, file, actorId(actor), options?.maxBytes)
      },
      list: (from) => this.list(tx, from),
      listMany: async (from) => {
        const out = new Map<string, Attachment[]>(from.map((f) => [f.id, []]))
        if (!from.length) return out
        const rows = await tx
          .select({ ...meta, fromId: attachment.fromId })
          .from(attachment)
          .innerJoin(content, eq(content.hash, attachment.hash))
          .where(or(...from.map((f) => and(eq(attachment.fromKind, f.kind), eq(attachment.fromId, f.id)))))
          .orderBy(asc(attachment.createdAt))
        for (const { fromId, ...a } of rows) out.get(fromId)?.push(a)
        return out
      },
      uploadUrl: async (from, name) => {
        await own(from)
        return this.uploadUrl(tx, from, name, scope, actor)
      },
    }
  }
}
