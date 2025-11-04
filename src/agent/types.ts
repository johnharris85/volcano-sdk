// src/agent/types.ts
// Agent and step type definitions

import type { LLMHandle } from "../llms/types.js";
import type { MCPHandle } from "../mcp/types.js";

export type RetryConfig = {
  delay?: number;      // seconds to wait before each retry (mutually exclusive with backoff)
  backoff?: number;    // exponential factor, waits 1s, factor^n each retry
  retries?: number;    // total attempts including the first one; default 3
};

/**
 * Metadata provided to stream-level onToken callback.
 * Allows conditional processing based on whether step-level handler already processed the token.
 *
 * @property stepIndex - Index of the current step (0-based)
 * @property handledByStep - True if step-level onToken handled this token. Use this to avoid double-processing.
 * @property stepPrompt - The prompt for this step (useful for conditional formatting)
 * @property llmProvider - The LLM provider ID (e.g., "OpenAI-gpt-4o-mini", "Anthropic-claude-3")
 *
 * @example
 * .stream({
 *   onToken: (token, meta) => {
 *     if (!meta.handledByStep) {
 *       // Only process if step didn't handle it
 *       res.write(`data: ${token}\n\n`);
 *     }
 *     // Always log analytics
 *     analytics.track(token, meta.stepIndex);
 *   }
 * })
 */
export type TokenMetadata = {
  stepIndex: number;
  handledByStep: boolean;
  stepPrompt?: string;
  llmProvider?: string;
};

/**
 * Options for the stream() method.
 * Supports both token-level and step-level callbacks for maximum flexibility.
 *
 * @property onToken - Called for each token as it arrives (with metadata).
 *                     Step-level onToken takes precedence - when a step has its own onToken,
 *                     this callback won't receive tokens from that step (meta.handledByStep will be true).
 * @property onStep - Called when each step completes. Equivalent to the callback in stream(callback).
 *
 * @example
 * // Both token and step callbacks
 * .stream({
 *   onToken: (token, meta) => {
 *     console.log(`Token from step ${meta.stepIndex}: ${token}`);
 *   },
 *   onStep: (step, index) => {
 *     console.log(`Step ${index} complete: ${step.durationMs}ms`);
 *   }
 * })
 *
 * @example
 * // Backward compatible: just a callback
 * .stream((step, index) => {
 *   console.log(`Step ${index} done`);
 * })
 */
export type StreamOptions = {
  onToken?: (token: string, meta: TokenMetadata) => void;
  onStep?: (step: StepResult, stepIndex: number) => void;
};

export type Step =
  | { prompt: string; name?: string; llm?: LLMHandle; instructions?: string; timeout?: number; retry?: RetryConfig; contextMaxChars?: number; contextMaxToolResults?: number; pre?: () => void; post?: () => void; onToken?: (token: string) => void }
  | { mcp: MCPHandle; name?: string; tool: string; args?: Record<string, any>; timeout?: number; retry?: RetryConfig; contextMaxChars?: number; contextMaxToolResults?: number; pre?: () => void; post?: () => void }
  | { prompt: string; name?: string; llm?: LLMHandle; mcp: MCPHandle; tool: string; args?: Record<string, any>; instructions?: string; timeout?: number; retry?: RetryConfig; contextMaxChars?: number; contextMaxToolResults?: number; pre?: () => void; post?: () => void }
  | { prompt: string; name?: string; llm?: LLMHandle; mcps: MCPHandle[]; instructions?: string; timeout?: number; retry?: RetryConfig; contextMaxChars?: number; contextMaxToolResults?: number; maxToolIterations?: number; pre?: () => void; post?: () => void; onToken?: (token: string) => void }
  | { prompt: string; name?: string; llm?: LLMHandle; agents: AgentBuilder[]; instructions?: string; timeout?: number; retry?: RetryConfig; contextMaxChars?: number; contextMaxToolResults?: number; maxAgentIterations?: number; pre?: () => void; post?: () => void };

export type StepResult = {
  prompt?: string;
  llmOutput?: string;
  // Total wall time for this step (successful attempt) in milliseconds
  durationMs?: number;
  // Total LLM time spent during this step (sum across iterations) in milliseconds
  llmMs?: number;
  mcp?: { endpoint: string; tool: string; result: any; ms?: number };
  toolCalls?: Array<{ name: string; arguments?: Record<string, any>; endpoint: string; result: any } & { ms?: number }>;
  // Parallel execution results (for parallel steps)
  parallel?: Record<string, StepResult>;
  parallelResults?: StepResult[];
  // Aggregated metrics (populated on the final step of a run)
  totalDurationMs?: number;
  totalLlmMs?: number;
  totalMcpMs?: number;
};

export type StepFactory = (history: StepResult[]) => Step;

// Agent builder interface for type safety
export interface AgentBuilder {
  name?: string;
  description?: string;
  resetHistory(): AgentBuilder;
  then(s: Step | StepFactory): AgentBuilder;
  parallel(stepsOrDict: Step[] | Record<string, Step>, hooks?: { pre?: () => void; post?: () => void }): AgentBuilder;
  branch(condition: (history: StepResult[]) => boolean, branches: { true: (agent: AgentBuilder) => AgentBuilder; false: (agent: AgentBuilder) => AgentBuilder }, hooks?: { pre?: () => void; post?: () => void }): AgentBuilder;
  switch<T = string>(selector: (history: StepResult[]) => T, cases: Record<string, (agent: AgentBuilder) => AgentBuilder> & { default?: (agent: AgentBuilder) => AgentBuilder }, hooks?: { pre?: () => void; post?: () => void }): AgentBuilder;
  while(condition: (history: StepResult[]) => boolean, body: (agent: AgentBuilder) => AgentBuilder, opts?: { maxIterations?: number; timeout?: number; pre?: () => void; post?: () => void }): AgentBuilder;
  forEach<T>(items: T[], body: (item: T, agent: AgentBuilder) => AgentBuilder, hooks?: { pre?: () => void; post?: () => void }): AgentBuilder;
  retryUntil(body: (agent: AgentBuilder) => AgentBuilder, successCondition: (result: StepResult) => boolean, opts?: { maxAttempts?: number; backoff?: number; pre?: () => void; post?: () => void }): AgentBuilder;
  runAgent(subAgent: AgentBuilder, hooks?: { pre?: () => void; post?: () => void }): AgentBuilder;
  run(log?: (s: StepResult, stepIndex: number) => void): Promise<StepResult[]>;
  stream(optionsOrLog?: StreamOptions | ((s: StepResult, stepIndex: number) => void)): AsyncGenerator<StepResult, void, unknown>;
}
