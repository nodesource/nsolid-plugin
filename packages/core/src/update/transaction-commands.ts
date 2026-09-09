import type { CommandResult, CommandRunner, CommandSpec, ExecutableIdentity, UpdatePlanStep } from './types.js'
import { DEFAULT_COMMAND_TIMEOUT_MS, isCommandSuccessful } from './command-runner.js'
import { managerArgsForIdentity } from './package-manager.js'

export function transactionCommand (
  identity: Exclude<ExecutableIdentity, { kind: 'unsupported' }>,
  args: string[],
  description: string
): Extract<UpdatePlanStep, { kind: 'command' }> {
  return { kind: 'command', description, command: { ...managerArgsForIdentity(identity, args), executableIdentity: identity, timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS } }
}

export type TransactionCommandResult =
  | { success: true; completed: readonly CommandSpec[] }
  | { success: false; completed: readonly CommandSpec[]; command: CommandSpec; result: CommandResult }

export async function runTransactionCommands (
  steps: readonly UpdatePlanStep[],
  commandRunner: CommandRunner
): Promise<TransactionCommandResult> {
  const completed: CommandSpec[] = []
  for (const step of steps) {
    if (step.kind !== 'command') continue
    const result = await commandRunner.run(step.command)
    if (!isCommandSuccessful(result)) return { success: false, completed, command: step.command, result }
    completed.push(step.command)
  }
  return { success: true, completed }
}
