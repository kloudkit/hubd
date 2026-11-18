import type { PluginModule } from '@hubd/sdk'
import manifest from '../hubd.json' with { type: 'json' }
import { configSchema } from './config.ts'
import { TodosPlugin } from './plugin.ts'

export const todos: PluginModule<typeof configSchema> = {
  manifest,
  path: new URL('../', import.meta.url),
  config: configSchema,
  plugin: (context) => new TodosPlugin(context),
}
