import { randomBytes } from 'node:crypto'
import { type Actor, type Db, Problem, type Tx } from '@hubd/sdk'
import { and, eq, gt, lt } from 'drizzle-orm'
import { CODE_TTL_MS, oneTimeCode, sha256 } from './codes.ts'
import { clients, installCodes } from './schema.ts'

export type Machine = { os?: string; arch?: string }

export class Clients {
  static readonly NAME = /^[\w.@-]{1,40}$/
  static readonly CODE = /^[A-Za-z0-9_-]{24}$/
  static readonly TOUCH_MS = 60_000

  readonly #db: Db

  constructor(db: Db) {
    this.#db = db
  }

  async #assertFree(name: string): Promise<void> {
    if (!Clients.NAME.test(name)) {
      throw new Problem(400, 'A name is 1 to 40 letters, digits, dots, dashes, underscores or @')
    }
    const [taken] = await this.#db.select({ id: clients.id }).from(clients).where(eq(clients.name, name))
    if (taken) throw new Problem(409, `A client named "${name}" exists; revoke it first`)
  }

  async create(
    name: string,
    machine: Machine = {},
    db: Db | Tx = this.#db,
  ): Promise<{ id: string; name: string; token: string }> {
    await this.#assertFree(name)
    const token = `hubd_${randomBytes(32).toString('base64url')}`
    const [row] = await db
      .insert(clients)
      .values({ name, hash: sha256(token), ...machine })
      .returning({ id: clients.id })
    if (!row) throw new Error('token was not stored')
    return { id: row.id, name, token }
  }

  list() {
    return this.#db
      .select({
        id: clients.id,
        name: clients.name,
        os: clients.os,
        arch: clients.arch,
        createdAt: clients.createdAt,
        lastSeenAt: clients.lastSeenAt,
      })
      .from(clients)
      .orderBy(clients.name)
  }

  async revoke(name: string): Promise<boolean> {
    return (await this.#db.delete(clients).where(eq(clients.name, name)).returning({ id: clients.id })).length > 0
  }

  async verify(token: string): Promise<Actor | null> {
    const [row] = await this.#db
      .select({ id: clients.id, name: clients.name, lastSeenAt: clients.lastSeenAt })
      .from(clients)
      .where(eq(clients.hash, sha256(token)))
    if (!row) return null
    if (!row.lastSeenAt || Date.now() - row.lastSeenAt.getTime() > Clients.TOUCH_MS) {
      await this.#db.update(clients).set({ lastSeenAt: new Date() }).where(eq(clients.id, row.id))
    }
    return { kind: 'client', id: row.id, name: row.name }
  }

  async invite(name: string): Promise<{ code: string; expiresAt: Date }> {
    await this.#assertFree(name)
    const code = oneTimeCode()
    const expiresAt = new Date(Date.now() + CODE_TTL_MS)
    await this.#db.delete(installCodes).where(lt(installCodes.expiresAt, new Date()))
    await this.#db.insert(installCodes).values({ name, hash: sha256(code), expiresAt })
    return { code, expiresAt }
  }

  enroll(code: string, machine: Machine = {}): Promise<{ name: string; token: string } | null> {
    return this.#db.transaction(async (tx) => {
      const [used] = await tx
        .delete(installCodes)
        .where(and(eq(installCodes.hash, sha256(code)), gt(installCodes.expiresAt, new Date())))
        .returning({ name: installCodes.name })
      if (!used) return null
      const { name, token } = await this.create(used.name, machine, tx)
      return { name, token }
    })
  }
}
