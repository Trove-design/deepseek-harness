import { describe, expect, it } from 'vitest'
import { hitRatio, runWorkload } from './support/prefix-cache.ts'
import type { CacheObservation, WorkloadRun } from './support/prefix-cache.ts'

/**
 * Cache-integrity contract for automatic compaction (discussions #1944, #3002).
 *
 * 1. The summary call is a warm replay: same request family as the routed
 *    conversation, and `[tools, system, region]` stays a byte prefix of the
 *    last routed request, so only the trailing instruction is new.
 * 2. Between compactions the conversation is append-only: every request is a
 *    strict byte extension of the previous one.
 * 3. Both hold independently of volume: the uncached part of a summary call
 *    is bounded by the instruction, not by the window.
 */

/** Upper bound for the novel part of a warm summary call: the instruction plus framing. */
const MAX_UNCACHED_SUMMARY_TOKENS = 2_000

function uncached(observation: CacheObservation): number {
  return observation.promptTokens - observation.cachedTokens
}

/**
 * No unexplained cache break: every conversation request extends its
 * predecessor byte for byte unless a durable surface replacement (checkpoint,
 * prune, or prompt consolidation) landed in between.
 */
function assertNoSilentRewrite(run: WorkloadRun): void {
  let rewritten = false
  let seenConversation = false
  for (const observation of run.cache.log) {
    if (observation.rewritesSincePrevious.length > 0) rewritten = true
    if (observation.purpose === 'compaction') continue
    if (seenConversation && !rewritten) {
      expect(observation.extendsPreviousConversation, `request #${observation.index} rewrote cached history silently`).toBe(true)
    }
    seenConversation = true
    rewritten = false
  }
}

describe('compaction keeps the provider prefix cache warm', () => {
  it('replays the routed reasoning effort in the summary call', async () => {
    const run = await runWorkload({ window: 64_000, steps: 40, effort: 'max' })
    const summaries = run.cache.compactions()

    expect(summaries.length).toBeGreaterThanOrEqual(2)
    for (const summary of summaries) {
      expect(summary.reasoningEffort).toBe('max')
      expect(hitRatio(summary)).toBeGreaterThanOrEqual(0.95)
      expect(uncached(summary)).toBeLessThanOrEqual(MAX_UNCACHED_SUMMARY_TOKENS)
    }
    const events = run.session.snapshotEvents().filter(event => event.type === 'compaction/summary')
    expect(events.map(event => event.data.reasoningEffort)).toEqual(summaries.map(() => 'max'))
  })

  it('does not rewrite the replayed region with the model-free prune pass', async () => {
    const run = await runWorkload({ window: 64_000, steps: 40, pruner: 'rewrite-only' })
    const events = run.session.snapshotEvents()

    expect(events.some(event => event.type === 'compaction/prune')).toBe(true)
    const summaries = run.cache.compactions()
    expect(summaries.length).toBeGreaterThanOrEqual(2)
    for (const summary of summaries) {
      expect(hitRatio(summary)).toBeGreaterThanOrEqual(0.95)
      expect(uncached(summary)).toBeLessThanOrEqual(MAX_UNCACHED_SUMMARY_TOKENS)
    }
  })

  it('never breaks the cache without a durable rewrite event', async () => {
    const run = await runWorkload({ window: 64_000, steps: 40, effort: 'max', pruner: 'rewrite-only' })

    assertNoSilentRewrite(run)
    // The first request after a checkpoint still reuses the static head (tools + system prompt).
    const conversations = run.cache.conversations()
    expect(conversations.every(observation => observation.index === 0 || observation.cachedTokens > 0)).toBe(true)
  })

  it('keeps a second agent in the same context on its own routed effort', async () => {
    const run = await runWorkload({
      window: 64_000,
      steps: 40,
      effort: 'low',
      pruner: 'rewrite-only',
      child: { steps: 40, effort: 'max' },
    })
    const efforts = (session: WorkloadRun['session']): unknown[] => session.snapshotEvents()
      .filter(event => event.type === 'compaction/summary')
      .map(event => event.data.reasoningEffort)

    // Each session's folds carry that session's routed effort, never the other agent's.
    expect(efforts(run.session).length).toBeGreaterThanOrEqual(2)
    expect(new Set(efforts(run.session))).toEqual(new Set(['low']))
    expect(run.child).toBeDefined()
    expect(efforts(run.child!).length).toBeGreaterThanOrEqual(2)
    expect(new Set(efforts(run.child!))).toEqual(new Set(['max']))
    // Both agents' summary calls stay warm, and neither rewrites cached history silently.
    for (const summary of run.cache.compactions()) {
      expect(hitRatio(summary)).toBeGreaterThanOrEqual(0.95)
      expect(uncached(summary)).toBeLessThanOrEqual(MAX_UNCACHED_SUMMARY_TOKENS)
    }
    expect(run.cache.compactions().map(summary => summary.reasoningEffort))
      .toEqual([...efforts(run.session), ...efforts(run.child!)])
  })

  it.each([32_000, 128_000, 512_000])('bounds the uncached summary prompt independently of a %i-token window', async (window) => {
    const run = await runWorkload({ window, steps: 60, effort: 'max', pruner: 'rewrite-only' })
    const summaries = run.cache.compactions()

    expect(summaries.length).toBeGreaterThanOrEqual(2)
    for (const summary of summaries) {
      expect(hitRatio(summary)).toBeGreaterThanOrEqual(0.95)
      expect(uncached(summary)).toBeLessThanOrEqual(MAX_UNCACHED_SUMMARY_TOKENS)
    }
    assertNoSilentRewrite(run)
  }, 60_000)
})
