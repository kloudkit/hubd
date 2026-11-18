import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, constants, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3'
import type { StorageConfig } from './config.ts'

export interface Store {
  readonly kind: 'volume' | 's3'
  readonly where: string
  check(): Promise<string | null>
  has(key: string): Promise<boolean>
  put(key: string, body: Uint8Array): Promise<void>
  get(key: string): Promise<ReadableStream<Uint8Array> | null>
  remove(key: string): Promise<void>
}

export const fileKey = (sha256: string) => `files/${sha256.slice(0, 2)}/${sha256}`

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code ?? (e instanceof Error ? e.message : String(e))

class VolumeStore implements Store {
  readonly kind = 'volume'
  readonly #dir: string

  constructor(dir: string) {
    this.#dir = dir
  }

  get where() {
    return this.#dir
  }

  #path(key: string) {
    return join(this.#dir, key)
  }

  async check() {
    try {
      if (!(await stat(this.#dir)).isDirectory()) return `HUBD_STORAGE_DIR ${this.#dir} is not a directory.`
    } catch (e) {
      return code(e) === 'ENOENT'
        ? `HUBD_STORAGE_DIR ${this.#dir} does not exist: mount a volume there, or set HUBD_STORAGE_DIR.`
        : `HUBD_STORAGE_DIR ${this.#dir} cannot be read (${code(e)}).`
    }
    try {
      await mkdir(join(this.#dir, 'files'), { recursive: true, mode: 0o700 })
      await access(join(this.#dir, 'files'), constants.W_OK)
      return null
    } catch (e) {
      return `HUBD_STORAGE_DIR ${this.#dir} is not writable (${code(e)}).`
    }
  }

  async has(key: string) {
    try {
      return (await stat(this.#path(key))).isFile()
    } catch {
      return false
    }
  }

  async put(key: string, body: Uint8Array) {
    const path = this.#path(key)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const tmp = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, body, { mode: 0o600 })
      await rename(tmp, path)
    } finally {
      await rm(tmp, { force: true })
    }
  }

  async get(key: string) {
    if (!(await this.has(key))) return null
    return Readable.toWeb(createReadStream(this.#path(key))) as ReadableStream<Uint8Array>
  }

  async remove(key: string) {
    await rm(this.#path(key), { force: true })
  }
}

const CHECK_TIMEOUT_MS = 5000
const notFound = (e: unknown) =>
  e instanceof S3ServiceException &&
  (e.$metadata.httpStatusCode === 404 || e.name === 'NoSuchKey' || e.name === 'NotFound')

class S3Store implements Store {
  readonly kind = 's3'
  readonly #c: Extract<StorageConfig, { kind: 's3' }>
  readonly #s3: S3Client

  constructor(c: Extract<StorageConfig, { kind: 's3' }>) {
    this.#c = c
    this.#s3 = new S3Client({ region: c.region, ...(c.endpoint ? { endpoint: c.endpoint, forcePathStyle: true } : {}) })
  }

  get where() {
    return `s3://${this.#c.bucket}/${this.#c.prefix}${this.#c.endpoint ? ` at ${this.#c.endpoint}` : ''}`
  }

  #key(key: string) {
    return this.#c.prefix + key
  }

  async check() {
    try {
      await this.#s3.send(new HeadBucketCommand({ Bucket: this.#c.bucket }), {
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      })
      return null
    } catch (e) {
      const why = e instanceof S3ServiceException ? `${e.$metadata.httpStatusCode ?? ''} ${e.name}`.trim() : code(e)
      return `The S3 bucket ${this.#c.bucket}${this.#c.endpoint ? ` at ${this.#c.endpoint}` : ''} cannot be used (${why}).`
    }
  }

  async has(key: string) {
    try {
      await this.#s3.send(new HeadObjectCommand({ Bucket: this.#c.bucket, Key: this.#key(key) }))
      return true
    } catch (e) {
      if (notFound(e)) return false
      throw e
    }
  }

  async put(key: string, body: Uint8Array) {
    await this.#s3.send(
      new PutObjectCommand({
        Bucket: this.#c.bucket,
        Key: this.#key(key),
        Body: body,
        ContentType: 'application/octet-stream',
      }),
    )
  }

  async get(key: string) {
    try {
      const r = await this.#s3.send(new GetObjectCommand({ Bucket: this.#c.bucket, Key: this.#key(key) }))
      return r.Body ? (r.Body.transformToWebStream() as ReadableStream<Uint8Array>) : null
    } catch (e) {
      if (notFound(e)) return null
      throw e
    }
  }

  async remove(key: string) {
    await this.#s3.send(new DeleteObjectCommand({ Bucket: this.#c.bucket, Key: this.#key(key) }))
  }
}

export const storeFor = (c: StorageConfig): Store => (c.kind === 's3' ? new S3Store(c) : new VolumeStore(c.dir))
