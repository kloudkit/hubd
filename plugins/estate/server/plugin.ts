import type { CoreSetup, Plugin } from '@hubd/sdk'
import { instructionOperations } from './instructions.ts'
import { claimOperations, suggestionOperations, verificationOperations } from './operations.ts'
import { profileOperations } from './profile.ts'
import { claim, instruction, source } from './schema.ts'

export class EstatePlugin implements Plugin {
  setup(core: CoreSetup): void {
    core.records.register({ kind: 'claim', table: claim, id: claim.id, home: claim.home, mention: 'claim' })
    core.records.register({ kind: 'source', table: source, id: source.id, home: source.home })
    core.records.register({ kind: 'instruction', table: instruction, id: instruction.id, home: instruction.home })
    core.operations.add(
      ...suggestionOperations,
      ...claimOperations,
      ...verificationOperations,
      ...profileOperations,
      ...instructionOperations,
    )
  }
}
