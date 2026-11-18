import type { Logger, LogLevel } from '@hubd/sdk'
import { destination, type Logger as Pino, pino, stdSerializers } from 'pino'
import pretty from 'pino-pretty'

const REDACT = [
  'token',
  'password',
  'secret',
  'authorization',
  'databaseUrl',
  '*.token',
  '*.password',
  '*.secret',
  '*.authorization',
  '*.databaseUrl',
  'err.params',
]

const PARAMS = /\nparams: [^\n]*/g

const serializers = {
  err: (error: Error) => {
    const out = stdSerializers.err(error)
    for (const key of ['message', 'stack'] as const) {
      if (typeof out[key] === 'string') out[key] = out[key].replace(PARAMS, '\nparams: [redacted]')
    }
    return out
  },
}

const settings = (level: LogLevel) => ({
  level,
  base: undefined,
  redact: { paths: REDACT, censor: '[redacted]' },
  serializers,
})

export class PinoLogger implements Logger {
  readonly #root: Pino
  readonly #name: string
  readonly #bindings: Record<string, unknown>
  readonly #pino: Pino

  constructor(root: Pino, name = 'hubd', bindings: Record<string, unknown> = {}) {
    this.#root = root
    this.#name = name
    this.#bindings = bindings
    this.#pino = root.child({ name, ...bindings })
  }

  static create(level: LogLevel, format: 'text' | 'json'): PinoLogger {
    const stream =
      format === 'json'
        ? destination({ fd: 2, sync: true })
        : pretty({ destination: 2, sync: true, ignore: 'pid,hostname', translateTime: 'SYS:HH:MM:ss.l' })
    return new PinoLogger(pino(settings(level), stream))
  }

  static silent(): PinoLogger {
    return new PinoLogger(pino({ level: 'silent' }))
  }

  static collecting(level: LogLevel, lines: string[]): PinoLogger {
    return new PinoLogger(pino(settings(level), { write: (line: string) => void lines.push(line) }))
  }

  debug(message: string): void {
    this.#pino.debug(message)
  }

  info(message: string): void {
    this.#pino.info(message)
  }

  warn(message: string): void {
    this.#pino.warn(message)
  }

  error(message: string, error?: unknown): void {
    if (error === undefined) this.#pino.error(message)
    else this.#pino.error({ err: error }, message)
  }

  get(name: string): Logger {
    return new PinoLogger(this.#root, `${this.#name}.${name}`, this.#bindings)
  }

  with(bindings: Record<string, unknown>): Logger {
    return new PinoLogger(this.#root, this.#name, { ...this.#bindings, ...bindings })
  }
}
