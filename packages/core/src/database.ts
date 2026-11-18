import type { Db, PluginModule } from '@hubd/sdk'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

type MigrationSet = { id: string; folder: URL }

export class Database {
  static readonly MIGRATIONS_SCHEMA = 'hubd_migrations'
  static readonly CORE: MigrationSet = { id: 'core', folder: new URL('../migrations/', import.meta.url) }

  readonly db: Db
  readonly #client: postgres.Sql

  constructor(url: string) {
    this.#client = postgres(url, { onnotice: () => {} })
    this.db = drizzle(this.#client, { casing: 'snake_case' })
  }

  async migrate(modules: PluginModule[]): Promise<string[]> {
    const sets = [
      Database.CORE,
      ...modules
        .filter((m) => m.manifest.database)
        .map((m) => ({ id: m.manifest.id, folder: new URL('migrations/', m.path) })),
    ]
    for (const set of sets) {
      await migrate(this.db, {
        migrationsFolder: set.folder.pathname,
        migrationsSchema: Database.MIGRATIONS_SCHEMA,
        migrationsTable: set.id,
      })
    }
    return sets.map((s) => s.id)
  }

  async ping(timeoutMs: number): Promise<number> {
    const started = performance.now()
    await Promise.race([
      this.db.execute(sql`select 1`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('database ping timed out')), timeoutMs).unref()),
    ])
    return Math.round(performance.now() - started)
  }

  close(): Promise<void> {
    return this.#client.end()
  }
}
