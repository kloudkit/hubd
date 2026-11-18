import { defineOperation, GLOBAL_SPACE, inputs, type OperationContext } from '@hubd/sdk'
import { and, asc, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import { DEFAULT_LOAD_CAP, loadedSize } from './budget.ts'
import { INSTRUCTION } from './instructions.ts'
import { type ClaimRow, shown } from './read.ts'
import { claim, instruction, profile } from './schema.ts'
import { CLAIMS_FILE, fileText } from './text.ts'

const HOOK_MAX = 10_000

type Ctx = OperationContext
type Shown = Awaited<ReturnType<typeof shown>>[number]

const machine = z
  .string()
  .max(40)
  .optional()
  .describe('the client name instructions are picked for; default the calling client')

const machineOf = (ctx: Ctx, given?: string) => given ?? (ctx.actor.kind === 'client' ? ctx.actor.name : '')

const onMachine = (name: string): SQL =>
  or(isNull(instruction.machines), sql`${name} = any(${instruction.machines})`) as SQL

function claimsText(heading: string, claims: Shown[]): string {
  const sections = claims.map((c) => {
    const kind = c.strength ? `${c.type}, ${c.strength}` : c.type
    const detail = c.detail.trim()
    return `## ${c.statement}\n\n${kind} · hubd:claim/${c.slug}${detail ? `\n\n${detail}` : ''}`
  })
  return `# ${heading}\n\n${sections.join('\n\n')}\n`
}

const alwaysLoaded = (homes: string[]) =>
  and(inArray(claim.home, homes), eq(claim.loading, 'always'), eq(claim.status, 'current'))

const loadedInstructions = (homes: string[], name: string) =>
  and(inArray(instruction.home, homes), eq(instruction.enabled, true), onMachine(name))

async function place(ctx: Ctx, space: string | undefined) {
  const home = space === undefined ? (ctx.scope.mode === 'isolated' ? ctx.scope.space : null) : await ctx.homeFor(space)
  if (!home || home === GLOBAL_SPACE) return null
  const [row] = await ctx.tx.execute<{ id: string; parent: string | null; path: string }>(
    sql`select hs.id, hs.parent, case when hp.name is null then hs.name else hp.name || '/' || hs.name end as path
      from hubd.space hs left join hubd.space hp on hp.id = hs.parent where hs.id = ${home}::uuid`,
  )
  return row
    ? { path: row.path, scope: row.parent ?? row.id, homes: row.parent ? [row.parent, row.id] : [row.id] }
    : null
}

export const profileOperations = [
  defineOperation({
    id: 'profile.get',
    summary: 'The profile in force for a session: its scoped claims and instructions, voice, style and load cap',
    description:
      "What a session is given at start beyond the global rules files: the always-loaded claims and enabled instructions of its scope (and project, when one is named), the voice and style in force, and text ready to print. With no space, an isolated session gets its scope's and an open one only voice and style; global claims and instructions reach every session as rules files instead.",
    input: {
      space: inputs.spacePath.optional().describe('scope or scope/project the session works in'),
      machine,
    },
    http: { method: 'GET', path: '/profile' },
    mcp: { name: 'profile_get', readOnly: true },
    async run(a, ctx) {
      const at = await place(ctx, a.space)
      const homes = at?.homes ?? []
      const scope = at?.scope ?? GLOBAL_SPACE
      const first = (home: AnyPgColumn) => desc(sql`${home} = ${scope}::uuid`)
      const [profiles, claimRows, instructionRows, loaded] = await Promise.all([
        ctx.tx
          .select()
          .from(profile)
          .where(inArray(profile.space, [GLOBAL_SPACE, scope])),
        homes.length
          ? ctx.tx
              .select()
              .from(claim)
              .where(and(alwaysLoaded(homes), ctx.visible(claim.home)))
              .orderBy(first(claim.home), desc(sql`${claim.type} = 'Trap'`), asc(claim.createdAt))
          : ([] as ClaimRow[]),
        homes.length
          ? ctx.tx
              .select()
              .from(instruction)
              .where(and(loadedInstructions(homes, machineOf(ctx, a.machine)), ctx.visible(instruction.home)))
              .orderBy(first(instruction.home), asc(instruction.position), asc(instruction.createdAt))
          : [],
        at ? loadedSize(ctx, scope) : Promise.resolve(0),
      ])
      const own = profiles.find((p) => p.space === scope && scope !== GLOBAL_SPACE)
      const base = profiles.find((p) => p.space === GLOBAL_SPACE)
      const voice = own?.voice ?? base?.voice ?? null
      const style = own?.style ?? base?.style ?? null
      const [claims, files] = await Promise.all([
        shown(ctx, claimRows),
        ctx.names.current(
          INSTRUCTION,
          instructionRows.map((i) => i.id),
        ),
      ])
      const instructions = instructionRows.map((i) => ({ name: files.get(i.id) ?? i.id, title: i.title, body: i.body }))
      const parts = [
        ...(at
          ? [
              `hubd: this session works in ${at.path}${ctx.scope.mode === 'isolated' ? `, inside the isolated scope ${ctx.scope.name}: it sees only that scope and global, and new records go there unless they name another home in it` : ''}.\n`,
            ]
          : []),
        ...(claims.length ? [claimsText(`Claims to follow without being asked (${at?.path})`, claims)] : []),
        ...instructions.map((i) => fileText(i.body)),
        ...(style ? [`# Style for answers to the user\n\n${style.trim()}\n`] : []),
        ...(voice ? [`# Voice for text written on the user's behalf\n\n${voice.trim()}\n`] : []),
      ]
      const text = parts.join('\n')
      return {
        space: at?.path ?? null,
        voice,
        style,
        loadCap: own?.loadCap ?? base?.loadCap ?? DEFAULT_LOAD_CAP,
        loaded,
        claims: claims.map((c) => ({
          slug: c.slug,
          type: c.type,
          strength: c.strength,
          statement: c.statement,
          detail: c.detail,
          home: c.home,
        })),
        instructions,
        text,
        warnings:
          text.length > HOOK_MAX
            ? [`the text is ${text.length} characters; a SessionStart hook delivers at most ${HOOK_MAX}`]
            : [],
      }
    },
  }),
  defineOperation({
    id: 'rules',
    summary: 'The global rules files for one machine',
    description:
      'Enabled global instructions for this machine, in order, then the global always-loaded claims as one file. hubridge writes them to ~/.claude/rules/hubd/.',
    input: { machine },
    http: { method: 'GET', path: '/rules' },
    mcp: false,
    async run(a, ctx) {
      const homes = [GLOBAL_SPACE]
      const [rows, claimRows] = await Promise.all([
        ctx.tx
          .select()
          .from(instruction)
          .where(loadedInstructions(homes, machineOf(ctx, a.machine)))
          .orderBy(asc(instruction.position), asc(instruction.createdAt)),
        ctx.tx
          .select()
          .from(claim)
          .where(alwaysLoaded(homes))
          .orderBy(desc(sql`${claim.type} = 'Trap'`), asc(claim.createdAt)),
      ])
      const [names, claims] = await Promise.all([
        ctx.names.current(
          INSTRUCTION,
          rows.map((r) => r.id),
        ),
        shown(ctx, claimRows),
      ])
      return {
        files: [
          ...rows.map((r) => ({ name: `${names.get(r.id) ?? r.id}.md`, body: fileText(r.body) })),
          ...(claims.length
            ? [{ name: `${CLAIMS_FILE}.md`, body: claimsText('Claims to follow without being asked', claims) }]
            : []),
        ],
      }
    },
  }),
]
