import type { PluginModule } from '@hubd/sdk'
import manifest from '../hubd.json' with { type: 'json' }
import { EstatePlugin } from './plugin.ts'

export const estate: PluginModule = {
  manifest,
  path: new URL('../', import.meta.url),
  plugin: () => new EstatePlugin(),
}
