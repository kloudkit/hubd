import { home } from '@hubd/sdk'
import { sql } from 'drizzle-orm'
import { pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core'

export const hello = pgSchema('hello')

export const greetings = hello.table('greetings', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull(),
  by: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  welcomedAt: timestamp({ withTimezone: true }),
})

export const notes = hello.table('notes', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  home: home(),
  text: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})
