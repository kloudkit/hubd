import { setting } from '@hubd/sdk'
import { z } from 'zod'

export const configSchema = z.object({
  mcpMaxBytes: setting
    .number()
    .pipe(z.number().int().positive())
    .default(5 * 1024 * 1024),
  doneRetentionDays: setting
    .number()
    .pipe(z.number().int().min(0))
    .default(30)
    .describe('days a done todo is kept before a nightly job deletes it; 0 keeps all'),
})

export type TodosConfig = z.output<typeof configSchema>
