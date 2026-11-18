import type { CoreSetup, Plugin, PluginInitializerContext } from '@hubd/sdk'
import type { HelloConfig } from './config.ts'
import { onReminderDue, onTodoDone, welcome } from './jobs.ts'
import { addNote, deleteNote, listNotes } from './notes.ts'
import { greet, list } from './operations.ts'
import { greetings, notes } from './schema.ts'

export type HelloSetup = { greetings: typeof greetings }

export class HelloPlugin implements Plugin<HelloSetup> {
  readonly #context: PluginInitializerContext<HelloConfig>

  constructor(context: PluginInitializerContext<HelloConfig>) {
    this.#context = context
  }

  setup(core: CoreSetup): HelloSetup {
    core.operations.add(greet(this.#context.config), list, addNote, listNotes, deleteNote)
    core.records.register({ kind: 'note', table: notes, id: notes.id, home: notes.home })
    core.jobs.add(welcome)
    core.events.subscribe(onTodoDone, onReminderDue)
    this.#context.logger.debug(`greeting with "${this.#context.config.greeting}"`)
    return { greetings }
  }
}
