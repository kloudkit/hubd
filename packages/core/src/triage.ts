import { defineOperation } from '@hubd/sdk'
import { and, asc, isNull, sql } from 'drizzle-orm'
import type { Records } from './records.ts'
import { subject } from './schema.ts'
import { Places, visibleTo } from './visibility.ts'
import { edges, FROM_HOME } from './world.ts'

export const triageOperations = (records: Records) => [
  defineOperation({
    id: 'triage.list',
    summary: 'What needs tidying: links that cross isolation, and unassigned subjects and records',
    description:
      'Each finding is listed only to sessions that see the record or subject it is about; an end this session cannot see is reported without its name.',
    input: {},
    http: { method: 'GET', path: '/triage' },
    mcp: { name: 'triage_list', readOnly: true },
    async run(_, { tx, scope }) {
      const places = new Places(tx)
      const linked = await edges(tx, records, visibleTo(scope, FROM_HOME))
      await places.load(linked.flatMap((e) => [e.fromHome, e.toHome]))
      const crossing = []
      for (const e of linked) {
        if (await places.sees(await places.eyes(e.fromHome), e.toHome)) continue
        const shown = await places.sees(scope, e.toHome)
        crossing.push({
          from: { kind: e.fromKind, id: e.fromId },
          to: shown
            ? e.toSubject
              ? { subject: { kind: e.subjectKind, name: e.subjectName } }
              : { record: { kind: e.toKind, id: e.toId } }
            : 'something this session cannot see',
        })
      }
      const unassignedSubjects =
        scope.mode === 'open'
          ? await tx
              .select({ kind: subject.kind, name: subject.name, createdAt: subject.createdAt })
              .from(subject)
              .where(and(isNull(subject.home), isNull(subject.retiredAt)))
              .orderBy(asc(subject.createdAt))
          : []
      const homes = records.homesSql()
      const unassignedRecords =
        scope.mode === 'open' && homes
          ? await tx.execute<{ kind: string; id: string }>(
              sql`select h.kind, h.id from (${homes}) h where h.home is null order by h.id`,
            )
          : []
      return {
        crossing,
        unassigned: { subjects: unassignedSubjects, records: [...unassignedRecords] },
      }
    },
  }),
]
