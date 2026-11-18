import { actorName, defineOperation } from '@hubd/sdk'
import { desc } from 'drizzle-orm'
import { createInsertSchema } from 'drizzle-zod'
import { z } from 'zod'
import type { HelloConfig } from './config.ts'
import { welcome } from './jobs.ts'
import { greetings } from './schema.ts'

const greetInput = createInsertSchema(greetings, {
  name: (s) => s.trim().min(1).max(100).describe('who to greet'),
}).pick({ name: true })

export const greet = (config: HelloConfig) =>
  defineOperation({
    id: 'greet',
    summary: 'Greet someone and remember it',
    description: 'Stores a greeting for the given name and queues its welcome.',
    input: greetInput.shape,
    http: { method: 'POST', path: '/greetings' },
    async run({ name }, { tx, actor, jobs }) {
      const [greeting] = await tx
        .insert(greetings)
        .values({ name, by: actorName(actor) })
        .returning()
      if (greeting) await jobs.send(welcome.name, { id: greeting.id })
      return { message: `${config.greeting}, ${name}!`, greeting }
    },
  })

export const list = defineOperation({
  id: 'list',
  summary: 'List the latest greetings',
  input: { limit: z.coerce.number().int().min(1).max(100).default(20).describe('how many, newest first') },
  http: { method: 'GET', path: '/greetings' },
  mcp: { readOnly: true },
  run: ({ limit }, { tx }) => tx.select().from(greetings).orderBy(desc(greetings.createdAt)).limit(limit),
})
