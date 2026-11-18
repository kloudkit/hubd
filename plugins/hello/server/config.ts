import { z } from 'zod'

export const configSchema = z.object({
  greeting: z.string().min(1).default('Hello'),
})

export type HelloConfig = z.output<typeof configSchema>
