import { existsSync, openAsBlob, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Problem } from '@hubd/sdk'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { Clients } from './clients.ts'
import { type Env, readJson } from './operations.ts'

const BINARY = /^hubridge-(linux|darwin)-(amd64|arm64)$/
const METADATA = {
  'checksums.txt': 'text/plain; charset=utf-8',
  'manifest.json': 'application/json',
  'manifest.json.sig': 'application/octet-stream',
} as const
const enrollBody = z.object({
  code: z.string().regex(Clients.CODE),
  os: z.enum(['linux', 'darwin']).optional(),
  arch: z.enum(['amd64', 'arm64']).optional(),
})

export class ClientProtocol {
  static readonly VERSION = 1

  readonly #clients: Clients
  readonly #dir: string | null
  readonly #script: string | null
  readonly #publicUrl: string | undefined
  readonly #allows: (host: string) => boolean

  constructor(clients: Clients, options: { dir?: string; publicUrl?: string; allows: (host: string) => boolean }) {
    this.#clients = clients
    this.#dir = options.dir && existsSync(join(options.dir, 'install.sh')) ? options.dir : null
    this.#script = this.#dir && readFileSync(join(this.#dir, 'install.sh'), 'utf8')
    this.#publicUrl = options.publicUrl?.replace(/\/+$/, '')
    this.#allows = options.allows
  }

  mountPublic(app: Hono<Env>): void {
    app.post('/api/client/enroll', async (c) => {
      const parsed = enrollBody.safeParse(await readJson(c))
      const enrolled = parsed.success
        ? await this.#clients.enroll(parsed.data.code, { os: parsed.data.os, arch: parsed.data.arch })
        : null
      if (!enrolled) throw new Problem(401, 'This install code is unknown, used or expired')
      return c.json(enrolled)
    })
    app.get('/install', (c) => this.#install(c))
    for (const [name, type] of Object.entries(METADATA)) app.get(`/install/${name}`, (c) => this.#file(c, name, type))
    app.get('/install/files/:name', (c) => this.#file(c, c.req.param('name'), 'application/octet-stream'))
  }

  mount(app: Hono<Env>): void {
    app.get('/api/client/hello', (c) => c.json({ protocol: ClientProtocol.VERSION }))
  }

  #base(c: Context): string {
    if (this.#publicUrl) return this.#publicUrl
    const url = new URL(c.req.url)
    const host = c.req.header('x-forwarded-host')
    const proto = c.req.header('x-forwarded-proto')
    const trusted = !host || this.#allows(host)
    const scheme = trusted && (proto === 'http' || proto === 'https') ? proto : url.protocol.slice(0, -1)
    return `${scheme}://${host && trusted ? host : url.host}`
  }

  #install(c: Context): Response {
    const fail = (status: 400 | 500 | 503, message: string) =>
      c.text(`echo "hubd install: ${message}" >&2; exit 1\n`, status)
    const code = c.req.query('code') ?? ''
    if (code && !Clients.CODE.test(code)) return fail(400, 'malformed install code')
    const base = this.#base(c)
    if (/['\\\s]/.test(base)) return fail(500, 'hubd has a malformed public URL')
    if (!this.#script) return fail(503, 'this hubd bundles no hubridge release (HUBD_CLIENT_DIR)')
    const script = this.#script
      .replace(/^HUBD_URL=''$/m, () => `HUBD_URL='${base}'`)
      .replace(/^CODE=''$/m, () => `CODE='${code}'`)
    return c.body(script, 200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' })
  }

  async #file(c: Context, name: string, type: string): Promise<Response> {
    const path = this.#dir && (name in METADATA || BINARY.test(name)) ? join(this.#dir, name) : null
    if (!path || !existsSync(path)) throw new Problem(404, 'Not found')
    const blob = await openAsBlob(path)
    return c.body(blob.stream(), 200, { 'content-type': type, 'content-length': String(blob.size) })
  }
}
