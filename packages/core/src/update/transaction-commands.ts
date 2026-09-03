import type { CommandResult, CommandRunner, CommandSpec, UpdatePlanStep } from './types.js'
import { isCommandSuccessful } from './command-runner.js'

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
