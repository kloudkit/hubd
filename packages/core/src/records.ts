import { type Db, type PluginId, Problem, type RecordKind, type RecordRef, type Tx } from '@hubd/sdk'
import { and, inArray, type SQL, sql } from 'drizzle-orm'
import { toSnakeCase } from 'drizzle-orm/casing'
import { type AnyPgColumn, getTableConfig } from 'drizzle-orm/pg-core'
import { recordKind } from './schema.ts'
import { type Eyes, visibleTo } from './visibility.ts'

type Registered = RecordKind & { key: string; plugin: PluginId; schema: string; tableName: string }

const KIND = /^[a-z][a-z0-9-]{0,39}$/
const KEY = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/

const columnName = (c: AnyPgColumn) => (c.keyAsName ? toSnakeCase(c.name) : c.name)

export class Records {
  readonly #kinds = new Map<string, Registered>()

  register(plugin: PluginId, kind: RecordKind): void {
    if (!KIND.test(kind.kind)) throw new Error(`record kind "${kind.kind}" must be lowercase letters, digits or dashes`)
    const key = `${plugin}.${kind.kind}`
    if (!KEY.test(key)) throw new Error(`record kind "${key}" needs a plugin id of lowercase letters, digits or dashes`)
    if (this.#kinds.has(key)) throw new Error(`record kind "${key}" is registered twice`)
    const { schema, name } = getTableConfig(kind.table)
    if (!schema || schema !== plugin) throw new Error(`record kind "${key}" must live in the "${plugin}" schema`)
    this.#kinds.set(key, { ...kind, key, plugin, schema, tableName: name })
  }

  owner(key: string): PluginId | null {
    return this.#kinds.get(key)?.plugin ?? null
  }

  async own(tx: Tx, plugin: PluginId, ref: RecordRef, eyes: Eyes, verb: string): Promise<{ home: string | null }> {
    if (this.owner(ref.kind) !== plugin) throw new Problem(403, `Only the plugin that registered "${ref.kind}" ${verb}`)
    const found = await this.home(tx, ref, eyes)
    if (!found) throw new Problem(404, `No ${ref.kind} ${ref.id}`)
    return found
  }

  async sync(db: Db): Promise<string[]> {
    for (const k of this.#kinds.values()) {
      await db
        .insert(recordKind)
        .values({ kind: k.key, plugin: k.plugin, tableName: `${k.schema}.${k.tableName}` })
        .onConflictDoUpdate({
          target: recordKind.kind,
          set: { plugin: k.plugin, tableName: `${k.schema}.${k.tableName}` },
        })
      await db.execute(
        sql`create or replace trigger hubd_drop_links after delete on ${k.table} for each row execute function hubd.drop_links(${sql.raw(`'${k.key}', '${columnName(k.id)}'`)})`,
      )
    }
    return [...this.#kinds.keys()]
  }

  byMention(prefix: string): string | null {
    for (const k of this.#kinds.values()) if (k.mention === prefix) return k.key
    return null
  }

  async homedIn(tx: Tx, spaces: string[]): Promise<string[]> {
    const homes = this.homesSql()
    if (!homes || !spaces.length) return []
    const rows = await tx.execute<{ id: string }>(
      sql`select h.id from (${homes}) h where h.home in (${sql.join(
        spaces.map((s) => sql`${s}::uuid`),
        sql`, `,
      )})`,
    )
    return rows.map((r) => r.id)
  }

  homesSql(): SQL | null {
    const parts = [...this.#kinds.values()].map(
      (k) => sql`select ${k.key}::text as kind, ${k.id} as id, ${k.home} as home from ${k.table}`,
    )
    return parts.length ? sql.join(parts, sql` union all `) : null
  }

  async home(tx: Tx, ref: RecordRef, eyes: Eyes): Promise<{ home: string | null } | null> {
    const found = await this.visible(tx, ref.kind, [ref.id], eyes)
    return found.get(ref.id) ?? null
  }

  async visible(tx: Tx, key: string, ids: string[], eyes: Eyes): Promise<Map<string, { home: string | null }>> {
    const k = this.#kinds.get(key)
    if (!k || !ids.length) return new Map()
    const rows = (await tx
      .select({ id: k.id, home: k.home })
      .from(k.table)
      .where(and(inArray(k.id, ids), visibleTo(eyes, k.home)))) as { id: string; home: string | null }[]
    return new Map(rows.map((r) => [r.id, { home: r.home }]))
  }
}
