/**
 * Deterministic provider-side prefix-cache simulator and a scripted coding
 * workload for cache-integrity regression specs.
 *
 * The simulator keys a request family on the prompt-shaping envelope
 * (provider, model, reasoning effort, temperature, stop) and reuses the
 * longest byte prefix of any earlier request in the same family. That matches
 * the failure observed in discussion #1944, where a server template renders
 * the reasoning effort ahead of the conversation. `maxTokens` is an output cap
 * and deliberately not part of the key: the #1944 corpus shows folds with a
 * matching effort but a different cap still reusing 99.9% of the prefix.
 *
 * Token counts use the token meter's fixed density (4 chars per token) over
 * the provider-visible serialization: role, content, and tool-call
 * correlation, never local message ids or sources.
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type { ToolResultPruneConfig } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { isReplacementSurfaceEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'

/** One request as the simulated provider cache saw it. */
export interface CacheObservation {
  readonly index: number
  readonly purpose: 'conversation' | 'compaction'
  readonly reasoningEffort: string | undefined
  readonly maxTokens: number | undefined
  readonly promptTokens: number
  readonly cachedTokens: number
  /** Whether this request is a strict byte extension of the previous conversation request. */
  readonly extendsPreviousConversation: boolean
  /** Durable surface replacements (event types) landed since the previous request. */
  readonly rewritesSincePrevious: readonly string[]
}

const CHARS_PER_TOKEN = 4

function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

function wireUnit(message: RequestMessage): string {
  return JSON.stringify([
    message.role,
    message.content,
    'toolCallId' in message ? message.toolCallId : null,
  ])
}

interface CacheEntry {
  readonly key: string
  readonly ids: readonly number[]
  readonly units: readonly string[]
  readonly chars: number
}

/** Longest common byte prefix of two unit sequences, interned by id. */
function commonPrefixChars(a: CacheEntry, ids: readonly number[], units: readonly string[]): number {
  let chars = 0
  const n = Math.min(a.ids.length, ids.length)
  for (let index = 0; index < n; index += 1) {
    const left = a.units[index]!
    if (a.ids[index] === ids[index]) {
      chars += left.length
      continue
    }
    const right = units[index]!
    const limit = Math.min(left.length, right.length)
    let shared = 0
    while (shared < limit && left.charCodeAt(shared) === right.charCodeAt(shared)) shared += 1
    return chars + shared
  }
  return chars
}

/** Simulated provider prefix cache; every observed request becomes reusable. */
export class PrefixCache {
  readonly log: CacheObservation[] = []
  private readonly entries: CacheEntry[] = []
  private readonly interned = new Map<string, number>()
  private lastConversation: CacheEntry | undefined
  private pendingRewrites: string[] = []

  /** Record a durable surface replacement; the next observation carries it. */
  noteRewrite(kind: string): void {
    this.pendingRewrites.push(kind)
  }

  private intern(unit: string): number {
    let id = this.interned.get(unit)
    if (id === undefined) {
      id = this.interned.size
      this.interned.set(unit, id)
    }
    return id
  }

  observe(options: GenerateOptions): CacheObservation {
    const key = JSON.stringify([
      options.provider,
      options.model,
      options.reasoningEffort ?? null,
      options.temperature ?? null,
      options.stop ?? null,
    ])
    const units = [JSON.stringify(options.tools ?? []), ...options.messages.map(wireUnit)]
    const ids = units.map(unit => this.intern(unit))
    const chars = units.reduce((total, unit) => total + unit.length, 0)
    let cached = 0
    for (const entry of this.entries) {
      if (entry.key === key) cached = Math.max(cached, commonPrefixChars(entry, ids, units))
    }
    const entry: CacheEntry = { key, ids, units, chars }
    const purpose = options.purpose === 'compaction' ? 'compaction' : 'conversation'
    const previous = this.lastConversation
    const extendsPreviousConversation = previous !== undefined
      && previous.key === key
      && commonPrefixChars(previous, ids, units) === previous.chars
    this.entries.push(entry)
    if (purpose === 'conversation') this.lastConversation = entry
    const observation: CacheObservation = {
      index: this.log.length,
      purpose,
      reasoningEffort: options.reasoningEffort,
      maxTokens: options.maxTokens,
      promptTokens: tokensOf(chars),
      cachedTokens: tokensOf(cached),
      extendsPreviousConversation,
      rewritesSincePrevious: this.pendingRewrites,
    }
    this.pendingRewrites = []
    this.log.push(observation)
    return observation
  }

  compactions(): CacheObservation[] {
    return this.log.filter(entry => entry.purpose === 'compaction')
  }

  conversations(): CacheObservation[] {
    return this.log.filter(entry => entry.purpose === 'conversation')
  }
}

/** Deterministic filler with no long repeated runs, so prefixes stay honest. */
function prose(label: string, chars: number): string {
  let text = `${label}: `
  let state = label.length * 2654435761 >>> 0
  while (text.length < chars) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    text += `w${(state % 9973).toString(36)} `
  }
  return text.slice(0, chars)
}

/** Shape of one scripted coding session scaled to a model context window. */
export interface Workload {
  /** Context window the adapter declares for the routed model. */
  readonly window: number
  /** Tool steps the scripted model runs before its final answer. */
  readonly steps: number
  /** Conversation effort; the adapter default is `high`. */
  readonly effort?: 'low' | 'high' | 'max'
  /**
   * Mount the model-free pruner. `rewrite-only` derives budgets from the
   * window so every third result is rewritten but the pass alone never clears
   * pressure, which isolates the effect of the rewrite on the summary call.
   */
  readonly pruner?: 'rewrite-only' | ToolResultPruneConfig
  /** Deterministic summarizer output. */
  readonly summary?: (call: number) => string
  /** Opening user message. */
  readonly prompt?: string
  /** Extra compaction configuration. */
  readonly compaction?: BasicCompactionConfig
  /**
   * A second agent with its own session in the same context, started after
   * the first turn completes. It stands in for a delegated child: it keeps the
   * parent's route and may name its own effort, the way
   * `resolveChildAgentOptions` in dsh-subagent resolves child options.
   */
  readonly child?: { readonly steps: number; readonly effort?: 'low' | 'high' | 'max' }
}

/** Scripted model: tool calls with prose, then a final answer; summaries on `purpose: compaction`. */
class ScriptedCodingModel extends LlmAdapter {
  /** Calls per session, so two agents in one context run independent scripts. */
  private readonly conversationCalls = new Map<string, number>()
  private readonly summaryCalls = new Map<string, number>()
  private readonly stepLimits = new Map<string, number>()

  /** Give one session its own step count; other sessions use the workload's. */
  limitSteps(sessionId: string, steps: number): void {
    this.stepLimits.set(sessionId, steps)
  }

  constructor(
    private readonly cache: PrefixCache,
    private readonly workload: Workload,
    private readonly stepChars: number,
  ) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const effort = (id: string) => ({ id: ReasoningEffortId(id), name: id })
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.workload.window },
      defaultMaxTokens: Math.floor(this.workload.window / 16),
      reasoning: { efforts: [effort('low'), effort('high'), effort('max')], defaultEffort: ReasoningEffortId('high') },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.cache.observe(options)
    const sessionId = String(options.sessionId)
    if (options.purpose === 'compaction') {
      const call = this.summaryCalls.get(sessionId) ?? 0
      this.summaryCalls.set(sessionId, call + 1)
      const text = this.workload.summary?.(call)
        ?? `## Primary Request and Intent\n- checkpoint ${call}\n## Current Work\n- ${prose(`summary-${call}`, 400)}`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const n = this.conversationCalls.get(sessionId) ?? 0
    this.conversationCalls.set(sessionId, n + 1)
    if (n < (this.stepLimits.get(sessionId) ?? this.workload.steps)) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: prose(`reasoning-${n}`, this.stepChars) } }
      yield { type: 'block-start', index: 1, blockType: 'tool-call' }
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id: ToolCallId(`call-${n}`), name: 'read_file', arguments: `{"i":${n}}` },
      }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Result of one scripted session run. */
export interface WorkloadRun {
  readonly cache: PrefixCache
  readonly session: Session
  /** Session of the second agent, when the workload declares one. */
  readonly child?: Session
}

/**
 * Run one scripted session through the real agent loop, token meter,
 * compaction-basic, and (optionally) the tool-result pruner.
 * @param workload - window, step count, effort, and pruner budgets.
 * @returns the cache log and the finished session.
 */
export async function runWorkload(workload: Workload): Promise<WorkloadRun> {
  const ctx = new Context()
  const cache = new PrefixCache()
  // About 24 steps fill a window: prose plus a tool result per step.
  const stepTokens = Math.floor(workload.window / 24)
  const stepChars = Math.floor(stepTokens * CHARS_PER_TOKEN * 0.45)
  const rewriteThreshold = Math.ceil(stepChars * 1.5)
  const pruner: ToolResultPruneConfig | undefined = workload.pruner === 'rewrite-only'
    ? { thresholdChars: rewriteThreshold, headChars: rewriteThreshold - 1_000, tailChars: 900 }
    : workload.pruner
  // Every third result overflows the prune budget by a few hundred chars.
  const bigResultChars = workload.pruner === 'rewrite-only' ? rewriteThreshold + 300 : stepChars * 2
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  if (pruner !== undefined) await ctx.plugin(ToolResultPruner, pruner)
  const model = new ScriptedCodingModel(cache, workload, stepChars)
  ctx.llm.registerAdapter(['mock'], model)
  ctx.on('session/event', (_session, event) => {
    if (isReplacementSurfaceEvent(event)) cache.noteRewrite(event.type)
  })
  ctx.tools.register(defineContentToolFixture({
    name: 'read_file',
    description: 'Read one file of the workspace.',
    parameters: { i: { type: 'number' } },
    execute({ i }) {
      const index = i ?? 0
      const size = index % 3 === 1 ? bigResultChars : stepChars
      return Promise.resolve([{ type: 'text', text: prose(`file-${index}`, size) }])
    },
  }))
  await ctx.plugin(BasicCompactionEngine, {
    thresholdRatio: 0.8,
    headroomTokens: Math.floor(workload.window / 16),
    retainRatio: 0.16,
    compactionRetries: 1,
    ...workload.compaction,
  })
  try {
    const agent = await ctx.agentLoop.create(SessionId(`cache-${workload.window}-${workload.effort ?? 'default'}`), {
      provider: 'mock',
      model: 'mock',
      ...workload.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(workload.effort) },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: workload.prompt ?? 'Refactor the workspace.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const last = agent.session.snapshotEvents().at(-1)
    if (last?.type !== 'turn/end' || last.data.reason.kind !== 'completed') {
      throw new Error(`scripted turn did not complete: ${JSON.stringify(last)}`)
    }
    if (workload.child === undefined) return { cache, session: agent.session }
    const childId = SessionId(`${agent.session.id}-child`)
    model.limitSteps(String(childId), workload.child.steps)
    const child = await ctx.agentLoop.create(childId, {
      provider: 'mock',
      model: 'mock',
      ...workload.child.effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(workload.child.effort) },
    })
    child.followup(createUserMessage({ content: [{ type: 'text', text: 'Delegated: audit the tests.' }], source: { kind: 'user' } }))
    await child.whenIdle()
    const childLast = child.session.snapshotEvents().at(-1)
    if (childLast?.type !== 'turn/end' || childLast.data.reason.kind !== 'completed') {
      throw new Error(`scripted child turn did not complete: ${JSON.stringify(childLast)}`)
    }
    return { cache, session: agent.session, child: child.session }
  } finally {
    await ctx.fiber.dispose()
  }
}

/** Fraction of a request's prompt served from the simulated cache. */
export function hitRatio(observation: CacheObservation): number {
  return observation.promptTokens === 0 ? 1 : observation.cachedTokens / observation.promptTokens
}
