import { hash } from 'node:crypto'
import type { Actor } from '@hubd/sdk'
import type { Context, Hono } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { EncryptJWT, type JWTPayload, jwtDecrypt } from 'jose'
import * as oidc from 'openid-client'
import type { CoreConfig } from './config.ts'
import type { Env } from './operations.ts'

export type User = Extract<Actor, { kind: 'user' }>

const SESSION = 'hubd_session'
const FLOW = 'hubd_flow'
const FLOW_SECONDS = 600

type Flow = { verifier: string; state: string; nonce: string }

export class Auth {
  readonly #settings: CoreConfig
  readonly #key: Uint8Array
  #discovered: Promise<oidc.Configuration> | null = null

  constructor(settings: CoreConfig) {
    this.#settings = settings
    this.#key = hash('sha256', settings.sessionSecret ?? '', 'buffer')
  }

  get on(): boolean {
    return this.#settings.auth === 'oidc'
  }

  get #secure(): boolean {
    return this.#settings.publicUrl?.startsWith('https://') ?? false
  }

  #config(): Promise<oidc.Configuration> {
    const s = this.#settings
    this.#discovered ??= oidc
      .discovery(new URL(s.oidcIssuer ?? ''), s.oidcClientId ?? '', s.oidcClientSecret, undefined, {
        execute: s.oidcIssuer?.startsWith('http://') ? [oidc.allowInsecureRequests] : [],
      })
      .catch((e) => {
        this.#discovered = null
        throw e
      })
    return this.#discovered
  }

  async #seal(payload: JWTPayload, seconds: number): Promise<string> {
    return new EncryptJWT(payload)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt()
      .setExpirationTime(`${seconds}s`)
      .encrypt(this.#key)
  }

  async #open<T>(token: string | undefined): Promise<T | null> {
    if (!token) return null
    try {
      return (await jwtDecrypt(token, this.#key)).payload as T
    } catch {
      return null
    }
  }

  session(user: Omit<User, 'kind'>): Promise<string> {
    return this.#seal({ sub: user.id, email: user.email, name: user.name }, this.#settings.sessionDays * 86_400)
  }

  async user(c: Context): Promise<User | null> {
    if (!this.on) return null
    const s = await this.#open<{ sub: string; email: string; name: string }>(getCookie(c, SESSION))
    return s ? { kind: 'user', id: s.sub, email: s.email, name: s.name } : null
  }

  #allowed(claims: Record<string, unknown>): boolean {
    const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : ''
    const raw = claims[this.#settings.oidcGroupsClaim]
    const groups = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).map((g) => String(g).toLowerCase())
    return this.#settings.authAllow.some((x) => x === email || groups.includes(x))
  }

  mount(app: Hono<Env>): void {
    const callback = `${this.#settings.publicUrl?.replace(/\/+$/, '')}/auth/callback`
    const cookie = { httpOnly: true, sameSite: 'Lax', secure: this.#secure } as const

    app.get('/auth/me', async (c) => c.json({ mode: this.#settings.auth, user: await this.user(c) }))

    app.get('/auth/login', async (c) => {
      if (!this.on) return c.redirect('/')
      const flow: Flow = {
        verifier: oidc.randomPKCECodeVerifier(),
        state: oidc.randomState(),
        nonce: oidc.randomNonce(),
      }
      setCookie(c, FLOW, await this.#seal(flow, FLOW_SECONDS), { ...cookie, path: '/auth', maxAge: FLOW_SECONDS })
      const url = oidc.buildAuthorizationUrl(await this.#config(), {
        redirect_uri: callback,
        scope: this.#settings.oidcScopes,
        state: flow.state,
        nonce: flow.nonce,
        code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
        code_challenge_method: 'S256',
      })
      return c.redirect(url.href)
    })

    app.get('/auth/callback', async (c) => {
      if (!this.on) return c.redirect('/')
      const flow = await this.#open<Flow>(getCookie(c, FLOW))
      deleteCookie(c, FLOW, { path: '/auth' })
      if (!flow) return c.text('The sign-in expired or came from another browser. Start again at /auth/login.', 400)
      const tokens = await oidc.authorizationCodeGrant(
        await this.#config(),
        new URL(`${callback}${new URL(c.req.url).search}`),
        { pkceCodeVerifier: flow.verifier, expectedState: flow.state, expectedNonce: flow.nonce },
      )
      const claims: Record<string, unknown> = tokens.claims() ?? {}
      if (!this.#allowed(claims)) return c.text(`${String(claims.email ?? claims.sub)} may not use this hubd.`, 403)
      const email = String(claims.email ?? '')
      const user = { id: String(claims.sub), email, name: String(claims.name ?? claims.preferred_username ?? email) }
      setCookie(c, SESSION, await this.session(user), {
        ...cookie,
        path: '/',
        maxAge: this.#settings.sessionDays * 86_400,
      })
      return c.redirect('/')
    })

    app.post('/auth/logout', (c) => {
      deleteCookie(c, SESSION, { path: '/' })
      return c.json({ ok: true })
    })
  }
}
