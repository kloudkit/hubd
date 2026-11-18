import { defineJob } from '@hubd/sdk'
import { and, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { todo } from './schema.ts'

type Remind = { id: string; at: string; snooze?: boolean }

export const remind = defineJob<Remind>({
  name: 'remind',
  async run({ id, at, snooze }, { db, events }) {
    const when = new Date(at)
    const [row] = await db
      .select({ id: todo.id, home: todo.home })
      .from(todo)
      .where(
        and(
          eq(todo.id, id),
          isNull(todo.doneAt),
          snooze ? eq(todo.remindSnoozeUntil, when) : eq(todo.remindAt, when),
          snooze ? sql`true` : sql`(${todo.remindSnoozeUntil} is null or ${todo.remindSnoozeUntil} <= now())`,
        ),
      )
    if (row) await events.publish('reminder.due', { id: row.id, home: row.home })
  },
})

export const purgeDone = (days: number) =>
  defineJob({
    name: 'purge-done',
    async run(_data, { db, logger }) {
      const cutoff = new Date(Date.now() - days * 86_400_000)
      const gone = await db
        .delete(todo)
        .where(and(isNotNull(todo.doneAt), lt(todo.doneAt, cutoff)))
        .returning({ id: todo.id })
      if (gone.length) logger.info(`deleted ${gone.length} todos done before ${cutoff.toISOString()}`)
    },
  })
