import { describe, expect, it } from 'vitest'
import { PinoLogger } from './logger.ts'

describe('PinoLogger', () => {
  it('redacts secret fields and query parameters, wherever they appear', () => {
    const lines: string[] = []
    const logger = PinoLogger.collecting('info', lines)
    const failed = Object.assign(new Error('Failed query: select 1\nparams: s3cret,hubd_abc'), { params: ['s3cret'] })
    logger.error('query failed', failed)
    logger.with({ token: 'hubd_abc', databaseUrl: 'postgres://u:p@h/db' }).info('bound')
    const text = lines.join('\n')
    expect(text).not.toMatch(/s3cret|hubd_abc|u:p@h/)
    expect(text).toContain('params: [redacted]')
  })

  it('names child loggers by their path', () => {
    const lines: string[] = []
    PinoLogger.collecting('info', lines).get('plugins').get('hello').info('hi')
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ name: 'hubd.plugins.hello', msg: 'hi' })
    expect(lines[0]?.match(/"name":/g)).toHaveLength(1)
  })
})
