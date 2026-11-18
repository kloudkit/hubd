import { estate } from '@hubd/plugin-estate'
import { hello } from '@hubd/plugin-hello'
import { todos } from '@hubd/plugin-todos'
import type { PluginModule } from '@hubd/sdk'

export const plugins: PluginModule[] = [hello, todos, estate]
