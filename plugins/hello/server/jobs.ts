import { defineEventHandler, defineJob } from '@hubd/sdk'
import { eq } from 'drizzle-orm'
import { greetings } from './schema.ts'

export const welcome = defineJob<{ id: string }>({
  name: 'welcome',
  options: { retryLimit: 3, retryBackoff: true },
  async run({ id }, { db, logger }) {
    await db.update(greetings).set({ welcomedAt: new Date() }).where(eq(greetings.id, id))
    logger.debug(`welcomed ${id}`)
  },
})

export const onTodoDone = defineEventHandler({
  event: 'todos.todo.done',
  async run({ id }, { db }) {
    await db.insert(greetings).values({ name: `done ${id}`, by: 'events' })
  },
})
