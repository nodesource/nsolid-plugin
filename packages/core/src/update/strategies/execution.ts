import type { UpdateContext, UpdatePlanItem, UpdateResult } from '../types.js'

/** Cleanup authorization produced by an internal strategy execution. */
export type PlanResourceDisposition = 'release' | 'preserve'

/**
 * Internal-only execution result. The coordinator consumes the disposition and
 * publishes only `result`; it is deliberately not part of UpdateStrategy or
 * the package's public update types.
 */
export interface InternalUpdateExecutionOutcome {
  result: UpdateResult
  planResources: PlanResourceDisposition
}

export type InternalUpdateExecutor = {
  executeWithOutcome: (item: UpdatePlanItem, context: UpdateContext) => Promise<InternalUpdateExecutionOutcome>
}
