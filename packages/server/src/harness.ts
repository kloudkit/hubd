import { Hubd, PinoLogger } from '@hubd/core'
import { PostgreSqlContainer } from '@testcontainers/postgresql'
import { expect } from 'vitest'
import { plugins } from './plugins.ts'

export type Reply = { status: number; body: ReturnType<typeof JSON.parse> }

export type Api = {
  base: string
  token: string
}

export const caller =
  (api: Api) =>
  async (
    method: string,
    path: string,
    body?: object,
    options: { space?: string; as?: string; session?: string; model?: string } = {},
  ) => {
    const headers: Record<string, string> = { authorization: `Bearer ${options.as ?? api.token}` }
    if (options.space) headers['x-hubd-space'] = options.space
    if (options.session) headers['x-hubd-session'] = options.session
    if (options.model) headers['x-hubd-model'] = options.model
    let url = `${api.base}/api${path}`
    if (body && (method === 'GET' || method === 'DELETE'))
      url += `?${new URLSearchParams(body as Record<string, string>)}`
    else if (body) headers['content-type'] = 'application/json'
    const res = await fetch(url, {
      method,
      headers,
      body: body && method !== 'GET' && method !== 'DELETE' ? JSON.stringify(body) : undefined,
    })
    return { status: res.status, body: await res.json() } as Reply
  }

export const ok = async (reply: Promise<Reply>) => {
  const r = await reply
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body)}`)
  return r.body
}

export const names = (rows: { name?: string; path?: string }[]) => rows.map((r) => r.path ?? r.name).sort()

export async function boot(
  api: Api,
  options: { env?: NodeJS.ProcessEnv; before?: (hubd: Hubd) => void; client?: string } = {},
) {
  const pg = await new PostgreSqlContainer('postgres:18-alpine').start()
  const logged: string[] = []
  const hubd = new Hubd({
    plugins,
    logger: PinoLogger.collecting('warn', logged),
    env: { HUBD_DATABASE_URL: pg.getConnectionUri(), HUBD_MIGRATE: 'true', ...options.env },
  })
  options.before?.(hubd)
  await hubd.start()
  api.token = (await hubd.clients.create(options.client ?? 'tester')).token
  api.base = (await hubd.listen(0)).origin
  return {
    hubd,
    async stop() {
      expect(logged).toEqual([])
      await hubd.shutdown()
      await pg.stop()
    },
  }
}
