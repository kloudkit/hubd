import { hash, randomBytes } from 'node:crypto'

export const CODE_TTL_MS = 15 * 60_000

export const sha256 = (data: string | Uint8Array): string => hash('sha256', data)

export const oneTimeCode = (): string => randomBytes(18).toString('base64url')
