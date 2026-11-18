import type { CoreSetup, Plugin, PluginInitializerContext } from '@hubd/sdk'
import type { TodosConfig } from './config.ts'
import { purgeDone, remind } from './jobs.ts'
import { labelOperations, todoOperations } from './operations.ts'
import { todo } from './schema.ts'

export class TodosPlugin implements Plugin {
  readonly #context: PluginInitializerContext<TodosConfig>

  constructor(context: PluginInitializerContext<TodosConfig>) {
    this.#context = context
  }

  setup(core: CoreSetup): void {
    core.records.register({ kind: 'todo', table: todo, id: todo.id, home: todo.home })
    core.operations.add(...todoOperations(this.#context.config), ...labelOperations)
    core.jobs.add(remind)
    const days = this.#context.config.doneRetentionDays
    if (days > 0) {
      core.jobs.add(purgeDone(days))
      core.jobs.schedule('purge-done', '27 3 * * *')
    }
  }
}
