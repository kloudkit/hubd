import { type Hubd, squash } from '@hubd/core'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Api, boot, caller, ok } from './harness.ts'

const api: Api = { base: '', token: '' }
const call = caller(api)
let hubd: Hubd
let stop: () => Promise<void>
const work = { space: 'work' }

const propose = (steps: object[], options: { space?: string } = {}) =>
  ok(call('POST', '/estate/suggestions', { steps }, options))
const approve = (id: string, options: { space?: string } = {}) =>
  call('POST', `/estate/suggestions/${id}/accept`, {}, options)
const record = (slug: string, more: object = {}) => ({
  step: 'claim.record',
  slug,
  type: 'Fact',
  statement: `${slug} holds`,
  ...more,
})
const land = async (steps: object[], options: { space?: string } = {}) => {
  const c = await propose(steps, options)
  return ok(approve(c.id, options))
}
const get = (slug: string, options: { space?: string } = {}) => ok(call('GET', '/estate/claims/get', { slug }, options))

beforeAll(async () => {
  ;({ hubd, stop } = await boot(api))
  for (const path of ['homelab', 'homelab/kloud-home', 'shtiebel']) await ok(call('POST', '/core/spaces', { path }))
  await ok(call('POST', '/core/spaces', { path: 'work', isolated: true }))
  await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'fluffy', type: 'machine', home: 'homelab' }))
}, 180_000)

afterAll(() => stop?.())

describe('suggestions', () => {
  it('writes nothing until approved, and lints the subjects it would create', async () => {
    const c = await propose([
      record('dns-on-fluffy', {
        home: 'homelab',
        statement: 'hubd:asset/fluffy runs DNS for hubd:asset/newbox',
        about: [{ kind: 'asset', name: 'fluffy' }],
      }),
    ])
    expect(c).toMatchObject({ state: 'pending', lint: ['creates hubd:asset/newbox'] })
    expect((await call('GET', '/estate/claims/get', { slug: 'dns-on-fluffy' })).status).toBe(404)
    expect((await call('GET', '/core/subjects/get', { kind: 'asset', name: 'newbox' })).status).toBe(404)
    expect((await ok(call('GET', '/estate/suggestions'))).map((x: { id: string }) => x.id)).toContain(c.id)

    expect((await ok(approve(c.id))).state).toBe('accepted')
    const claim = await get('dns-on-fluffy')
    expect(claim).toMatchObject({
      slug: 'dns-on-fluffy',
      home: 'homelab',
      revision: 1,
      statement: 'hubd:asset/fluffy runs DNS for hubd:asset/newbox',
    })
    expect(claim.revisions.map((r: { n: number }) => r.n)).toEqual([1])
    expect((await ok(call('GET', '/core/subjects/get', { kind: 'asset', name: 'newbox' }))).home).toBe('homelab')
    expect((await approve(c.id)).status).toBe(409)
  })

  it('re-checks names at approval, refusing a slug taken since the proposal', async () => {
    const a = await propose([record('dup')])
    const b = await propose([record('dup')])
    await ok(approve(a.id))
    const refused = await approve(b.id)
    expect(refused.status).toBe(409)
    expect(refused.body.title).toBe('The claim name "dup" is taken')
    expect((await ok(call('GET', '/estate/suggestions'))).map((x: { id: string }) => x.id)).toContain(b.id)
    expect((await ok(call('POST', `/estate/suggestions/${b.id}/reject`, {}))).state).toBe('rejected')
  })

  it('refuses an edit from a stale revision', async () => {
    await land([record('edited', { home: 'homelab' })])
    await land([{ step: 'claim.edit', slug: 'edited', revision: 1, statement: 'edited once' }])
    const stale = await propose([{ step: 'claim.edit', slug: 'edited', revision: 1, statement: 'late' }]).catch(
      (e: Error) => e,
    )
    expect(String(stale)).toMatch(/^Error: 409/)
    const claim = await get('edited')
    expect(claim).toMatchObject({ statement: 'edited once', revision: 2 })
  })

  it('lands subject steps and claims together', async () => {
    await land([
      { step: 'subject.create', kind: 'topic', name: 'backups', home: 'homelab' },
      record('nightly-backups', { home: 'homelab', about: [{ kind: 'topic', name: 'backups' }] }),
      { step: 'subject.rename', kind: 'topic', name: 'backups', to: 'backup' },
    ])
    const about = await ok(call('GET', '/estate/claims/about', { kind: 'topic', name: 'backup' }))
    expect(about.claims.map((c: { slug: string; link: string }) => [c.slug, c.link])).toEqual([
      ['nightly-backups', 'about'],
    ])
  })

  it('shows a change only to sessions that see every home it touches, approved from its own scope', async () => {
    const hidden = await propose([record('work-secret')], work)
    expect((await ok(call('GET', '/estate/suggestions'))).map((x: { id: string }) => x.id)).not.toContain(hidden.id)
    expect((await approve(hidden.id)).status).toBe(404)
    expect((await ok(approve(hidden.id, work))).state).toBe('accepted')
    expect((await call('GET', '/estate/claims/get', { slug: 'work-secret' })).status).toBe(404)
    expect((await get('work-secret', work)).home).toBe('work')

    const shared = await propose([record('shared-fact', { home: 'global' })])
    expect((await ok(call('GET', '/estate/suggestions', undefined, work))).map((x: { id: string }) => x.id)).toContain(
      shared.id,
    )
    expect((await approve(shared.id, work)).status).toBe(403)
    await ok(approve(shared.id))
  })
})

describe('claims', () => {
  it('stores claim references by id and renders the newest slug, old slugs still resolving', async () => {
    await land([record('target', { home: 'homelab' })])
    await land([record('pointer', { home: 'homelab', statement: 'see hubd:claim/target' })])
    const [row] = await hubd.database.db.execute(
      sql`select statement from estate.claim c join hubd.name n on n.record_id = c.id where n.name = 'pointer'`,
    )
    expect(row?.statement).toMatch(/^see hubd:claim\/[0-9a-f-]{36}$/)
    await land([{ step: 'claim.rename', slug: 'target', to: 'target-renamed' }])
    expect((await get('pointer')).statement).toBe('see hubd:claim/target-renamed')
    expect((await get('target')).slug).toBe('target-renamed')
    expect((await get('pointer')).links.map((l: { kind: string }) => l.kind)).toEqual(['mentions'])
  })

  it('searches by words and by slug with typos, the named project first and Traps first', async () => {
    await land([
      record('kh-trap', { type: 'Trap', home: 'homelab/kloud-home', statement: 'restic prune runs on sundays' }),
      record('kh-fact', { home: 'homelab/kloud-home', statement: 'restic keeps seven daily snapshots' }),
      record('global-restic', { home: 'global', statement: 'restic is the backup tool' }),
    ])
    const hits = await ok(call('GET', '/estate/claims', { q: 'restic', project: 'homelab/kloud-home' }))
    expect(hits.claims.map((h: { slug: string }) => h.slug)).toEqual(['kh-trap', 'kh-fact', 'global-restic'])
    const typo = await ok(call('GET', '/estate/claims', { q: 'kh-fakt' }))
    expect(typo.claims.map((h: { slug: string }) => h.slug)).toContain('kh-fact')
  })

  it('cites sources, relates claims and subjects, and maps subjects by claim count', async () => {
    await land([
      { step: 'claim.cite', slug: 'kh-fact', kind: 'url', ref: 'https://restic.net', locator: 'docs' },
      { step: 'claim.relate', slug: 'kh-trap', relation: 'relies-on', to: 'kh-fact' },
      {
        step: 'subject.relate',
        slug: 'dns-on-fluffy',
        from: { kind: 'asset', name: 'newbox' },
        relation: 'depends-on',
        to: { kind: 'asset', name: 'fluffy' },
      },
    ])
    expect((await get('kh-fact')).sources).toMatchObject([{ kind: 'url', ref: 'https://restic.net', locator: 'docs' }])
    expect((await get('kh-trap')).relations).toEqual([{ relation: 'relies-on', to: 'kh-fact' }])
    expect((await get('dns-on-fluffy')).subjectRelations).toHaveLength(1)
    const map = await ok(call('GET', '/estate/claims/map'))
    expect(map).toContainEqual({ kind: 'asset', name: 'fluffy', claims: 1 })
  })

  it('refuses relating to a claim invisible from the claim home', async () => {
    const refused = await propose([
      { step: 'claim.relate', slug: 'global-restic', relation: 'answers', to: 'kh-fact' },
    ]).catch((e: Error) => e)
    expect(String(refused)).toMatch(/^Error: 409/)
  })

  it('lists claims due for review and open KnownIssues by age', async () => {
    await land([
      record('overdue', { reconfirmAt: '2020-01-01T00:00:00Z' }),
      record('issue-a', { type: 'KnownIssue' }),
      record('issue-b', { type: 'KnownIssue' }),
    ])
    expect((await ok(call('GET', '/estate/verifications/due'))).claims.map((c: { slug: string }) => c.slug)).toEqual([
      'overdue',
    ])
    const issues = await ok(call('GET', '/estate/claims', { type: 'KnownIssue', order: 'oldest' }))
    expect(issues.claims.map((c: { slug: string }) => c.slug)).toEqual(['issue-a', 'issue-b'])
  })

  it('moves a claim, checking its slugs in the new name domain', async () => {
    await land([{ step: 'claim.move', slug: 'kh-fact', home: 'shtiebel' }])
    expect((await get('kh-fact')).home).toBe('shtiebel')
  })
})

describe('checks and profile', () => {
  it('lists due checks and extends a repeated outcome instead of adding one', async () => {
    await land([{ step: 'check.add', slug: 'edited', command: 'dig fluffy' }])
    const due = (await ok(call('GET', '/estate/verifications/due'))).checks
    const check = due.find((d: { slug: string }) => d.slug === 'edited')
    expect(check.command).toBe('dig fluffy')
    const first = await ok(call('POST', '/estate/verifications', { slug: 'edited', check: check.id, outcome: 'holds' }))
    const again = await ok(call('POST', '/estate/verifications', { slug: 'edited', check: check.id, outcome: 'holds' }))
    expect(again.id).toBe(first.id)
    expect(
      (await ok(call('GET', '/estate/verifications/due'))).checks.map((d: { slug: string }) => d.slug),
    ).not.toContain('edited')
  })

  it('gives the global profile, overridden per scope', async () => {
    await land([{ step: 'profile.set', voice: 'plain', style: 'short', loadCap: 8000 }])
    await land([{ step: 'profile.set', space: 'work', voice: 'formal' }], work)
    expect(await ok(call('GET', '/estate/profile'))).toMatchObject({
      space: null,
      voice: 'plain',
      style: 'short',
      loadCap: 8000,
      claims: [],
      instructions: [],
    })
    expect(await ok(call('GET', '/estate/profile', undefined, work))).toMatchObject({
      space: 'work',
      voice: 'formal',
      style: 'short',
      loadCap: 8000,
    })
  })
})

const text = (n: number) => 'x'.repeat(n)
const add = (body: object, options: { space?: string } = {}) => ok(call('POST', '/estate/instructions', body, options))
const instruction = (name: string, options: { space?: string } = {}) =>
  ok(call('GET', '/estate/instructions/get', { name }, options))
const rules = async (query = '', headers: Record<string, string> = {}) =>
  fetch(`${api.base}/api/estate/rules${query}`, { headers: { authorization: `Bearer ${api.token}`, ...headers } })

describe('limits and the load budget', () => {
  it('holds a claim to 600 characters of statement and 10,000 of detail', async () => {
    const long = await propose([record('too-long', { statement: text(601) })]).catch((e: Error) => e)
    expect(String(long)).toMatch(/^Error: 400/)
    const detail = await propose([record('too-much', { detail: text(10_001) })]).catch((e: Error) => e)
    expect(String(detail)).toMatch(/^Error: 400/)
    await land([record('just-fits', { statement: text(600), detail: text(10_000) })])
  })

  it('refuses loading, editing and capping past a scope budget, projects counted with their scope', async () => {
    await land([{ step: 'profile.set', space: 'shtiebel', loadCap: 100 }])
    const over = await call('POST', '/estate/suggestions', {
      steps: [record('sh-big', { home: 'shtiebel', loading: 'always', statement: text(60), detail: text(50) })],
    })
    expect(over.status).toBe(409)
    expect(over.body.detail).toEqual(['"shtiebel" would load 110 characters, over its cap of 100'])
    await land([record('sh-rule', { home: 'shtiebel', loading: 'always', statement: text(50) })])
    const edited = await propose([{ step: 'claim.edit', slug: 'sh-rule', revision: 1, detail: text(51) }]).catch(
      (e: Error) => e,
    )
    expect(String(edited)).toMatch(/^Error: 409/)
    const capped = await propose([{ step: 'profile.set', space: 'shtiebel', loadCap: 10 }]).catch((e: Error) => e)
    expect(String(capped)).toMatch(/^Error: 409/)
    await land([
      { step: 'claim.load', slug: 'sh-rule', loading: 'on-request' },
      record('sh-other', { home: 'shtiebel', loading: 'always', statement: text(90) }),
    ])

    await land([record('hl-loaded', { home: 'homelab/kloud-home', loading: 'always', statement: text(40) })])
    await land([record('work-loaded', { loading: 'always', statement: text(40) })], work)
    const global = await call('POST', '/estate/suggestions', { steps: [{ step: 'profile.set', loadCap: 30 }] })
    expect(global.status).toBe(409)
    expect(global.body.detail).toContain('"homelab" would load 40 characters, over its cap of 30')
    expect(global.body.detail).toContain('A scope this session cannot see would load 40 characters, over its cap of 30')
    expect(global.body.detail.join(' ')).not.toMatch(/shtiebel|work/)
  })

  it('counts enabled instructions against the same budget', async () => {
    const refused = await call('POST', '/estate/instructions', { title: 'Big', body: text(20), home: 'shtiebel' })
    expect(refused.status).toBe(409)
    const off = await add({ title: 'Big', body: text(20), home: 'shtiebel', enabled: false })
    const on = await call('PATCH', '/estate/instructions', { name: off.name, revision: 1, enabled: true })
    expect(on.status).toBe(409)
    expect((await instruction(off.name)).enabled).toBe(false)
  })
})

describe('instructions', () => {
  it('names the file from the title, keeps revisions and refuses a stale one', async () => {
    const body = '# Never print a secret value\n\nNot to the terminal, not to logs.\n'
    const made = await add({ title: 'Never print a secret value', body, home: 'global' })
    expect(made).toMatchObject({ name: 'never-print-a-secret-value', home: 'global', revision: 1, position: 0 })
    const again = await add({ title: 'Never print a secret value!', body, home: 'global' })
    expect(again).toMatchObject({ name: 'never-print-a-secret-value-2', position: 1 })

    const changed = await ok(
      call('PATCH', '/estate/instructions', { name: made.name, revision: 1, body: `${body}Nor into a file.\n` }),
    )
    expect(changed.revision).toBe(2)
    const stale = await call('PATCH', '/estate/instructions', { name: made.name, revision: 1, enabled: false })
    expect(stale.status).toBe(409)
    const got = await instruction('never-print-a-secret-value.md')
    expect(got.revisions.map((r: { n: number; commit: { actor: string } }) => [r.n, r.commit.actor])).toEqual([
      [2, 'tester'],
      [1, 'tester'],
    ])
    const first = await ok(call('GET', '/estate/instructions/get', { name: made.name, revision: '1' }))
    expect(first.snapshot.body).toBe(body)
  })

  it('keeps the bdsoha/hubd body rules', async () => {
    const refused = async (body: string) =>
      (await call('POST', '/estate/instructions', { title: 'Rule', body, home: 'global' })).body.title
    expect(await refused('---\nname: x\n---\nhi')).toMatch(/may not start with ---/)
    expect(await refused('Read @~/notes.md first.')).toMatch(/"@~\/notes.md" would make Claude Code load/)
    expect(await refused(' ')).toMatch(/needs some text/)
    const quoted = await add({ title: 'Quoted import', body: 'Name `@~/notes.md` only.', home: 'global' })
    expect(quoted.warnings).toEqual([])
    const long = await add({ title: 'Long one', body: 'line\n'.repeat(201), home: 'global', enabled: false })
    expect(long.warnings).toEqual(["201 lines, over Claude Code's 200-line guidance for one file"])
    const loose = await add({ title: 'Loose one', body: 'x', enabled: false })
    expect(loose.warnings).toEqual(['unassigned: it loads in no session until it has a home'])
  })

  it('drafts an instruction from a claim once', async () => {
    await land([
      record('drafted-rule', {
        type: 'Rule',
        strength: 'must',
        statement: 'Commit with a pathspec',
        detail: 'Other sessions share @~/checkouts.',
      }),
    ])
    const made = await add({ claim: 'drafted-rule', home: 'homelab' })
    expect(made).toMatchObject({
      name: 'commit-with-a-pathspec',
      title: 'Commit with a pathspec',
      body: '# Commit with a pathspec\n\nOther sessions share `@~/checkouts`.\n',
    })
  })

  it('serves global rules files per machine, in order, with an ETag', async () => {
    await add({ title: 'Only on muffy', body: 'muffy only', home: 'global', machines: ['muffy-1'] })
    await land([record('global-trap', { type: 'Trap', home: 'global', loading: 'always', statement: 'hosts lie' })])
    const files = async (query = '') => ((await (await rules(query)).json()) as { files: { name: string }[] }).files
    const mine = (await files()).map((f) => f.name)
    expect(mine).toEqual([
      'never-print-a-secret-value.md',
      'never-print-a-secret-value-2.md',
      'quoted-import.md',
      'hubd-claims.md',
    ])
    expect((await files('?machine=muffy-1')).map((f) => f.name)).toContain('only-on-muffy.md')
    const claims = (await files()).at(-1) as unknown as { body: string }
    expect(claims.body).toBe(
      '# Claims to follow without being asked\n\n## hosts lie\n\nTrap · hubd:claim/global-trap\n',
    )

    const first = await rules()
    const etag = first.headers.get('etag') ?? ''
    expect((await rules('', { 'if-none-match': etag })).status).toBe(304)

    await ok(
      call('PUT', '/estate/instructions/order', {
        names: [
          'quoted-import',
          'never-print-a-secret-value-2',
          'never-print-a-secret-value',
          'long-one',
          'only-on-muffy',
        ],
      }),
    )
    expect((await files()).map((f) => f.name).slice(0, 3)).toEqual([
      'quoted-import.md',
      'never-print-a-secret-value-2.md',
      'never-print-a-secret-value.md',
    ])
    expect((await rules('', { 'if-none-match': etag })).status).toBe(200)
    const partial = await call('PUT', '/estate/instructions/order', { names: ['quoted-import'] })
    expect(partial.status).toBe(400)
  })

  it('keeps an isolated scope instructions to its sessions and asks before changing a global one', async () => {
    const hidden = await add({ title: 'Work only', body: 'Use the work account.' }, work)
    expect(hidden.home).toBe('work')
    expect((await call('GET', '/estate/instructions/get', { name: hidden.name })).status).toBe(404)
    const names = (await ok(call('GET', '/estate/instructions'))).map((i: { name: string }) => i.name)
    expect(names).not.toContain(hidden.name)

    const shared = await instruction('quoted-import', work)
    const asked = await call(
      'PATCH',
      '/estate/instructions',
      { name: 'quoted-import', revision: shared.revision, enabled: false },
      work,
    )
    expect(asked.status).toBe(428)
  })

  it('gives a session its scope set, its project after its scope, and voice and style', async () => {
    const own = await ok(call('GET', '/estate/profile', undefined, work))
    expect(own.claims.map((c: { slug: string }) => c.slug)).toEqual(['work-loaded'])
    expect(own.instructions.map((i: { name: string }) => i.name)).toEqual(['work-only'])
    expect(own.text).toContain('inside the isolated scope work')
    expect(own.text).toContain('Use the work account.\n')
    expect(own.text).toContain("# Voice for text written on the user's behalf\n\nformal\n")

    await add({ title: 'Kloud home', body: 'In the kloud-home checkout.', home: 'homelab/kloud-home' })
    const project = await ok(call('GET', '/estate/profile', { space: 'homelab/kloud-home' }))
    expect(project.space).toBe('homelab/kloud-home')
    expect(project.instructions.map((i: { name: string }) => i.name)).toEqual(['commit-with-a-pathspec', 'kloud-home'])
    expect(project.claims.map((c: { slug: string }) => c.slug)).toEqual(['hl-loaded'])
    expect(project.loaded).toBeGreaterThan(40)
    const scope = await ok(call('GET', '/estate/profile', { space: 'homelab' }))
    expect(scope.instructions.map((i: { name: string }) => i.name)).toEqual(['commit-with-a-pathspec'])
    expect((await call('GET', '/estate/profile', { space: 'work' })).status).toBe(404)
  })

  it('moves an instruction with its name checked, and frees the name when removed', async () => {
    const moved = await ok(
      call('PATCH', '/estate/instructions', { name: 'kloud-home', revision: 1, home: 'shtiebel', enabled: false }),
    )
    expect(moved).toMatchObject({ home: 'shtiebel', enabled: false, revision: 2 })
    await ok(call('DELETE', '/estate/instructions', { name: 'kloud-home' }))
    expect((await call('GET', '/estate/instructions/get', { name: 'kloud-home' })).status).toBe(404)
    expect((await add({ title: 'Kloud home', body: 'again', home: 'homelab', enabled: false })).name).toBe('kloud-home')
  })
})

describe('search and review', () => {
  const search = async (query: Record<string, string>) =>
    (await ok(call('GET', '/estate/claims', query))) as {
      claims: { slug: string; contradicted: boolean; reconfirmAt: string | null }[]
      legend: { name: string; type: string; endpoint: string | null }[]
    }
  const about = (path: string) => [{ kind: 'asset', name: 'repo1', path }]

  it('ranks claims about the place first, nearer paths higher, and filters by about', async () => {
    await ok(
      call('POST', '/core/subjects', {
        kind: 'asset',
        name: 'repo1',
        type: 'repo',
        home: 'homelab/kloud-home',
        endpoint: 'github.com/x/repo1',
      }),
    )
    await land([
      record('proxy-docs', { home: 'homelab/kloud-home', statement: 'the proxy is documented', about: about('docs') }),
      record('proxy-k8s', { home: 'homelab/kloud-home', statement: 'the proxy runs in k8s', about: about('k8s') }),
      record('proxy-here', {
        home: 'homelab/kloud-home',
        statement: 'the proxy listens on 4000',
        about: about('k8s/litellm'),
      }),
      record('proxy-global', { home: 'global', statement: 'every proxy logs requests' }),
    ])
    const found = await search({ q: 'proxy', place: 'repo1/k8s/litellm' })
    expect(found.claims.map((c) => c.slug)).toEqual(['proxy-here', 'proxy-k8s', 'proxy-docs', 'proxy-global'])
    expect(found.legend).toEqual([{ name: 'repo1', type: 'repo', endpoint: 'github.com/x/repo1', reachedBy: null }])
    const narrowed = await search({ q: 'proxy', about: 'asset/repo1/k8s' })
    expect(narrowed.claims.map((c) => c.slug).sort()).toEqual(['proxy-here', 'proxy-k8s'])
    expect((await call('GET', '/estate/claims', { about: 'asset/nowhere' })).status).toBe(404)
  })

  it('lets evidence move the review date and keeps contradicted claims out of default search', async () => {
    await land([
      record('never-due', { reviewDays: null }),
      record('checked-old', { reconfirmAt: '2020-01-01T00:00:00Z' }),
    ])
    expect((await get('never-due')).reconfirmAt).toBeNull()
    await land([{ step: 'check.add', slug: 'checked-old', command: 'true' }])
    const due = (await ok(call('GET', '/estate/verifications/due'))).claims.map((c: { slug: string }) => c.slug)
    expect(due).not.toContain('checked-old')
    expect(due).not.toContain('never-due')

    await ok(call('POST', '/estate/verifications', { slug: 'proxy-k8s', outcome: 'contradicted' }))
    expect((await search({ q: 'proxy' })).claims.map((c) => c.slug)).not.toContain('proxy-k8s')
    const flagged = (await search({ q: 'proxy', contradicted: 'true' })).claims.find((c) => c.slug === 'proxy-k8s')
    expect(flagged?.contradicted).toBe(true)

    await ok(call('POST', '/estate/verifications', { slug: 'proxy-k8s', outcome: 'holds' }))
    const back = (await search({ q: 'proxy' })).claims.find((c) => c.slug === 'proxy-k8s')
    expect(back?.contradicted).toBe(false)
    expect(new Date(back?.reconfirmAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 89 * 86_400_000)
  })
})

describe('history', () => {
  const agent = { session: 'sess-1', model: 'claude-code/opus-5.5' }
  type Commit = { id: string; actor: string; session: string; model: string; operation: string; reason: string }

  it('makes an accepted suggestion one commit naming client, session and model', async () => {
    const made = await ok(
      call('POST', '/estate/suggestions', { steps: [record('stamped')], reason: 'note the stamp' }, agent),
    )
    const listed = (await ok(call('GET', '/estate/suggestions'))).find((x: { id: string }) => x.id === made.id)
    expect(listed).toMatchObject({ author: 'tester', ...agent })
    const accepted = await ok(
      call('POST', `/estate/suggestions/${made.id}/accept`, {}, { model: 'claude-code/fable-5.2' }),
    )
    const [rev] = (await get('stamped')).revisions as { n: number; commit: Commit }[]
    expect(rev?.commit).toMatchObject({
      id: accepted.commit,
      actor: 'tester',
      session: null,
      model: 'claude-code/fable-5.2',
      operation: 'estate.suggestions.accept',
      reason: 'note the stamp',
    })
    expect((await call('GET', '/estate/claims', undefined, { model: 'not a model' })).status).toBe(400)
  })

  it('records a merge as one commit over both subjects, found by session', async () => {
    await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'dns-old', home: 'homelab' }))
    await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'dns', home: 'homelab' }))
    await ok(call('POST', '/core/subjects/merge', { kind: 'topic', from: 'dns-old', into: 'dns' }, agent))
    const { commits } = await ok(call('GET', '/core/history', { session: 'sess-1' }))
    const [merge] = commits as (Commit & { revisions: { kind: string; n: number; name: string }[]; hidden: number })[]
    expect(merge).toMatchObject({ operation: 'core.subjects.merge', ...agent, hidden: 0 })
    expect(merge?.revisions.map((r) => [r.kind, r.name, r.n]).sort()).toEqual([
      ['core.subject', 'dns', 2],
      ['core.subject', 'dns-old', 2],
    ])
    const dns = await ok(call('GET', '/core/subjects/get', { kind: 'topic', name: 'dns' }))
    expect(dns.revisions.map((r: { n: number }) => r.n)).toEqual([2, 1])
    const loser = (await ok(call('GET', '/core/history/get', { commit: merge?.id }))).revisions.find(
      (r: { name: string }) => r.name === 'dns-old',
    )
    expect(loser.snapshot).toMatchObject({ name: 'dns-old', retiredAt: expect.any(String) })
  })

  it('records space changes, an isolation flip included', async () => {
    await ok(call('POST', '/core/spaces', { path: 'lab' }))
    await ok(call('POST', '/core/spaces/isolate', { path: 'lab', isolated: true }))
    const lab = await ok(call('GET', '/core/spaces/get', { path: 'lab' }, { space: 'lab' }))
    expect(lab.revisions.map((r: { n: number; commit: Commit }) => [r.n, r.commit.operation])).toEqual([
      [2, 'core.spaces.isolate'],
      [1, 'core.spaces.create'],
    ])
    const flip = await ok(call('GET', '/core/history/get', { commit: lab.revisions[0].commit.id }, { space: 'lab' }))
    expect(flip.revisions).toMatchObject([{ kind: 'core.space', name: 'lab', snapshot: { isolated: true } }])
    const commits = (await ok(call('GET', '/core/history'))).commits.map((c: { operation: string }) => c.operation)
    expect(commits).not.toContain('core.spaces.isolate')
  })

  it('shows a commit only as far as the reader sees, counting the rest', async () => {
    const shared = await get('shared-fact')
    const both = await propose(
      [
        { step: 'claim.edit', slug: 'shared-fact', revision: shared.revision, detail: 'edited from work' },
        record('work-history'),
      ],
      work,
    )
    const accepted = await ok(approve(both.id, work))
    const open = await ok(call('GET', '/core/history/get', { commit: accepted.commit }))
    expect(open.revisions.map((r: { name: string }) => r.name)).toEqual(['shared-fact'])
    expect(open.hidden).toBe(1)
    const inside = await ok(call('GET', '/core/history/get', { commit: accepted.commit }, work))
    expect(inside.hidden).toBe(0)
    const workClaim = await get('work-history', work)
    expect((await call('GET', '/core/history', { kind: 'estate.claim', id: workClaim.id })).body.revisions).toEqual([])
  })

  it('keeps a removed instruction history, the last revision marked deleted', async () => {
    const made = await add({ title: 'Short lived', body: 'gone soon', home: 'homelab', enabled: false })
    const id = (
      await hubd.database.db.execute(
        sql`select record_id from hubd.name where kind = 'estate.instruction' and name = ${made.name}`,
      )
    )[0]?.record_id as string
    await ok(call('DELETE', '/estate/instructions', { name: made.name }))
    const { revisions } = await ok(call('GET', '/core/history', { kind: 'estate.instruction', id }))
    expect(revisions.map((r: { n: number; deleted: boolean }) => [r.n, r.deleted])).toEqual([
      [2, true],
      [1, false],
    ])
  })

  it('squashes revisions past retention into a baseline and drops emptied commits', async () => {
    await land([record('squashed', { home: 'homelab' })])
    for (const n of [1, 2]) {
      await land([{ step: 'claim.edit', slug: 'squashed', revision: n, detail: `edit ${n}` }])
    }
    const before = await get('squashed')
    const old = before.revisions.filter((r: { n: number }) => r.n < 3).map((r: { commit: Commit }) => r.commit.id)
    await hubd.database.db.execute(
      sql`update hubd.commit set at = now() - interval '400 days' where id in (${sql.join(
        old.map((id: string) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    )
    const done = await squash(hubd.database.db, 365)
    expect(done.dropped).toBeGreaterThan(0)
    const after = (await get('squashed')).revisions as { n: number; baseline: boolean }[]
    expect(after.map((r) => [r.n, r.baseline])).toEqual([
      [3, false],
      [2, true],
    ])
    const first = before.revisions.find((r: { n: number }) => r.n === 1).commit.id
    const [gone] = await hubd.database.db.execute(
      sql`select count(*)::int as n from hubd.commit where id = ${first}::uuid`,
    )
    expect(gone?.n).toBe(0)
  })
})

describe('triage', () => {
  it('reports a link that crosses isolation without naming the hidden end, and unassigned items', async () => {
    const pointer = await get('pointer')
    await hubd.database.db.execute(
      sql`insert into hubd.link (from_kind, from_id, kind, to_subject) select 'estate.claim', ${pointer.id}, 'mentions', s.id from hubd.subject s where s.home = (select id from hubd.space where name = 'work')`,
    )
    await ok(call('POST', '/core/subjects', { kind: 'asset', name: 'client-db', type: 'store' }, work))
    await hubd.database.db.execute(
      sql`insert into hubd.link (from_kind, from_id, kind, to_subject) select 'estate.claim', ${pointer.id}, 'mentions', s.id from hubd.subject s where s.name = 'client-db'`,
    )
    await ok(call('POST', '/core/subjects', { kind: 'topic', name: 'loose' }))
    const found = await ok(call('GET', '/core/triage'))
    expect(found.crossing).toContainEqual({
      from: { kind: 'estate.claim', id: pointer.id },
      to: 'something this session cannot see',
    })
    expect(found.unassigned.subjects.map((s: { name: string }) => s.name)).toContain('loose')
    expect(found.unassigned.records.length).toBeGreaterThan(0)
  })

  it('drops a deleted claim names with it', async () => {
    const c = await get('issue-b')
    await hubd.database.db.execute(sql`delete from estate.claim where id = ${c.id}`)
    const [row] = await hubd.database.db.execute(
      sql`select count(*)::int as n from hubd.name where record_id = ${c.id}`,
    )
    expect(row?.n).toBe(0)
  })
})
