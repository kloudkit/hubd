import { setting } from '@hubd/sdk'
import { z } from 'zod'

export const configSchema = z.object({
  mcpMaxBytes: setting
    .number()
    .pipe(z.number().int().positive())
    .default(5 * 1024 * 1024),
})

export type TodosConfig = z.output<typeof configSchema>
