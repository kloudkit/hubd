import { defineOperation, inputs, Problem } from '@hubd/sdk'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { notes } from './schema.ts'

const NOTE = 'hello.note'

export const addNote = defineOperation({
  id: 'notes.add',
  summary: 'Write a note; hubd: references in its text become links',
  description: 'A sample record kind for developing hubd.',
  input: {
    text: z.string().trim().min(1).max(2000),
    home: inputs.spacePath.optional().describe('space path; omit for the default home'),
    about: inputs.subjectRefs.default([]),
    refs: inputs.ids.default([]).describe('ids of other notes'),
  },
  http: { method: 'POST', path: '/notes' },
  mcp: false,
  async run({ text, home, about, refs }, { tx, links, homeFor }) {
    const [note] = await tx
      .insert(notes)
      .values({ text, home: await homeFor(home) })
      .returning()
    if (!note) throw new Error('note was not stored')
    const set = await links.set(
      { kind: NOTE, id: note.id },
      { texts: [text], about, refs: refs.map((id) => ({ kind: NOTE, id })) },
    )
    const [stored = text] = set.texts
    await tx.update(notes).set({ text: stored }).where(eq(notes.id, note.id))
    const [shown = stored] = await links.render([stored])
    return {
      note: { ...note, text: shown },
      stored,
      lint: set.lint,
      links: await links.list({ kind: NOTE, id: note.id }),
    }
  },
})

export const listNotes = defineOperation({
  id: 'notes.list',
  summary: 'List the notes this session can see, with their visible links',
  input: { limit: z.coerce.number().int().min(1).max(100).default(20) },
  http: { method: 'GET', path: '/notes' },
  mcp: false,
  async run({ limit }, { tx, visible, links }) {
    const rows = await tx.select().from(notes).where(visible(notes.home)).orderBy(desc(notes.createdAt)).limit(limit)
    const [texts, linked] = await Promise.all([
      links.render(rows.map((n) => n.text)),
      links.listMany(rows.map((n) => ({ kind: NOTE, id: n.id }))),
    ])
    return rows.map((n, i) => ({ ...n, text: texts[i] ?? n.text, links: linked.get(n.id) ?? [] }))
  },
})

export const deleteNote = defineOperation({
  id: 'notes.delete',
  summary: 'Delete a note and, through the core trigger, its links',
  input: { id: z.uuid(), global: inputs.global },
  http: { method: 'DELETE', path: '/notes/:id' },
  mcp: false,
  async run({ id, global }, { tx, visible, confirmGlobal }) {
    const [found] = await tx
      .select({ home: notes.home })
      .from(notes)
      .where(and(eq(notes.id, id), visible(notes.home)))
    if (!found) throw new Problem(404, 'No such note')
    confirmGlobal(found.home, global)
    const [gone] = await tx
      .delete(notes)
      .where(and(eq(notes.id, id), visible(notes.home)))
      .returning({ id: notes.id })
    if (!gone) throw new Problem(404, 'No such note')
    return gone
  },
})
