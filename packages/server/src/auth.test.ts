import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hubd } from '@hubd/core'
import { OAuth2Server } from 'oauth2-mock-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type Api, boot } from './harness.ts'

const idp = new OAuth2Server()
const api: Api = { base: '', token: '' }
let hubd: Hubd
let stop: () => Promise<void>
let email = 'ops@example.com'

const webDir = mkdtempSync(join(tmpdir(), 'hubd-web-'))
mkdirSync(join(webDir, 'assets'))
writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>hubd</title><div id="root"></div>')
writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)')

const get = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${api.base}${path}`, { headers, redirect: 'manual' })

const cookie = (res: Response, name: string) =>
  res.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0] ?? ''

async function signIn(): Promise<{ res: Response; session: string }> {
  const login = await get('/auth/login')
  expect(login.status).toBe(302)
  const flow = cookie(login, 'hubd_flow')
  const authorize = await fetch(login.headers.get('location') ?? '', { redirect: 'manual' })
  const back = new URL(authorize.headers.get('location') ?? '')
  expect(back.pathname).toBe('/auth/callback')
  const res = await get(`/auth/callback${back.search}`, { cookie: flow })
  return { res, session: cookie(res, 'hubd_session') }
}

beforeAll(async () => {
  await idp.issuer.keys.generate('RS256')
  await idp.start(0, 'localhost')
  idp.service.on('beforeTokenSigning', (token) => {
    token.payload.email = email
    token.payload.name = 'Ops Person'
    token.payload.groups = ['hubd users']
  })
  ;({ hubd, stop } = await boot(api, {
    env: {
      HUBD_AUTH: 'oidc',
      HUBD_PUBLIC_URL: 'http://hubd.test',
      HUBD_OIDC_ISSUER: idp.issuer.url ?? '',
      HUBD_OIDC_CLIENT_ID: 'hubd',
      HUBD_OIDC_CLIENT_SECRET: 'secret',
      HUBD_AUTH_ALLOW: 'Ops@Example.com',
      HUBD_SESSION_SECRET: 'x'.repeat(40),
      HUBD_WEB_DIR: webDir,
    },
  }))
}, 180_000)

afterAll(async () => {
  await stop?.()
  await idp.stop()
})

describe('pages', () => {
  it('sends a visitor without a session to sign in, for the page and its assets', async () => {
    for (const path of ['/', '/some/route', '/assets/app.js']) {
      const res = await get(path)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/auth/login')
    }
  })

  it('answers an unknown API path with a 404, never the page', async () => {
    const res = await get('/api/nope', { authorization: `Bearer ${api.token}` })
    expect(res.status).toBe(404)
  })
})

describe('OIDC sign-in', () => {
  it('signs in through the provider and opens the page, assets and API with the session', async () => {
    const { res, session } = await signIn()
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    expect(session).toMatch(/^hubd_session=[\w-]+\.\.[\w-]+\.[\w-]+\.[\w-]+$/)

    const page = await get('/some/route', { cookie: session })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="root">')
    expect(await (await get('/assets/app.js', { cookie: session })).text()).toBe('console.log(1)')

    const me = await (await get('/auth/me', { cookie: session })).json()
    expect(me).toMatchObject({ mode: 'oidc', user: { kind: 'user', email: 'ops@example.com', name: 'Ops Person' } })
    const meta = await (await get('/api/meta', { cookie: session })).json()
    expect(meta.actor).toMatchObject({ kind: 'user', email: 'ops@example.com' })
  })

  it('keeps the session unreadable and refuses a tampered one', async () => {
    const { session } = await signIn()
    expect(Buffer.from(session.split('.')[2] ?? '', 'base64url').toString()).not.toContain('ops@example.com')
    const tampered = `${session.slice(0, -2)}xx`
    expect((await get('/', { cookie: tampered })).status).toBe(302)
    expect((await get('/api/meta', { cookie: tampered })).status).toBe(401)
  })

  it('refuses a user outside the allow list, by email or group', async () => {
    email = 'someone@example.com'
    const { res, session } = await signIn()
    expect(res.status).toBe(403)
    expect(session).toBe('')
    email = 'ops@example.com'
  })

  it('refuses a callback without the flow cookie', async () => {
    expect((await get('/auth/callback?code=x&state=y')).status).toBe(400)
  })

  it('still takes a client token on the API and MCP', async () => {
    const meta = await (await get('/api/meta', { authorization: `Bearer ${api.token}` })).json()
    expect(meta.actor).toMatchObject({ kind: 'client', name: 'tester' })
  })

  it('signs out by clearing the cookie', async () => {
    const res = await fetch(`${api.base}/auth/logout`, { method: 'POST' })
    expect(res.headers.getSetCookie().some((c) => c.startsWith('hubd_session=;'))).toBe(true)
  })

  it('issues a session that core reads back', async () => {
    const token = await hubd.auth.session({ id: 'u1', email: 'a@b.c', name: 'A' })
    const me = await (await get('/auth/me', { cookie: `hubd_session=${token}` })).json()
    expect(me.user).toMatchObject({ id: 'u1', email: 'a@b.c' })
  })
})
