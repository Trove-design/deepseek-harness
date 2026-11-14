/**
 * Cache-aware ordering of the model-free prune pass relative to the summary.
 *
 * The summary call is cache-warm only while `[tools, system, region]` is a
 * byte prefix of the last routed request. Rewriting any node of that region
 * before the call moves the first divergent byte from the instruction to the
 * first rewritten tool result, and the provider prefills everything after it
 * again. When a summary will run anyway, region nodes are about to be
 * shadowed by the checkpoint, so pruning them saves nothing; only the
 * retained tail is pruned, and the tail is re-prefilled after the replacement
 * regardless because its position shifts.
 *
 * @module @deepseek-ai/dsh-compaction-basic/cache-aware-prune
 */

import type { ToolResultPruner, PlannedPrune } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { selectCompactableRange } from './region.ts'

/** What the pressure path should do with the model-free pass. */
export type PrunePlan =
  /** Nothing is over budget. */
  | { readonly kind: 'none' }
  /** The pass alone clears pressure: land it everywhere, as before. */
  | { readonly kind: 'prune-only' }
  /** A summary runs anyway: land only the nodes after the summarized region. */
  | { readonly kind: 'tail-only'; readonly tail: ReadonlySet<SessionSeq> }

/**
 * Re-price a measurement as if the planned replacements had landed, using the
 * same heuristic the shadow-price protocol records for each replacement.
 * @param meter - effective token meter.
 * @param measurement - current measurement of the unpruned surface.
 * @param plan - replacements the pass would land.
 * @returns a measurement over the same seqs with projected prices.
 */
export function projectPrunedMeasurement(
  meter: TokenMeter,
  measurement: TokenMeasurement,
  plan: readonly PlannedPrune[],
): TokenMeasurement {
  const savings = new Map<SessionSeq, number>()
  for (const { seq, original, content } of plan) {
    const replacement = freezeMessage<ToolResultMessage>({ ...original, content })
    savings.set(seq, Math.max(0, meter.estimateMessage(original) - meter.estimateMessage(replacement)))
  }
  let saved = 0
  const nodes = measurement.nodes.map((node) => {
    const delta = Math.min(node.tokens, savings.get(node.seq) ?? 0)
    if (delta === 0) return node
    saved += delta
    return { ...node, tokens: node.tokens - delta, heuristicTokens: Math.max(0, node.heuristicTokens - delta) }
  })
  return {
    ...measurement,
    nodes,
    surfaceTokens: measurement.surfaceTokens - saved,
    totalTokens: Math.max(0, measurement.totalTokens - saved),
  }
}

/**
 * Decide how the prune pass lands for one pressure compaction.
 * @param prune - the optional sibling pruner service.
 * @param meter - effective token meter.
 * @param session - session under pressure.
 * @param measurement - current measurement at or above the threshold.
 * @param thresholdTokens - resolved pressure threshold.
 * @param retainTokens - verbatim tail budget the summary keeps.
 * @returns the landing decision.
 */
export function planPrune(
  prune: Pick<ToolResultPruner, 'planSession'>,
  meter: TokenMeter,
  session: Session,
  measurement: TokenMeasurement,
  thresholdTokens: number,
  retainTokens: number,
): PrunePlan {
  const plan = prune.planSession(session)
  if (plan.length === 0) return { kind: 'none' }
  const projected = projectPrunedMeasurement(meter, measurement, plan)
  if (projected.totalTokens < thresholdTokens) return { kind: 'prune-only' }
  // Select on projected prices so the retained tail matches what the
  // summary would keep after a full pass; the tail is then pruned for real.
  const range = selectCompactableRange(session, projected, retainTokens)
  const nodes = session.surface.nodes
  const tailStart = range === null ? 0 : nodes.indexOf(range.end) + 1
  return { kind: 'tail-only', tail: new Set(nodes.slice(tailStart)) }
}
