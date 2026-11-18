import { Problem } from '@hubd/sdk'

export const STATEMENT_MAX = 600
export const DETAIL_MAX = 10_000
export const TITLE_MAX = 600
export const BODY_MAX = 20_000
export const LINE_GUIDE = 200
export const CLAIMS_FILE = 'hubd-claims'

const FENCE = /^[ \t]*(```|~~~)/
const IMPORT = /(^|[\s([])(@[~./\w][^\s)\]]*)/g

function prose(text: string, fn: (s: string) => string): string {
  let fenced = false
  return text
    .split('\n')
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      return fenced
        ? line
        : line
            .split(/(`[^`]*`)/)
            .map((part, i) => (i % 2 ? part : fn(part)))
            .join('')
    })
    .join('\n')
}

const split = (token: string): [string, string] => {
  const m = token.match(/^(.*?)([.,;:!?]*)$/)
  return [m?.[1] ?? token, m?.[2] ?? '']
}

function imports(text: string): string[] {
  const found: string[] = []
  prose(text, (s) => {
    for (const m of s.matchAll(IMPORT)) found.push(split(m[2] ?? '')[0])
    return s
  })
  return found
}

export const quoteImports = (text: string): string =>
  prose(text, (s) =>
    s.replace(IMPORT, (_, pre: string, token: string) => {
      const [path, tail] = split(token)
      return `${pre}\`${path}\`${tail}`
    }),
  )

export function checkBody(body: string): void {
  if (!body.trim()) throw new Problem(400, 'An instruction needs some text')
  if (body.length > BODY_MAX) {
    throw new Problem(400, `An instruction is at most ${BODY_MAX.toLocaleString('en')} characters`)
  }
  if (/^\s*---/.test(body)) {
    throw new Problem(400, 'An instruction may not start with ---: Claude Code would read it as frontmatter')
  }
  const found = imports(body)
  if (found.length) {
    throw new Problem(
      400,
      `${found.map((t) => `"${t}"`).join(', ')} would make Claude Code load that file into every session; put it in backticks if it is only a name`,
    )
  }
}

export const fileText = (body: string): string => `${body.replace(/\s+$/, '')}\n`

export const lineCount = (body: string): number => fileText(body).split('\n').length - 1

export function fileName(title: string): string {
  const s = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const cut = s.length > 40 ? s.slice(0, 41).replace(/-[^-]*$/, '') || s.slice(0, 40) : s
  return cut || 'instruction'
}

export const numbered = (base: string, n: number): string => (n < 2 ? base : `${base.slice(0, 36)}-${n}`)
