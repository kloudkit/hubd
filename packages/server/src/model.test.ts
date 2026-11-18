import type { Hubd } from '@hubd/core'
import { defineOperation, GLOBAL_SPACE, type Link, Problem } from '@hubd/sdk'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Api, boot, caller, names, ok } from './harness.ts'

let hubd: Hubd
let stop: () => Promise<void>

const api: Api = { base: '', token: '' }
const call = caller(api)

const db = () => hubd.database.db

const linkCount = async (fromId: string) =>
  Number((await db().execute(sql`select count(*) as n from hubd.link where from_id = ${fromId}`))[0]?.n)

beforeAll(async () => {
  ;({ hubd, stop } = await boot(api, {
    before: (h) =>
      h.operations.add(
        'test',
        defineOperation({
          id: 'boom',
          summary: 'writes, then fails',
          input: {},
          http: { method: 'POST', path: '/boom' },
          mcp: false,
          async run(_, { tx }) {
            await tx.execute(sql`insert into hubd.space (kind, name) values ('scope', 'doomed')`)
            throw new Problem(409, 'boom')
          },
        }),
        defineOperation({
          id: 'plain',
          summary: 'runs without a transaction',
          input: {},
          http: { method: 'POST', path: '/plain' },
          mcp: false,
          transaction: false,
          async run(_, { db, transaction }) {
            const outside = await db.execute(sql`select 1 as one`)
            const inside = await transaction(async ({ tx }) => (await tx.execute(sql`select 2 as two`))[0])
            return { outside: outside[0], inside }
          },
        }),
      ),
  }))

  for (const s of [
    { path: 'homelab' },
    { path: 'shtiebel' },
    { path: 'work', isolated: true },
    { path: 'homelab/kloud-home' },
    { path: 'shtiebel/portal' },
  ]) {
    await ok(call('POST', '/core/spaces', s))
  }
  await ok(call('POST', '/core/spaces', { path: 'work/client-app' }, { space: 'work' }))
  await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'fluffy', type: 'machine', home: 'homelab' }))
  await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'backups' }))
  await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'muffy-1', type: 'machine', home: 'global' }))
  await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'client-db', type: 'store' }, { space: 'work' }))
}, 180_000)

afterAll(() => stop?.())

describe('visibility', () => {
  it('shows an open session global, unassigned and open scopes, never an isolated one', async () => {
    expect(names(await ok(call('GET', '/core/subjects')))).toEqual(['backups', 'fluffy', 'muffy-1'])
    expect(names(await ok(call('GET', '/core/spaces')))).toEqual([
      'global',
      'homelab',
      'homelab/kloud-home',
      'shtiebel',
      'shtiebel/portal',
    ])
  })

  it('shows an isolated session only its scope and global', async () => {
    const space = 'work'
    expect(names(await ok(call('GET', '/core/subjects', undefined, { space })))).toEqual(['client-db', 'muffy-1'])
    expect(names(await ok(call('GET', '/core/spaces', undefined, { space })))).toEqual([
      'global',
      'work',
      'work/client-app',
    ])
    expect((await call('GET', '/core/subjects/get', { kind: 'asset', name: 'fluffy' }, { space })).status).toBe(404)
  })

  it('refuses a stamp that names no isolated scope', async () => {
    expect((await call('GET', '/core/spaces', undefined, { space: 'nope' })).status).toBe(400)
    expect((await call('GET', '/core/spaces', undefined, { space: 'homelab' })).status).toBe(400)
    expect((await call('GET', '/core/spaces', undefined, { space: 'global' })).status).toBe(400)
  })
})

describe('writes', () => {
  it('homes an isolated write in its scope and refuses global and other spaces', async () => {
    const space = 'work'
    const plain = await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'billing' }, { space }))
    expect(plain.home).toBe('work')
    const inside = await ok(
      call('POST', '/core/subjects', { kind: 'topic', name: 'invoices', home: 'work/client-app' }, { space }),
    )
    expect(inside.home).toBe('work/client-app')
    expect(
      (await call('POST', '/core/subjects', { kind: 'topic', name: 'x1', home: 'global' }, { space })).status,
    ).toBe(403)
    expect(
      (await call('POST', '/core/subjects', { kind: 'topic', name: 'x2', home: 'homelab' }, { space })).status,
    ).toBe(404)
    expect((await call('POST', '/core/spaces', { path: 'other' }, { space })).status).toBe(403)
  })

  it('leaves an open write without a home unassigned', async () => {
    expect((await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'loose' }))).home).toBeNull()
  })

  it('keeps global and other sessions out of reach of change', async () => {
    expect((await call('PATCH', '/core/spaces', { path: 'global', description: 'x' })).status).toBe(403)
    expect((await call('POST', '/core/spaces/archive', { path: 'homelab' })).status).toBe(400)
    const archived = await ok(call('POST', '/core/spaces/archive', { path: 'shtiebel/portal' }))
    expect(archived.archivedAt).toBeTruthy()
    expect(names(await ok(call('GET', '/core/spaces')))).not.toContain('shtiebel/portal')
    expect(names(await ok(call('GET', '/core/spaces', { archived: 'true' })))).toContain('shtiebel/portal')
    await ok(call('POST', '/core/spaces/restore', { path: 'shtiebel/portal' }))
  })

  it('keeps asset fields off topics', async () => {
    expect((await call('POST', '/core/subjects', { kind: 'topic', name: 't1', type: 'machine' })).status).toBe(400)
    expect((await call('POST', '/core/subjects', { kind: 'asset', name: 'a1' })).status).toBe(400)
  })
})

describe('names', () => {
  it('keeps names unique within a domain, free across domains, and global names reserved everywhere', async () => {
    expect(
      (await call('POST', '/core/subjects', { kind: 'asset', name: 'Fluffy', type: 'machine', home: 'shtiebel' }))
        .status,
    ).toBe(409)
    expect((await call('POST', '/core/subjects', { kind: 'topic', name: 'fluffy' })).status).toBe(201)
    const twin = await ok(
      call('POST', '/core/subjects', { kind: 'asset', name: 'fluffy', type: 'vm' }, { space: 'work' }),
    )
    expect(twin.home).toBe('work')
    expect(
      (await call('POST', '/core/subjects', { kind: 'asset', name: 'muffy-1', type: 'vm' }, { space: 'work' })).status,
    ).toBe(409)
    expect(
      (await call('POST', '/core/subjects', { kind: 'asset', name: 'client-db', type: 'store', home: 'global' }))
        .status,
    ).toBe(409)
  })

  it('passes a retired name to a new subject while old links keep the old one', async () => {
    await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'old-box', type: 'machine', home: 'homelab' }))
    const { note } = await ok(call('POST', '/hello/notes', { text: 'runs on hubd:asset/old-box', home: 'homelab' }))
    const before = (await ok(call('GET', '/core/subjects/get', { kind: 'asset', name: 'old-box' }))).id
    await ok(call('POST', '/core/subjects/retire', { kind: 'asset', name: 'old-box' }))
    const after = (
      await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'old-box', type: 'machine', home: 'homelab' }))
    ).id
    expect(after).not.toBe(before)
    const listed = (await ok(call('GET', '/hello/notes', { limit: '100' }))).find(
      (n: { id: string }) => n.id === note.id,
    )
    expect(listed.links).toEqual([
      { kind: 'mentions', path: null, to: { subject: { id: before, kind: 'asset', name: 'old-box' } } },
    ])
  })
})

describe('links', () => {
  it('links mentions with paths and about, creating unknown subjects in the record home', async () => {
    const reply = await ok(
      call('POST', '/hello/notes', {
        text: 'fluffy reads hubd:asset/fluffy/etc/hosts, see hubd:topic/dns.',
        home: 'homelab/kloud-home',
        about: [{ kind: 'topic', name: 'backups' }],
      }),
    )
    expect(reply.lint).toEqual([])
    const shape = reply.links.map((l: Link) => [l.kind, 'subject' in l.to ? l.to.subject.name : '', l.path]).sort()
    expect(shape).toEqual([
      ['about', 'backups', null],
      ['mentions', 'dns', null],
      ['mentions', 'fluffy', 'etc/hosts'],
    ])
    expect((await ok(call('GET', '/core/subjects/get', { kind: 'topic', name: 'dns' }))).home).toBe(
      'homelab/kloud-home',
    )
  })

  it('lets a global record reference only global subjects', async () => {
    const reply = await ok(
      call('POST', '/hello/notes', { text: 'hubd:asset/muffy-1 and hubd:asset/fluffy', home: 'global' }),
    )
    expect(reply.lint).toEqual(["hubd:asset/fluffy is not visible from this record's home"])
    expect(reply.links.map((l: Link) => ('subject' in l.to ? l.to.subject.name : ''))).toEqual(['muffy-1'])
  })

  it('refuses a ref the record home cannot see, and a ref to itself', async () => {
    const hidden = (await ok(call('POST', '/hello/notes', { text: 'secret' }, { space: 'work' }))).note
    const reply = await ok(call('POST', '/hello/notes', { text: 'open', home: 'homelab', refs: [hidden.id] }))
    expect(reply.lint).toEqual([`hello.note ${hidden.id} is not visible from this record's home`])
    const seen = (await ok(call('POST', '/hello/notes', { text: 'target', home: 'homelab' }))).note
    const linked = await ok(call('POST', '/hello/notes', { text: 'source', home: 'homelab', refs: [seen.id] }))
    expect(linked.links).toEqual([{ kind: 'ref', path: null, to: { record: { kind: 'hello.note', id: seen.id } } }])
  })

  it('holds exactly one target and a registered kind in the database', async () => {
    const note = (await ok(call('POST', '/hello/notes', { text: 'x', home: 'homelab' }))).note
    await expect(
      db().execute(sql`insert into hubd.link (from_kind, from_id, kind) values ('hello.note', ${note.id}, 'mentions')`),
    ).rejects.toThrow()
    await expect(
      db().execute(
        sql`insert into hubd.link (from_kind, from_id, kind, to_subject) select 'nope.thing', ${note.id}, 'mentions', id from hubd.subject limit 1`,
      ),
    ).rejects.toThrow()
  })

  it('drops a deleted record’s links through the trigger and refuses deleting a linked subject', async () => {
    const reply = await ok(call('POST', '/hello/notes', { text: 'hubd:asset/fluffy', home: 'homelab' }))
    expect(await linkCount(reply.note.id)).toBe(1)
    await ok(call('DELETE', `/hello/notes/${reply.note.id}`))
    expect(await linkCount(reply.note.id)).toBe(0)
    const fluffy = (await ok(call('GET', '/core/subjects/get', { kind: 'asset', name: 'fluffy' }))).id
    await expect(db().execute(sql`delete from hubd.subject where id = ${fluffy}`)).rejects.toThrow()
  })
})

describe('an uninstalled kind', () => {
  it('hides links to it and never errors', async () => {
    const note = (await ok(call('POST', '/hello/notes', { text: 'hubd:topic/backups', home: 'homelab' }))).note
    await db().execute(
      sql`insert into hubd.record_kind (kind, plugin, table_name) values ('gone.thing', 'gone', 'gone.things')`,
    )
    await db().execute(
      sql`insert into hubd.link (from_kind, from_id, kind, to_kind, to_id) values ('hello.note', ${note.id}, 'ref', 'gone.thing', uuidv7())`,
    )
    expect(await linkCount(note.id)).toBe(2)
    const listed = (await ok(call('GET', '/hello/notes', { limit: '100' }))).find(
      (n: { id: string }) => n.id === note.id,
    )
    expect(listed.links.map((l: Link) => l.kind)).toEqual(['mentions'])
  })
})

describe('clients', () => {
  it('clears created-by when a client goes and deletes nothing else', async () => {
    const temp = await hubd.clients.create('temp')
    const made = await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'temp-topic' }, { as: temp.token }))
    const [row] = await db().execute(sql`select created_by from hubd.subject where id = ${made.id}`)
    expect(row?.created_by).toBe(temp.id)
    expect(await hubd.clients.revoke('temp')).toBe(true)
    const [after] = await db().execute(sql`select created_by from hubd.subject where id = ${made.id}`)
    expect(after).toEqual({ created_by: null })
  })
})

describe('transactions', () => {
  it('rolls back everything an operation wrote when it fails', async () => {
    expect((await call('POST', '/test/boom', {})).status).toBe(409)
    expect(names(await ok(call('GET', '/core/spaces')))).not.toContain('doomed')
  })

  it('gives an operation that opts out a plain handle and transaction()', async () => {
    expect(await ok(call('POST', '/test/plain', {}))).toEqual({ outside: { one: 1 }, inside: { two: 2 } })
  })

  it('seeds global with its fixed id', async () => {
    const [row] = await db().execute(sql`select id from hubd.space where name = 'global'`)
    expect(row?.id).toBe(GLOBAL_SPACE)
  })
})

const note = (text: string, home: string, space?: string) =>
  ok(call('POST', '/hello/notes', { text, home }, space ? { space } : {}))
const listed = async (id: string, space?: string) =>
  (await ok(call('GET', '/hello/notes', { limit: '100' }, space ? { space } : {}))).find(
    (n: { id: string }) => n.id === id,
  )
const asset = (name: string, home?: string, space?: string) =>
  ok(
    call(
      'POST',
      '/core/subjects',
      { kind: 'asset', name, type: 'machine', ...(home ? { home } : {}) },
      space ? { space } : {},
    ),
  )

describe('text stores ids and shows names', () => {
  it('stores hubd: references by id and renders current names, path and punctuation kept', async () => {
    const fluffy = (await ok(call('GET', '/core/subjects/get', { kind: 'asset', name: 'fluffy' }))).id
    const r = await note('see hubd:asset/fluffy/etc/hosts and hubd:asset/fluffy.', 'homelab')
    expect(r.stored).toBe(`see hubd:asset/${fluffy}/etc/hosts and hubd:asset/${fluffy}.`)
    expect(r.note.text).toBe('see hubd:asset/fluffy/etc/hosts and hubd:asset/fluffy.')
  })
})

describe('names', () => {
  it('renames freeing the old name at once, while old text follows the subject', async () => {
    await asset('box', 'homelab')
    const r = await note('runs on hubd:asset/box', 'homelab')
    await ok(call('POST', '/core/subjects/rename', { kind: 'asset', name: 'box', to: 'box-1' }))
    expect((await listed(r.note.id)).text).toBe('runs on hubd:asset/box-1')
    expect((await asset('box', 'homelab')).name).toBe('box')
  })

  it('adds and removes aliases, never the name itself', async () => {
    await ok(call('POST', '/core/subjects/alias', { kind: 'asset', name: 'box-1', alias: 'b1' }))
    const r = await note('hubd:asset/b1', 'homelab')
    expect(r.note.text).toBe('hubd:asset/box-1')
    await ok(call('POST', '/core/subjects/alias', { kind: 'asset', name: 'box-1', alias: 'b1', remove: true }))
    expect(
      (await call('POST', '/core/subjects/alias', { kind: 'asset', name: 'box-1', alias: 'box-1', remove: true }))
        .status,
    ).toBe(400)
  })

  it('merges into a winner, leaving the loser as a redirect', async () => {
    const m1 = (await asset('m1', 'homelab')).id
    const m2 = (await asset('m2', 'homelab')).id
    const r = await note('hubd:asset/m1 and hubd:asset/m2', 'homelab')
    await ok(call('POST', '/core/subjects/merge', { kind: 'asset', from: 'm1', into: 'm2' }))
    const after = await listed(r.note.id)
    expect(after.text).toBe('hubd:asset/m2 and hubd:asset/m2')
    expect(after.links.map((l: Link) => ('subject' in l.to ? l.to.subject.id : ''))).toEqual([m2])
    expect((await ok(call('GET', '/core/subjects/get', { kind: 'asset', name: 'm1' }))).id).toBe(m2)
    const [row] = await db().execute(sql`select merged_into, retired_at from hubd.subject where id = ${m1}`)
    expect(row?.merged_into).toBe(m2)
    expect(row?.retired_at).toBeTruthy()
    const twin = (await ok(call('GET', '/core/subjects/get', { kind: 'asset', name: 'fluffy' }, { space: 'work' })))
      .name
    expect(twin).toBe('fluffy')
    await asset('w2', undefined, 'work')
    expect(
      (await call('POST', '/core/subjects/merge', { kind: 'asset', from: 'w2', into: 'm2' }, { space: 'work' })).status,
    ).toBe(404)
  })
})

describe('moves', () => {
  it('makes a subject global, refusing when its name is held in another domain', async () => {
    await asset('shared', 'homelab')
    const moved = await ok(call('PATCH', '/core/subjects', { kind: 'asset', name: 'shared', home: 'global' }))
    expect(moved.home).toBe('global')
    const seen = await note('uses hubd:asset/shared', 'work', 'work')
    expect(seen.lint).toEqual([])
    const refused = await call('PATCH', '/core/subjects', { kind: 'asset', name: 'fluffy', home: 'global' })
    expect(refused.status).toBe(409)
    expect(refused.body.detail).toEqual(['the asset name "fluffy" is taken where it would move'])
  })

  it('refuses moving a subject away from a record that could no longer see it', async () => {
    const refused = await call('PATCH', '/core/subjects', { kind: 'asset', name: 'shared', home: 'homelab' })
    expect(refused.status).toBe(409)
    expect(refused.body.detail[0]).toMatch(/^the link from hello\.note .* to asset shared would cross isolation$/)
  })

  it('moves a project between open scopes and refuses a duplicate name', async () => {
    const moved = await ok(call('POST', '/core/spaces/move', { path: 'homelab/kloud-home', to: 'shtiebel' }))
    expect(moved.path).toBe('shtiebel/kloud-home')
    await ok(call('POST', '/core/spaces', { path: 'homelab/kloud-home' }))
    expect((await call('POST', '/core/spaces/move', { path: 'homelab/kloud-home', to: 'shtiebel' })).status).toBe(409)
  })

  it('refuses an isolation flip with every conflict listed, then flips once they are gone', async () => {
    const crossing = await note('depends on hubd:asset/fluffy', 'shtiebel')
    const refused = await call('POST', '/core/spaces/isolate', { path: 'shtiebel', isolated: true })
    expect(refused.status).toBe(409)
    expect(refused.body.detail).toHaveLength(3)
    expect(refused.body.detail).toContain(
      `the link from hello.note ${crossing.note.id} to asset fluffy would cross isolation`,
    )
    const blocking = new Set(refused.body.detail.map((d: string) => d.split(' ')[4]))
    const opening = await call('POST', '/core/spaces/isolate', { path: 'work', isolated: false }, { space: 'work' })
    expect(opening.status).toBe(409)
    expect(opening.body.detail).toContain('the asset name "fluffy" is taken on the other side')
    for (const id of blocking) await ok(call('DELETE', `/hello/notes/${id}`))
    const flipped = await ok(call('POST', '/core/spaces/isolate', { path: 'shtiebel', isolated: true }))
    expect(flipped.isolated).toBe(true)
    expect(names(await ok(call('GET', '/core/spaces')))).not.toContain('shtiebel')
  })
})

describe('global changes from an isolated session', () => {
  it('asks for approval (428) before changing a global subject or deleting a global note', async () => {
    const space = 'work'
    const refused = await call(
      'PATCH',
      '/core/subjects',
      { kind: 'asset', name: 'muffy-1', summary: 'dev box' },
      { space },
    )
    expect(refused.status).toBe(428)
    const changed = await ok(
      call('PATCH', '/core/subjects', { kind: 'asset', name: 'muffy-1', summary: 'dev box', global: true }, { space }),
    )
    expect(changed.summary).toBe('dev box')
    const n = await note('a shared note', 'global')
    expect((await call('DELETE', `/hello/notes/${n.note.id}`, undefined, { space })).status).toBe(428)
    expect((await call('DELETE', `/hello/notes/${n.note.id}`, { global: 'true' }, { space })).status).toBe(200)
  })
})
