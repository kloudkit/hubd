#!/usr/bin/env node
import { styleText } from 'node:util'
import type { Hubd } from '@hubd/core'
import { Problem, VERSION } from '@hubd/sdk'
import { Command } from 'commander'

type Format = Parameters<typeof styleText>[0]

const paint = (format: Format) => (text: string) => styleText(format, text, { stream: process.stdout })

const program = new Command('hubd')
  .description('Mission control for your agents')
  .version(VERSION)
  .showHelpAfterError()
  .configureHelp({
    styleTitle: paint(['bold', 'underline']),
    styleCommandText: paint('cyan'),
    styleSubcommandText: paint('cyan'),
    styleOptionText: paint('green'),
    styleArgumentText: paint('yellow'),
    styleDescriptionText: paint('dim'),
  })

async function withHubd(run: (hubd: Hubd) => Promise<void>): Promise<void> {
  const [{ Hubd }, { plugins }] = await Promise.all([import('@hubd/core'), import('./plugins.ts')])
  const hubd = new Hubd({ plugins })
  try {
    await run(hubd)
  } finally {
    await hubd.shutdown()
  }
}

program
  .command('serve')
  .description('run the API and MCP server')
  .action(() =>
    withHubd(async (hubd) => {
      await hubd.start()
      await hubd.listen()
      hubd.logger.info(`${await hubd.lifecycle.untilSignal()}: shutting down`)
    }),
  )

program
  .command('health')
  .description('ask the server on HUBD_PORT for its health; exits 1 when it fails')
  .option('--ready', 'also check the database and the job queue')
  .action(async (options: { ready?: boolean }) => {
    const port = process.env.HUBD_PORT ?? '5181'
    const res = await fetch(`http://127.0.0.1:${port}/health${options.ready ? '?ready' : ''}`).catch(() => null)
    console.log(res ? await res.text() : '{"status":"fail"}')
    if (!res?.ok) process.exitCode = 1
  })

program
  .command('migrate')
  .description('apply core, plugin and job-queue migrations')
  .action(() => withHubd(async (hubd) => void (await hubd.migrate())))

const client = program.command('client').description('connect machines through hubridge')

client
  .command('invite')
  .description('print a one-time install command for a new machine, valid for 15 minutes')
  .argument('<name>', 'the machine name its token will carry')
  .action((name: string) =>
    withHubd(async (hubd) => {
      const { publicUrl, host, port } = hubd.settings
      if (!publicUrl) {
        hubd.logger.warn('HUBD_PUBLIC_URL is not set; the command uses this host, which other machines may not reach')
      }
      const { code, expiresAt } = await hubd.clients.invite(name)
      console.log(`curl -fsSL '${publicUrl ?? `http://${host}:${port}`}/install?code=${code}' | sh`)
      hubd.logger.info(`run it on "${name}" before ${expiresAt.toLocaleTimeString()}`)
    }),
  )

client
  .command('create')
  .description('make a client and print its token once, for a script or a machine set up by hand')
  .argument('<name>', 'a name for the machine or script')
  .action((name: string) =>
    withHubd(async (hubd) => {
      console.log((await hubd.clients.create(name)).token)
      hubd.logger.info(`client "${name}" made; its token is shown once and stored only as a hash`)
    }),
  )

client
  .command('list')
  .description('list clients, never their tokens')
  .option('--json', 'print JSON')
  .action((options: { json?: boolean }) =>
    withHubd(async (hubd) => {
      const rows = await hubd.clients.list()
      if (options.json) return console.log(JSON.stringify(rows, null, 2))
      for (const c of rows) {
        const seen = c.lastSeenAt?.toISOString() ?? 'never seen'
        console.log(
          [c.name, [c.os, c.arch].filter(Boolean).join('/') || '-', c.createdAt.toISOString(), seen].join('\t'),
        )
      }
    }),
  )

client
  .command('revoke')
  .description('delete a client and its token; what it made stays')
  .argument('<name>', 'the client to delete')
  .action((name: string) =>
    withHubd(async (hubd) => {
      console.log((await hubd.clients.revoke(name)) ? `revoked "${name}"` : `no client "${name}"`)
    }),
  )

try {
  await program.parseAsync()
} catch (e) {
  const { ConfigError } = await import('@hubd/core')
  if (!(e instanceof ConfigError) && !(e instanceof Problem)) throw e
  console.error(e.message)
  process.exitCode = e instanceof ConfigError ? 2 : 1
}
