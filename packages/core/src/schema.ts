import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

export const hubd = pgSchema('hubd')

const createdAt = () => timestamp({ withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp({ withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())

export const clients = hubd.table('clients', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull().unique(),
  hash: text().notNull().unique(),
  os: text(),
  arch: text(),
  createdAt: createdAt(),
  rotatedAt: timestamp({ withTimezone: true }),
  lastSeenAt: timestamp({ withTimezone: true }),
})

export const installCodes = hubd.table('install_codes', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  name: text().notNull(),
  hash: text().notNull().unique(),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

export const space = hubd.table(
  'space',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    kind: text({ enum: ['scope', 'project'] }).notNull(),
    name: text().notNull(),
    parent: uuid().references((): AnyPgColumn => space.id, { onDelete: 'restrict' }),
    description: text(),
    color: text(),
    isolated: boolean().notNull().default(false),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('space_name').on(t.parent, t.name).nullsNotDistinct(),
    check('space_kind', sql`${t.kind} in ('scope', 'project')`),
    check('space_project_has_parent', sql`(${t.kind} = 'project') = (${t.parent} is not null)`),
    check('space_isolated_scope', sql`${t.kind} = 'scope' or not ${t.isolated}`),
    check('space_archived_project', sql`${t.kind} = 'project' or ${t.archivedAt} is null`),
    check('space_global', sql`${t.name} <> 'global' or (${t.kind} = 'scope' and not ${t.isolated})`),
  ],
)

export const subject = hubd.table(
  'subject',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    kind: text({ enum: ['topic', 'asset'] }).notNull(),
    name: text().notNull(),
    home: uuid().references(() => space.id, { onDelete: 'restrict' }),
    summary: text(),
    type: text(),
    endpoint: text(),
    reachedBy: text(),
    createdBy: uuid().references(() => clients.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    retiredAt: timestamp({ withTimezone: true }),
    mergedInto: uuid().references((): AnyPgColumn => subject.id, { onDelete: 'restrict' }),
  },
  (t) => [
    index('subject_home').on(t.home),
    check('subject_kind', sql`${t.kind} in ('topic', 'asset')`),
    check(
      'subject_asset_fields',
      sql`${t.kind} = 'asset' or (${t.type} is null and ${t.endpoint} is null and ${t.reachedBy} is null)`,
    ),
    check('subject_asset_type', sql`${t.kind} = 'topic' or ${t.type} is not null`),
  ],
)

export const names = hubd.table(
  'name',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    kind: text().notNull(),
    subjectId: uuid().references(() => subject.id, { onDelete: 'cascade' }),
    recordId: uuid(),
    name: text().notNull(),
    domain: uuid().references(() => space.id, { onDelete: 'restrict' }),
    global: boolean().notNull().default(false),
    validFrom: timestamp({ withTimezone: true }).notNull().defaultNow(),
    validUntil: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('name_live')
      .on(t.kind, sql`coalesce(${t.domain}, '00000000-0000-0000-0000-000000000000')`, sql`lower(${t.name})`)
      .where(sql`${t.validUntil} is null`),
    index('name_subject').on(t.subjectId),
    index('name_record').on(t.kind, t.recordId),
    index('name_trgm').using('gin', sql`lower(${t.name}) gin_trgm_ops`),
    check('name_one_owner', sql`num_nonnulls(${t.subjectId}, ${t.recordId}) = 1`),
    check('name_subject_kind', sql`(${t.kind} in ('topic', 'asset')) = (${t.subjectId} is not null)`),
  ],
)

export const recordKind = hubd.table('record_kind', {
  kind: text().primaryKey(),
  plugin: text().notNull(),
  tableName: text().notNull(),
  createdAt: createdAt(),
})

export const link = hubd.table(
  'link',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    fromKind: text()
      .notNull()
      .references(() => recordKind.kind),
    fromId: uuid().notNull(),
    kind: text({ enum: ['about', 'mentions', 'ref'] }).notNull(),
    toSubject: uuid().references(() => subject.id, { onDelete: 'restrict' }),
    toKind: text().references(() => recordKind.kind),
    toId: uuid(),
    path: text(),
    createdAt: createdAt(),
  },
  (t) => [
    unique('link_unique').on(t.fromKind, t.fromId, t.kind, t.toSubject, t.toKind, t.toId, t.path).nullsNotDistinct(),
    index('link_to_subject').on(t.toSubject),
    index('link_to_record').on(t.toKind, t.toId),
    check('link_kind', sql`${t.kind} in ('about', 'mentions', 'ref')`),
    check('link_one_target', sql`num_nonnulls(${t.toSubject}, ${t.toId}) = 1`),
    check('link_record_pair', sql`(${t.toKind} is null) = (${t.toId} is null)`),
    check('link_about_subject', sql`${t.kind} <> 'about' or ${t.toSubject} is not null`),
    check('link_ref_record', sql`${t.kind} <> 'ref' or ${t.toId} is not null`),
  ],
)

export const content = hubd.table('content', {
  hash: text().primaryKey(),
  size: bigint({ mode: 'number' }).notNull(),
  mediaType: text().notNull(),
  createdAt: createdAt(),
})

export const attachment = hubd.table(
  'attachment',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    fromKind: text()
      .notNull()
      .references(() => recordKind.kind),
    fromId: uuid().notNull(),
    hash: text()
      .notNull()
      .references(() => content.hash, { onDelete: 'restrict' }),
    name: text().notNull(),
    createdBy: uuid().references(() => clients.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('attachment_from').on(t.fromKind, t.fromId), index('attachment_hash').on(t.hash)],
)

export const upload = hubd.table('upload', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  codeHash: text().notNull().unique(),
  fromKind: text()
    .notNull()
    .references(() => recordKind.kind),
  fromId: uuid().notNull(),
  name: text().notNull(),
  clientId: uuid().references(() => clients.id, { onDelete: 'cascade' }),
  isolatedTo: uuid().references(() => space.id, { onDelete: 'cascade' }),
  expiresAt: timestamp({ withTimezone: true }).notNull(),
  createdAt: createdAt(),
})

export const commit = hubd.table(
  'commit',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    at: createdAt(),
    actor: text().notNull(),
    clientId: uuid().references(() => clients.id, { onDelete: 'set null' }),
    session: text(),
    model: text(),
    operation: text().notNull(),
    reason: text(),
  },
  (t) => [index('commit_at').on(t.at), index('commit_session').on(t.session)],
)

export const revision = hubd.table(
  'revision',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    commitId: uuid()
      .notNull()
      .references(() => commit.id, { onDelete: 'cascade' }),
    kind: text().notNull(),
    targetId: uuid().notNull(),
    n: integer().notNull(),
    home: uuid().references(() => space.id, { onDelete: 'restrict' }),
    snapshot: jsonb(),
    baseline: boolean().notNull().default(false),
  },
  (t) => [uniqueIndex('revision_n').on(t.kind, t.targetId, t.n), index('revision_commit').on(t.commitId)],
)
