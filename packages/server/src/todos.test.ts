import { mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hubd } from '@hubd/core'
import { defineOperation, Problem } from '@hubd/sdk'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Api, boot, caller, ok } from './harness.ts'

let hubd: Hubd
let stop: () => Promise<void>
const api: Api = { base: '', token: '' }
const call = caller(api)
const storageDir = mkdtempSync(join(tmpdir(), 'hubd-storage-'))
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

const db = () => hubd.database.db
const count = async (query: ReturnType<typeof sql>) => Number((await db().execute(query))[0]?.n)
const work = { space: 'work' }

beforeAll(async () => {
  ;({ hubd, stop } = await boot(api, {
    env: { HUBD_STORAGE_DIR: storageDir, HUBD_JOBS_POLL_SECONDS: '0.5' },
    before: (h) =>
      h.operations.add(
        'todos',
        defineOperation({
          id: 'boom',
          summary: 'publishes, then fails',
          input: {},
          http: { method: 'POST', path: '/boom' },
          mcp: false,
          async run(_, { events }) {
            await events.publish('todo.done', { id: '00000000-0000-7000-8000-00000000b00e', home: null })
            throw new Problem(409, 'boom')
          },
        }),
      ),
  }))
  for (const path of ['homelab', 'homelab/kloud-home']) await ok(call('POST', '/core/spaces', { path }))
  await ok(call('POST', '/core/spaces', { path: 'work', isolated: true }))
  await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'fluffy', type: 'machine', home: 'homelab' }))
  for (const name of ['blocked', 'waiting']) await ok(call('POST', '/todos/labels', { name }))
}, 180_000)

afterAll(() => stop?.())

describe('todos', () => {
  it('adds a todo in a home with labels and links from its text', async () => {
    const t = await ok(
      call('POST', '/todos/items', {
        title: 'Bump the ozrim image',
        body: 'on hubd:asset/fluffy',
        home: 'homelab/kloud-home',
        labels: ['#Blocked'],
        priority: 'high',
        about: [{ kind: 'topic', name: 'images' }],
      }),
    )
    expect(t).toMatchObject({ home: 'homelab/kloud-home', labels: ['blocked'], priority: 'p2', version: 1, lint: [] })
    expect(
      t.links.map((l: { kind: string; to: { subject: { name: string } } }) => [l.kind, l.to.subject.name]).sort(),
    ).toEqual([
      ['about', 'images'],
      ['mentions', 'fluffy'],
    ])
    expect((await call('POST', '/todos/items', { title: 'x', labels: ['nope'] })).status).toBe(400)
    const stamped = await ok(call('POST', '/todos/items', { title: 'From a session' }, { session: 'sess-9' }))
    expect(stamped.session).toBe('sess-9')
    const given = await ok(call('POST', '/todos/items', { title: 'Named', session: 'mine' }, { session: 'sess-9' }))
    expect(given.session).toBe('mine')
  })

  it('keeps an isolated todo, its labels and its count out of an open session', async () => {
    const hidden = await ok(
      call('POST', '/todos/items', { title: 'Rotate the client-db password', labels: ['blocked'] }, work),
    )
    expect(hidden.home).toBe('work')
    expect((await call('GET', `/todos/items/${hidden.id}`)).status).toBe(404)
    const open = await ok(call('GET', '/todos/items'))
    expect(open.map((t: { title: string }) => t.title)).not.toContain('Rotate the client-db password')
    const counts = Object.fromEntries(
      (await ok(call('GET', '/todos/labels'))).map((l: { name: string; open: number }) => [l.name, l.open]),
    )
    expect(counts).toEqual({ blocked: 1, waiting: 0 })
    const inWork = Object.fromEntries(
      (await ok(call('GET', '/todos/labels', undefined, work))).map((l: { name: string; open: number }) => [
        l.name,
        l.open,
      ]),
    )
    expect(inWork).toEqual({ blocked: 1, waiting: 0 })
  })

  it('refuses a stale version and keeps about links when the text changes', async () => {
    const t = await ok(
      call('POST', '/todos/items', { title: 'Fix DNS', home: 'homelab', about: [{ kind: 'topic', name: 'dns' }] }),
    )
    const updated = await ok(call('PATCH', `/todos/items/${t.id}`, { version: 1, body: 'see hubd:asset/fluffy' }))
    expect(updated.version).toBe(2)
    expect(updated.links.map((l: { kind: string }) => l.kind).sort()).toEqual(['about', 'mentions'])
    expect((await call('PATCH', `/todos/items/${t.id}`, { version: 1, title: 'late' })).status).toBe(409)
  })

  it('marks done, hides done from the default list, and undoes the latest visible one', async () => {
    const t = await ok(call('POST', '/todos/items', { title: 'Ship it', home: 'homelab' }))
    await ok(call('POST', `/todos/items/${t.id}/done`, {}))
    expect((await ok(call('GET', '/todos/items'))).map((x: { id: string }) => x.id)).not.toContain(t.id)
    expect((await ok(call('GET', '/todos/items', { includeDone: 'true' }))).map((x: { id: string }) => x.id)).toContain(
      t.id,
    )
    const hidden = await ok(call('POST', '/todos/items', { title: 'work done' }, work))
    await ok(call('POST', `/todos/items/${hidden.id}/done`, {}, work))
    expect((await ok(call('POST', '/todos/items/undo', {}))).id).toBe(t.id)
  })

  it('publishes events in the writing transaction to every subscriber', async () => {
    const t = await ok(call('POST', '/todos/items', { title: 'Tell hello', home: 'homelab' }))
    await ok(call('POST', `/todos/items/${t.id}/done`, {}))
    await ok(call('POST', `/todos/items/${t.id}/done`, {}))
    await expect
      .poll(() => count(sql`select count(*) as n from hello.greetings where name = ${`done ${t.id}`}`), {
        timeout: 15_000,
      })
      .toBe(1)
    expect((await call('POST', '/todos/boom', {})).status).toBe(409)
    await new Promise((done) => setTimeout(done, 2000))
    expect(await count(sql`select count(*) as n from hello.greetings where name like '%b00e'`)).toBe(0)
  })

  it('filters by home path, scope included', async () => {
    const titles = (await ok(call('GET', '/todos/items', { home: 'homelab' }))).map((t: { home: string }) => t.home)
    expect(new Set(titles)).toEqual(new Set(['homelab', 'homelab/kloud-home']))
  })
})

describe('attachments', () => {
  it('stores base64 bytes once, serves them only through a visible todo', async () => {
    const open = await ok(call('POST', '/todos/items', { title: 'Screenshot', home: 'homelab' }))
    const hidden = await ok(call('POST', '/todos/items', { title: 'Secret screenshot' }, work))
    const data = PNG.toString('base64')
    const a = await ok(call('POST', `/todos/items/${open.id}/attachments`, { name: 'shot.png', data }))
    await ok(call('POST', `/todos/items/${hidden.id}/attachments`, { name: 'same.png', data }, work))
    expect(a.attachments).toMatchObject([{ name: 'shot.png', type: 'image/png', size: PNG.length }])
    expect(await count(sql`select count(*) as n from hubd.content`)).toBe(1)
    expect(readdirSync(join(storageDir, 'files')).length).toBe(1)

    const res = await fetch(`${api.base}/api/attachments/${a.attachments[0].id}`, {
      headers: { authorization: `Bearer ${api.token}` },
    })
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true)

    const secret = (await ok(call('GET', `/todos/items/${hidden.id}`, undefined, work))).attachments[0].id
    expect(
      (await fetch(`${api.base}/api/attachments/${secret}`, { headers: { authorization: `Bearer ${api.token}` } }))
        .status,
    ).toBe(404)
    const inWork = await fetch(`${api.base}/api/attachments/${secret}`, {
      headers: { authorization: `Bearer ${api.token}`, 'x-hubd-space': 'work' },
    })
    expect(inWork.status).toBe(200)
  })

  it('gives a single-use upload link for files sent without data', async () => {
    const t = await ok(call('POST', '/todos/items', { title: 'Big log', home: 'homelab' }))
    const { upload } = await ok(call('POST', `/todos/items/${t.id}/attachments`, { name: 'build.log' }))
    expect(upload.command).toContain(upload.url)
    const put = () =>
      fetch(upload.url.replace(/^https?:\/\/[^/]+/, api.base), { method: 'PUT', body: 'line 1\nline 2\n' })
    expect((await put()).status).toBe(201)
    expect((await put()).status).toBe(401)
    expect((await ok(call('GET', `/todos/items/${t.id}`))).attachments).toMatchObject([{ name: 'build.log', size: 14 }])
  })

  it('drops a deleted todo’s links and attachments, and sweeps bytes no record references', async () => {
    const t = await ok(call('POST', '/todos/items', { title: 'Temp hubd:asset/fluffy', home: 'homelab' }))
    await ok(
      call('POST', `/todos/items/${t.id}/attachments`, {
        name: 'x.txt',
        data: Buffer.from('only here').toString('base64'),
      }),
    )
    await db().execute(sql`delete from todos.todo where id = ${t.id}`)
    expect(await count(sql`select count(*) as n from hubd.link where from_id = ${t.id}`)).toBe(0)
    expect(await count(sql`select count(*) as n from hubd.attachment where from_id = ${t.id}`)).toBe(0)
    const before = await count(sql`select count(*) as n from hubd.content`)
    expect(await hubd.contents.sweep(Date.now() + 2 * 86_400_000)).toBe(1)
    expect(await count(sql`select count(*) as n from hubd.content`)).toBe(before - 1)
  })
})

describe('todo moves', () => {
  it('moves a todo through the core check, refusing a home that cannot see its links', async () => {
    const t = await ok(call('POST', '/todos/items', { title: 'Patch hubd:asset/fluffy', home: 'homelab' }))
    expect(t.title).toBe('Patch hubd:asset/fluffy')
    const refused = await call('PATCH', `/todos/items/${t.id}`, { home: 'global' })
    expect(refused.status).toBe(409)
    expect(refused.body.detail).toEqual([`the link from todos.todo ${t.id} to asset fluffy would cross isolation`])
    expect((await ok(call('PATCH', `/todos/items/${t.id}`, { home: 'homelab/kloud-home' }))).home).toBe(
      'homelab/kloud-home',
    )
    const [row] = await db().execute(sql`select title from todos.todo where id = ${t.id}`)
    expect(row?.title).toMatch(/^Patch hubd:asset\/[0-9a-f-]{36}$/)
  })
})

describe('links on edit', () => {
  it('keeps an about link to a retired subject when the text changes', async () => {
    await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'legacy', home: 'homelab' }))
    const t = await ok(
      call('POST', '/todos/items', {
        title: 'Drop legacy',
        home: 'homelab',
        about: [{ kind: 'topic', name: 'legacy' }],
      }),
    )
    const legacy = t.links[0].to.subject.id
    await ok(call('POST', '/core/subjects/retire', { kind: 'topic', name: 'legacy' }))
    const edited = await ok(call('PATCH', `/todos/items/${t.id}`, { title: 'Drop legacy now' }))
    expect(edited.lint).toEqual([])
    expect(edited.links.map((l: { to: { subject: { id: string } } }) => l.to.subject.id)).toEqual([legacy])
  })
})

describe('global changes from an isolated session', () => {
  it('asks for approval (428) before changing a global todo, then goes ahead', async () => {
    const t = await ok(call('POST', '/todos/items', { title: 'Shared chore', home: 'global' }))
    const refused = await call('PATCH', `/todos/items/${t.id}`, { title: 'Shared chore, edited' }, work)
    expect(refused.status).toBe(428)
    expect(refused.body.title).toMatch(/global: true$/)
    expect((await call('POST', `/todos/items/${t.id}/done`, {}, work)).status).toBe(428)
    expect((await call('POST', `/todos/items/${t.id}/attachments`, { name: 'x.txt' }, work)).status).toBe(428)
    const edited = await ok(
      call('PATCH', `/todos/items/${t.id}`, { title: 'Shared chore, edited', global: true }, work),
    )
    expect(edited.title).toBe('Shared chore, edited')
    expect((await ok(call('POST', `/todos/items/${t.id}/done`, { global: true }, work))).done).toBe(true)
    expect((await call('PATCH', `/todos/items/${t.id}`, { title: 'open edit' })).status).toBe(200)
  })
})
