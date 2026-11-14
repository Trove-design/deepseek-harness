import type { ContentBlock, ToolCallId, ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Character-budget policy for deterministic tool-result pruning. */
export interface ToolResultPruneConfig {
  /** Prune when total text exceeds this many Unicode code points. Defaults to `8192`. */
  thresholdChars?: number
  /** Maximum leading Unicode code points retained. Defaults to `4096`. */
  headChars?: number
  /** Maximum trailing Unicode code points retained. Defaults to `1024`. */
  tailChars?: number
}

/** Validated, detached, deeply immutable pruning configuration. */
export interface ResolvedConfig {
  readonly thresholdChars: number
  readonly headChars: number
  readonly tailChars: number
}

/** Cited source event and size accounting for one landed surface replacement. */
export interface PrunedEntry {
  /** Full-fidelity tool-result event shadowed by the replacement. */
  readonly originalSeq: SessionSeq
  /** Newly appended pruned tool-result event. */
  readonly replacementSeq: SessionSeq
  /** Tool call shared by the original and replacement. */
  readonly callId: ToolCallId
  /** Original text size in Unicode code points. */
  readonly charsBefore: number
  /** Replacement text size in Unicode code points. */
  readonly charsAfter: number
}

/** One replacement a pass would land, computed without touching the log. */
export interface PlannedPrune {
  /** Current surface node whose tool result is over budget. */
  readonly seq: SessionSeq
  /** Model-visible message the node derives today. */
  readonly original: ToolResultMessage
  /** Pruned content the replacement would carry. */
  readonly content: ContentBlock[]
}

/** Aggregate outcome of one stable-surface pruning pass. */
export interface PruneResult {
  /** Replacements in the snapshotted surface order. */
  readonly pruned: readonly PrunedEntry[]
  /** Total Unicode code points removed across replacements. */
  readonly charsRemoved: number
}
