import type { PluginModule } from '@hubd/sdk'
import manifest from '../hubd.json' with { type: 'json' }
import { configSchema } from './config.ts'
import { HelloPlugin } from './plugin.ts'

export type { HelloConfig } from './config.ts'
export type { HelloSetup } from './plugin.ts'

export const hello: PluginModule<typeof configSchema> = {
  manifest,
  path: new URL('../', import.meta.url),
  config: configSchema,
  plugin: (context) => new HelloPlugin(context),
}
