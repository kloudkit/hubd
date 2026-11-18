import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { ClientProtocol } from './client.ts'
import type { Clients } from './clients.ts'
import { hostname } from './config.ts'
import type { Env } from './operations.ts'

const dir = mkdtempSync(join(tmpdir(), 'hubd-install-'))
writeFileSync(join(dir, 'install.sh'), "#!/bin/sh\nHUBD_URL=''\nCODE=''\n")

const scriptUrl = async (headers: Record<string, string>, publicUrl?: string) => {
  const allowed = new Set(['localhost', 'hubd.example'])
  const client = new ClientProtocol({} as Clients, { dir, publicUrl, allows: (h) => allowed.has(hostname(h)) })
  const app = new Hono<Env>()
  client.mountPublic(app)
  const script = await (await app.request('http://localhost/install', { headers })).text()
  return script.match(/^HUBD_URL='(.*)'$/m)?.[1]
}

describe('ClientProtocol', () => {
  it('speaks the protocol version the Go module declares', () => {
    const go = readFileSync(new URL('../../../protocol/protocol.go', import.meta.url), 'utf8')
    expect(Number(go.match(/const Version = (\d+)/)?.[1])).toBe(ClientProtocol.VERSION)
  })

  it('takes forwarded host and proto only when hubd allows them', async () => {
    expect(await scriptUrl({})).toBe('http://localhost')
    expect(await scriptUrl({ 'x-forwarded-host': 'hubd.example', 'x-forwarded-proto': 'https' })).toBe(
      'https://hubd.example',
    )
    expect(await scriptUrl({ 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' })).toBe(
      'http://localhost',
    )
    expect(await scriptUrl({ 'x-forwarded-proto': 'https' })).toBe('https://localhost')
    expect(await scriptUrl({ 'x-forwarded-proto': 'gopher' })).toBe('http://localhost')
    expect(await scriptUrl({ 'x-forwarded-host': 'evil.example' }, 'https://hubd.example/')).toBe(
      'https://hubd.example',
    )
  })
})
