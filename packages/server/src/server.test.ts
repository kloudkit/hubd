import { mkdtempSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hubd } from '@hubd/core'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Api, boot } from './harness.ts'

let hubd: Hubd
let stop: () => Promise<void>
const api: Api = { base: '', token: '' }
let base: string
const clientDir = mkdtempSync(join(tmpdir(), 'hubd-client-'))
for (const [name, body] of Object.entries({
  'install.sh': "#!/bin/sh\nHUBD_URL=''\nCODE=''\necho install\n",
  'checksums.txt': 'abc  hubridge-linux-amd64\n',
  'manifest.json': '{"version":"v0.10.0","protocol":1,"assets":{}}',
  'hubridge-linux-amd64': 'binary',
})) {
  writeFileSync(join(clientDir, name), body)
}
let token: string

beforeAll(async () => {
  ;({ hubd, stop } = await boot(api, {
    client: 'e2e',
    env: {
      HUBD_JOBS_POLL_SECONDS: '0.5',
      HUBD_MAX_BODY_BYTES: '4096',
      HUBD_PLUGIN_HELLO_GREETING: 'Shalom',
      HUBD_PUBLIC_URL: 'https://hubd.example',
      HUBD_CLIENT_DIR: clientDir,
    },
  }))
  token = api.token
  base = api.base
}, 180_000)

afterAll(() => stop?.())

const auth = () => ({ authorization: `Bearer ${token}` })

const get = (path: string, headers: Record<string, string> = auth()) => fetch(`${base}${path}`, { headers })

const statusWithHost = (host: string) =>
  new Promise<number>((resolve, reject) => {
    request(`${base}/health`, { headers: { host } }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
      .on('error', reject)
      .end()
  })

describe('hubd with the hello plugin', () => {
  it('migrates again without change', async () => {
    expect(await hubd.migrate()).toEqual(['core', 'hello', 'todos', 'estate'])
  })

  it('makes time-ordered ids', async () => {
    const a = (await hubd.clients.create('first')).id
    const b = (await hubd.clients.create('second')).id
    expect(a < b).toBe(true)
    expect(a[14]).toBe('7')
  })

  it('answers health without a token and refuses the API and MCP without one', async () => {
    expect((await get('/health', {})).status).toBe(200)
    const refused = await get('/api/meta', {})
    expect(refused.status).toBe(401)
    expect(refused.headers.get('www-authenticate')).toBe('Bearer')
    expect(refused.headers.get('content-type')).toBe('application/problem+json')
    expect((await fetch(`${base}/mcp`, { method: 'POST' })).status).toBe(401)
    expect((await get('/api/meta', { authorization: 'Bearer nope' })).status).toBe(401)
  })

  it('answers liveness without I/O and readiness with every check', async () => {
    const live = await get('/health', {})
    expect(live.headers.get('content-type')).toBe('application/health+json')
    expect(await live.json()).toEqual({ status: 'pass', version: '0.0.0' })
    const ready = await (await get('/health?ready', {})).json()
    expect(ready.status).toBe('pass')
    expect(Object.keys(ready.checks).sort()).toEqual(['database:responseTime', 'jobs:started'])
    expect(ready.checks['database:responseTime'][0]).toMatchObject({ status: 'pass', observedUnit: 'ms' })
  })

  it('refuses a foreign Host and Origin', async () => {
    expect(await statusWithHost('evil.example')).toBe(421)
    expect(await statusWithHost('localhost:1234')).toBe(200)
    expect((await get('/health', { origin: 'http://evil.example' })).status).toBe(403)
  })

  it('lists plugins in /api/meta', async () => {
    const meta = await (await get('/api/meta')).json()
    expect(meta.plugins.map((p: { id: string }) => p.id)).toEqual(['estate', 'hello', 'todos'])
    expect(meta.actor).toMatchObject({ kind: 'client', name: 'e2e' })
  })

  it('serves one operation as an MCP tool and a REST route over the same table', async () => {
    const client = new Client({ name: 'e2e', version: '0.0.0' })
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: auth() } }),
    )
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'claims_about',
        'claims_get',
        'claims_map',
        'claims_search',
        'hello_greet',
        'hello_list',
        'history_get',
        'history_list',
        'instructions_add',
        'instructions_get',
        'instructions_list',
        'instructions_order',
        'instructions_remove',
        'instructions_update',
        'labels_add',
        'labels_list',
        'labels_remove',
        'labels_update',
        'profile_get',
        'spaces_archive',
        'spaces_create',
        'spaces_get',
        'spaces_isolate',
        'spaces_list',
        'spaces_move',
        'spaces_restore',
        'spaces_update',
        'subjects_alias',
        'subjects_create',
        'subjects_get',
        'subjects_list',
        'subjects_merge',
        'subjects_rename',
        'subjects_retire',
        'subjects_revive',
        'subjects_update',
        'suggestions_accept',
        'suggestions_add',
        'suggestions_list',
        'suggestions_reject',
        'todo_add',
        'todo_attach',
        'todo_counts',
        'todo_done',
        'todo_get',
        'todo_list',
        'todo_reminder',
        'todo_reminders',
        'todo_undo',
        'todo_update',
        'triage_list',
        'verifications_due',
        'verifications_report',
      ].sort(),
    )
    expect(tools.find((t) => t.name === 'hello_list')?.annotations?.readOnlyHint).toBe(true)
    expect(client.getInstructions()).toMatch(/rules files in ~\/\.claude\/rules\/hubd\//)

    const res = await client.callTool({ name: 'hello_greet', arguments: { name: 'world' } })
    const out = JSON.parse((res.content as { text: string }[])[0]?.text ?? '{}')
    expect(out).toMatchObject({ message: 'Shalom, world!', greeting: { name: 'world', by: 'e2e' } })
    expect((await client.callTool({ name: 'hello_greet', arguments: { name: '' } })).isError).toBe(true)
    await client.close()

    const rest = await fetch(`${base}/api/hello/greetings`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'rest' }),
    })
    expect(rest.status).toBe(201)
    expect((await rest.json()).greeting.name).toBe('rest')

    const list = await (await get('/api/hello/greetings?limit=1')).json()
    expect(list.map((g: { name: string }) => g.name)).toEqual(['rest'])

    const invalid = await get('/api/hello/greetings?limit=0')
    expect(invalid.status).toBe(400)
    expect(invalid.headers.get('content-type')).toBe('application/problem+json')
  })

  it('runs the job a greeting enqueues in its own transaction', async () => {
    await expect
      .poll(
        async () =>
          (await (await get('/api/hello/greetings?limit=100')).json()).every(
            (g: { welcomedAt: string | null }) => g.welcomedAt,
          ),
        {
          timeout: 15_000,
          interval: 250,
        },
      )
      .toBe(true)
  })

  it('tags responses with a request id and security headers, and refuses an oversized body', async () => {
    const res = await get('/api/meta')
    expect(res.headers.get('x-request-id')).toBeTruthy()
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    const big = await fetch(`${base}/api/hello/greetings`, {
      method: 'POST',
      headers: { ...auth(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(5000) }),
    })
    expect(big.status).toBe(413)
    expect(big.headers.get('content-type')).toBe('application/problem+json')
  })

  it('speaks the client handshake: hello, a one-time enroll, and the install files', async () => {
    expect(await (await get('/api/client/hello')).json()).toEqual({ protocol: 1 })
    expect((await get('/api/client/hello', {})).status).toBe(401)

    const { code } = await hubd.clients.invite('laptop')
    const script = await (await get(`/install?code=${code}`, {})).text()
    expect(script).toContain("HUBD_URL='https://hubd.example'")
    expect(script).toContain(`CODE='${code}'`)
    expect((await get('/install?code=bad%20code', {})).status).toBe(400)
    expect(await (await get('/install/files/hubridge-linux-amd64', {})).text()).toBe('binary')
    expect((await get('/install/checksums.txt', {})).status).toBe(200)
    expect((await get('/install/files/evil', {})).status).toBe(404)
    expect((await get('/install/manifest.json.sig', {})).status).toBe(404)

    const enroll = (c: string) =>
      fetch(`${base}/api/client/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: c }),
      })
    const first = await enroll(code)
    expect(first.status).toBe(200)
    const enrolled = await first.json()
    expect(enrolled.name).toBe('laptop')
    const meta = await (await get('/api/meta', { authorization: `Bearer ${enrolled.token}` })).json()
    expect(meta.actor).toMatchObject({ kind: 'client', name: 'laptop' })
    expect((await enroll(code)).status).toBe(401)
    await expect(hubd.clients.invite('laptop')).rejects.toMatchObject({ status: 409 })
  })

  it('describes the REST routes in OpenAPI', async () => {
    const doc = await (await get('/api/openapi.json')).json()
    expect(doc.paths['/api/hello/greetings'].post.operationId).toBe('hello.greet')
    expect(doc.paths['/api/hello/greetings'].get.parameters[0]).toMatchObject({ name: 'limit', in: 'query' })
  })
})
