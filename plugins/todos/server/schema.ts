import { home } from '@hubd/sdk'
import { sql } from 'drizzle-orm'
import {
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

export const STATUSES = ['todo', 'doing', 'blocked', 'waiting'] as const
export const PRIORITIES = ['p1', 'p2', 'p3', 'p4'] as const

export const todosSchema = pgSchema('todos')

export type TodoUrl = { url: string; title?: string }

export const todo = todosSchema.table(
  'todo',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    home: home(),
    title: text().notNull(),
    body: text().notNull().default(''),
    status: text({ enum: STATUSES }).notNull().default('todo'),
    priority: text({ enum: PRIORITIES }).notNull().default('p3'),
    due: date({ mode: 'string' }),
    session: text(),
    createdBy: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    doneAt: timestamp({ withTimezone: true }),
    remindAt: timestamp({ withTimezone: true }),
    remindReadAt: timestamp({ withTimezone: true }),
    remindSnoozeUntil: timestamp({ withTimezone: true }),
    urls: jsonb().$type<TodoUrl[]>().notNull().default(sql`'[]'::jsonb`),
    version: integer().notNull().default(1),
  },
  (t) => [
    index('todo_remind').on(t.remindAt).where(sql`${t.remindAt} is not null and ${t.doneAt} is null`),
    index('todo_done').on(t.doneAt).where(sql`${t.doneAt} is not null`),
  ],
)

export const label = todosSchema.table('label', {
  name: text().primaryKey(),
  color: text().notNull(),
})

export const todoLabel = todosSchema.table(
  'todo_label',
  {
    todoId: uuid().notNull(),
    label: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.todoId, t.label] }),
    foreignKey({ columns: [t.todoId], foreignColumns: [todo.id] }).onDelete('cascade'),
    foreignKey({ columns: [t.label], foreignColumns: [label.name] })
      .onDelete('cascade')
      .onUpdate('cascade'),
  ],
)
