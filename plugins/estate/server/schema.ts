import { home } from '@hubd/sdk'
import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

export const TYPES = ['Fact', 'Trap', 'Rule', 'Question', 'KnownIssue', 'Intent'] as const
export const LOADINGS = ['on-request', 'always'] as const
export const STATUSES = ['current', 'superseded', 'retracted', 'resolved'] as const
export const STRENGTHS = ['must', 'should', 'prefer'] as const
export const CLAIM_RELATIONS = ['relies-on', 'supersedes', 'contradicts', 'answers'] as const
export const SUBJECT_RELATIONS = ['part-of', 'depends-on'] as const
export const SOURCE_KINDS = ['url', 'file', 'person', 'command'] as const
export const OUTCOMES = ['holds', 'contradicted', 'could-not-run'] as const
export const BY = ['check', 'user', 'agent'] as const
export const SUGGESTION_STATES = ['pending', 'accepted', 'rejected'] as const

const commitRef = pgSchema('hubd').table('commit', { id: uuid().primaryKey() })

const tsvector = customType<{ data: string }>({ dataType: () => 'tsvector' })
const stamp = () => timestamp({ withTimezone: true })
const created = () => stamp().notNull().defaultNow()

export const estate = pgSchema('estate')

export const claim = estate.table(
  'claim',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    home: home(),
    type: text({ enum: TYPES }).notNull(),
    statement: text().notNull(),
    detail: text().notNull().default(''),
    strength: text({ enum: STRENGTHS }),
    loading: text({ enum: LOADINGS }).notNull().default('on-request'),
    status: text({ enum: STATUSES }).notNull().default('current'),
    statusReason: text(),
    reconfirmAt: stamp(),
    reviewDays: integer(),
    contradictedAt: stamp(),
    trueFrom: stamp(),
    trueUntil: stamp(),
    revision: integer().notNull().default(1),
    createdAt: created(),
    updatedAt: created(),
    search: tsvector().generatedAlwaysAs(
      sql`setweight(to_tsvector('english', statement), 'A') || setweight(to_tsvector('english', detail), 'D')`,
    ),
  },
  (t) => [
    index('claim_home_status').on(t.home, t.status),
    index('claim_reconfirm').on(t.reconfirmAt).where(sql`${t.status} = 'current'`),
    index('claim_search').using('gin', t.search),
    index('claim_always').on(t.home).where(sql`${t.loading} = 'always'`),
    check('claim_strength', sql`${t.strength} is null or ${t.type} = 'Rule'`),
    check('claim_reason', sql`${t.status} = 'current' or ${t.statusReason} is not null`),
    check('claim_statement', sql`length(btrim(${t.statement})) > 0`),
  ],
)

export const suggestion = estate.table(
  'suggestion',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    author: text().notNull(),
    clientId: uuid(),
    scope: uuid(),
    homes: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    unassigned: boolean().notNull().default(false),
    state: text({ enum: SUGGESTION_STATES }).notNull().default('pending'),
    reason: text().notNull().default(''),
    steps: jsonb().notNull(),
    lint: jsonb().$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    session: text(),
    model: text(),
    createdAt: created(),
    decidedAt: stamp(),
    decidedBy: text(),
    commitId: uuid().references((): AnyPgColumn => commitRef.id, { onDelete: 'set null' }),
  },
  (t) => [index('suggestion_pending').on(t.createdAt).where(sql`${t.state} = 'pending'`)],
)

export const source = estate.table('source', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  home: home(),
  kind: text({ enum: SOURCE_KINDS }).notNull(),
  ref: text().notNull(),
  capturedAt: created(),
})

export const claimSource = estate.table(
  'claim_source',
  {
    claimId: uuid()
      .notNull()
      .references(() => claim.id, { onDelete: 'cascade' }),
    sourceId: uuid()
      .notNull()
      .references(() => source.id),
    locator: text(),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.sourceId] })],
)

export const claimCheck = estate.table('check', {
  id: uuid().primaryKey().default(sql`uuidv7()`),
  claimId: uuid()
    .notNull()
    .references(() => claim.id, { onDelete: 'cascade' }),
  command: text().notNull(),
  needs: text().array().notNull().default(sql`'{}'::text[]`),
  timeout: integer(),
  runsOn: uuid(),
})

export const verification = estate.table(
  'verification',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    claimId: uuid()
      .notNull()
      .references(() => claim.id, { onDelete: 'cascade' }),
    checkId: uuid().references(() => claimCheck.id, { onDelete: 'set null' }),
    revision: integer().notNull(),
    by: text({ enum: BY }).notNull(),
    reporter: text().notNull(),
    ranOn: uuid(),
    outcome: text({ enum: OUTCOMES }).notNull(),
    since: created(),
    lastSeen: created(),
    note: text(),
  },
  (t) => [index('verification_claim').on(t.claimId, t.lastSeen)],
)

export const claimRelation = estate.table(
  'claim_relation',
  {
    fromClaim: uuid()
      .notNull()
      .references(() => claim.id, { onDelete: 'cascade' }),
    relation: text({ enum: CLAIM_RELATIONS }).notNull(),
    toClaim: uuid()
      .notNull()
      .references(() => claim.id),
  },
  (t) => [
    primaryKey({ columns: [t.fromClaim, t.relation, t.toClaim] }),
    check('claim_relation_not_self', sql`${t.fromClaim} <> ${t.toClaim}`),
  ],
)

export const subjectRelation = estate.table(
  'subject_relation',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    claimId: uuid()
      .notNull()
      .references(() => claim.id, { onDelete: 'cascade' }),
    fromSubject: uuid().notNull(),
    fromPath: text().notNull().default(''),
    relation: text({ enum: SUBJECT_RELATIONS }).notNull(),
    toSubject: uuid().notNull(),
    toPath: text().notNull().default(''),
  },
  (t) => [
    index('subject_relation_to').on(t.toSubject),
    check('subject_relation_not_self', sql`${t.fromSubject} <> ${t.toSubject}`),
  ],
)

export const instruction = estate.table(
  'instruction',
  {
    id: uuid().primaryKey().default(sql`uuidv7()`),
    home: home(),
    title: text().notNull(),
    body: text().notNull(),
    enabled: boolean().notNull().default(true),
    machines: text().array(),
    position: integer().notNull().default(0),
    revision: integer().notNull().default(1),
    createdBy: text().notNull(),
    createdAt: created(),
    updatedAt: created(),
  },
  (t) => [
    index('instruction_home').on(t.home, t.position),
    check('instruction_machines', sql`${t.machines} is null or cardinality(${t.machines}) > 0`),
  ],
)

export const profile = estate.table('profile', {
  space: home().primaryKey(),
  voice: text(),
  style: text(),
  loadCap: integer(),
})
