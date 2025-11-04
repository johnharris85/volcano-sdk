// src/volcano-sdk.ts
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { llmOpenAI as llmOpenAIProvider, llmOpenAIResponses as llmOpenAIResponsesProvider } from "./llms/openai.js";
import { executeParallel, executeBranch, executeSwitch, executeWhile, executeForEach, executeRetryUntil, executeRunAgent } from "./patterns.js";
import {
  VolcanoError,
  VolcanoErrorMeta,
  AgentConcurrencyError,
  TimeoutError,
  ValidationError,
  RetryExhaustedError,
  LLMError,
  MCPError,
  MCPConnectionError,
  MCPToolError,
  normalizeError,
  isRetryableStatus,
  classifyProviderFromLlm,
  classifyProviderFromMcp,
} from "./errors.js";
export { llmAnthropic } from "./llms/anthropic.js";
export { llmLlama } from "./llms/llama.js";
export { llmMistral } from "./llms/mistral.js";
export { llmBedrock } from "./llms/bedrock.js";
export { llmVertexStudio } from "./llms/vertex-studio.js";
export { llmAzure } from "./llms/azure.js";
export { createVolcanoTelemetry, noopTelemetry } from "./telemetry.js";
export type { VolcanoTelemetryConfig, VolcanoTelemetry } from "./telemetry.js";
export type { OpenAIConfig, OpenAIOptions } from "./llms/openai.js";
export type { AnthropicConfig, AnthropicOptions } from "./llms/anthropic.js";
export type { LlamaConfig, LlamaOptions } from "./llms/llama.js";
export type { MistralConfig, MistralOptions } from "./llms/mistral.js";
export type { BedrockConfig, BedrockOptions } from "./llms/bedrock.js";
export type { VertexStudioConfig, VertexStudioOptions } from "./llms/vertex-studio.js";
export type { AzureConfig, AzureOptions } from "./llms/azure.js";
import type { LLMHandle, ToolDefinition, LLMToolResult } from "./llms/types.js";
import type { MCPAuthConfig, MCPHandle } from "./mcp/types.js";
import { validateToolArgs, __internal_validateToolArgs } from "./validation.js";
import { sleep, withTimeout } from "./agent/utils.js";
import {
  getOAuthToken,
  executeWithAuth,
  __internal_clearOAuthTokenCache,
  __internal_getOAuthTokenCache
} from "./mcp/auth.js";
import {
  withMCP,
  __internal_getMcpPoolStats,
  __internal_forcePoolCleanup,
  __internal_setPoolConfig
} from "./mcp/client.js";
import {
  discoverTools,
  getToolSchema,
  __internal_clearDiscoveryCache,
  __internal_setDiscoveryTtl,
  __internal_primeDiscoveryCache
} from "./mcp/discovery.js";
import { mcp } from "./mcp/factory.js";
import type {
  RetryConfig,
  TokenMetadata,
  StreamOptions,
  Step,
  StepResult,
  StepFactory,
  AgentBuilder
} from "./agent/types.js";
import { buildHistoryContextChunked } from "./agent/context.js";
import { createProgressHandler } from "./agent/progress.js";
import { buildAgentContext, parseAgentDecision } from "./agent/crews.js";

/* ---------- LLM ---------- */
export type { LLMHandle, ToolDefinition, LLMToolResult };
export const llmOpenAI = llmOpenAIProvider;
export const llmOpenAIResponses = llmOpenAIResponsesProvider;

/* ---------- Errors ---------- */
export type { VolcanoErrorMeta };
export {
  VolcanoError,
  AgentConcurrencyError,
  TimeoutError,
  ValidationError,
  RetryExhaustedError,
  LLMError,
  MCPError,
  MCPConnectionError,
  MCPToolError,
};

/* ---------- MCP (Streamable HTTP) ---------- */
export type { MCPAuthConfig, MCPHandle };
// Re-export mcp() factory function
export { mcp } from "./mcp/factory.js";

// Re-export validation for backwards compatibility
export { __internal_validateToolArgs };

// MCP pool helpers re-exported from client module
export { __internal_getMcpPoolStats, __internal_forcePoolCleanup, __internal_setPoolConfig } from "./mcp/client.js";
// OAuth cache helpers re-exported from auth module
export { __internal_clearOAuthTokenCache, __internal_getOAuthTokenCache } from "./mcp/auth.js";

// Connection pooling (getPooledClient, connectWithAuth, cleanupIdlePool, ensurePoolSweeper, withMCP) moved to mcp/client.ts
// executeWithAuth, getOAuthToken moved to mcp/auth.ts
// Tool discovery (discoverTools, getToolSchema) moved to mcp/discovery.ts
// sleep and withTimeout moved to agent/utils.ts

// Re-export discoverTools for public API
export { discoverTools } from "./mcp/discovery.js";
// Re-export discovery test helpers
export { __internal_clearDiscoveryCache, __internal_setDiscoveryTtl, __internal_primeDiscoveryCache } from "./mcp/discovery.js";

/* ---------- Agent chain ---------- */
// Re-export agent types
export type {
  RetryConfig,
  TokenMetadata,
  StreamOptions,
  Step,
  StepResult,
  AgentBuilder
} from "./agent/types.js";

// Context building moved to agent/context.ts

/**
 * Helper function to execute LLM generation with optional token streaming.
 * Handles both step-level and stream-level onToken callbacks with proper precedence.
 */
async function executeLLMWithStreaming(
  llm: LLMHandle,
  prompt: string,
  stepOnToken: ((token: string) => void) | undefined,
  streamOnToken: ((token: string, meta: TokenMetadata) => void) | undefined,
  meta: { stepIndex: number; stepPrompt?: string }
): Promise<string> {
  const hasStepOnToken = !!stepOnToken;
  const effectiveOnToken = stepOnToken || streamOnToken;
  
  if (effectiveOnToken && typeof llm.genStream === 'function') {
    const tokens: string[] = [];
    const tokenMeta: TokenMetadata = {
      stepIndex: meta.stepIndex,
      handledByStep: hasStepOnToken,
      stepPrompt: meta.stepPrompt,
      llmProvider: (llm as any).id || llm.model
    };
    
    for await (const token of llm.genStream(prompt)) {
      tokens.push(token);
      try {
        if (hasStepOnToken) {
          stepOnToken!(token);
        } else {
          streamOnToken!(token, tokenMeta);
        }
      } catch (e) {
        console.warn('onToken callback failed:', e);
      }
    }
    return tokens.join('');
  } else {
    return await llm.gen(prompt);
  }
}



// Progress rendering (createProgressDisplay, createProgressHandler) moved to agent/progress.ts

// Multi-agent crews (buildAgentContext, parseAgentDecision) moved to agent/crews.ts

type AgentOptions = {
  llm?: LLMHandle;
  instructions?: string;
  name?: string;                       // Agent name for multi-agent coordination
  description?: string;                // Agent description for automatic selection
  hideProgress?: boolean;              // Disable beautiful TTY progress output (progress shown by default)
  timeout?: number;
  retry?: RetryConfig;
  // Context compaction options
  contextMaxChars?: number;            // soft cap for injected context size (default 4000)
  contextMaxToolResults?: number;      // number of recent tool results to include (default 3)
  // MCP authentication configuration per endpoint
  mcpAuth?: Record<string, MCPAuthConfig>;
  // OpenTelemetry observability (opt-in)
  telemetry?: import('./telemetry.js').VolcanoTelemetry;
  // Maximum tool calling iterations for automatic selection (default 4)
  maxToolIterations?: number;
};

/**
 * Create an AI agent that chains LLM reasoning with MCP tool calls.
 * 
 * @param opts - Optional configuration including LLM provider, instructions, timeout, retry policy, and observability
 * @returns AgentBuilder for chaining steps with .then(), run(), and stream()
 * 
 * @example
 * // Simple agent
 * const results = await agent({ llm: llmOpenAI({...}) })
 *   .then({ prompt: "Analyze data" })
 *   .then({ prompt: "Generate insights" })
 *   .run();
 * 
 * @example
 * // With automatic tool selection
 * await agent({ llm })
 *   .then({ 
 *     prompt: "Book a meeting and send confirmation", 
 *     mcps: [calendar, email] 
 *   })
 *   .run();
 */
export function agent(opts?: AgentOptions): AgentBuilder {
  const steps: Array<Step | StepFactory | { __reset: true }> = [];
  const defaultLlm = opts?.llm;
  let contextHistory: StepResult[] = [];
  let inheritedParentContext = false; // Track if we've inherited parent context
  const globalInstructions = opts?.instructions;
  const agentName = opts?.name;
  const agentDescription = opts?.description;
  const showProgress = !opts?.hideProgress; // Progress enabled by default
  const defaultTimeoutMs = ((typeof opts?.timeout === 'number' ? opts!.timeout! : 60)) * 1000; // seconds -> ms
  const defaultRetry: RetryConfig = opts?.retry ?? { delay: 0, retries: 3 };
  const contextMaxChars = typeof opts?.contextMaxChars === 'number' ? opts!.contextMaxChars! : 20480;
  const contextMaxToolResults = typeof opts?.contextMaxToolResults === 'number' ? opts!.contextMaxToolResults! : 8;
  const agentMcpAuth = opts?.mcpAuth || {};
  const telemetry = opts?.telemetry;
  const defaultMaxToolIterations = typeof opts?.maxToolIterations === 'number' ? opts!.maxToolIterations! : 4;
  let isRunning = false;
  
  // Helper to apply agent-level auth to MCP handle
  function applyAgentAuth(handle: MCPHandle): MCPHandle {
    if (handle.auth) return handle; // Handle-level auth takes precedence
    const authConfig = agentMcpAuth[handle.url];
    if (authConfig) {
      return { ...handle, auth: authConfig };
    }
    return handle;
  }
  
  const builder: AgentBuilder = {
    name: agentName,
    description: agentDescription,
    resetHistory() { steps.push({ __reset: true }); return builder; },
    then(s: Step | StepFactory) { steps.push(s); return builder; },
    
    // Parallel execution
    parallel(stepsOrDict: Step[] | Record<string, Step>, hooks?: { pre?: () => void; post?: () => void }) {
      steps.push({ __parallel: stepsOrDict, __hooks: hooks } as any);
      return builder;
    },
    
    // Conditional branching
    branch(condition: (history: StepResult[]) => boolean, branches: { true: (agent: AgentBuilder) => AgentBuilder; false: (agent: AgentBuilder) => AgentBuilder }, hooks?: { pre?: () => void; post?: () => void }) {
      steps.push({ __branch: { condition, branches }, __hooks: hooks } as any);
      return builder;
    },
    
    switch<T = string>(selector: (history: StepResult[]) => T, cases: Record<string, (agent: AgentBuilder) => AgentBuilder> & { default?: (agent: AgentBuilder) => AgentBuilder }, hooks?: { pre?: () => void; post?: () => void }) {
      steps.push({ __switch: { selector, cases }, __hooks: hooks } as any);
      return builder;
    },
    
    // Loops
    while(condition: (history: StepResult[]) => boolean, body: (agent: AgentBuilder) => AgentBuilder, opts?: { maxIterations?: number; timeout?: number; pre?: () => void; post?: () => void }) {
      steps.push({ __while: { condition, body, opts } } as any);
      return builder;
    },
    
    forEach<T>(items: T[], body: (item: T, agent: AgentBuilder) => AgentBuilder, hooks?: { pre?: () => void; post?: () => void }) {
      steps.push({ __forEach: { items, body }, __hooks: hooks } as any);
      return builder;
    },
    
    retryUntil(body: (agent: AgentBuilder) => AgentBuilder, successCondition: (result: StepResult) => boolean, opts?: { maxAttempts?: number; backoff?: number; pre?: () => void; post?: () => void }) {
      steps.push({ __retryUntil: { body, successCondition, opts } } as any);
      return builder;
    },
    
    // Sub-agent composition
    runAgent(subAgent: AgentBuilder, hooks?: { pre?: () => void; post?: () => void }) {
      steps.push({ __runAgent: { subAgent }, __hooks: hooks } as any);
      return builder;
    },
    
    async run(log?: (s: StepResult, stepIndex: number) => void): Promise<StepResult[]> {
      if (isRunning) {
        throw new AgentConcurrencyError('This agent is already running. Create a new agent() instance for concurrent runs.');
      }
      isRunning = true;
      
      const isSubAgent = (builder as any).__isSubAgent || false;
      const isExplicitSubAgent = (builder as any).__isExplicitSubAgent || false;
      const parentStepIndex = (builder as any).__parentStepIndex;
      const parentTotalSteps = (builder as any).__parentTotalSteps;
      const parentAgentName = (builder as any).__parentAgentName;
      const progress = showProgress ? createProgressHandler(steps.length, isSubAgent, isExplicitSubAgent, parentStepIndex, parentTotalSteps) : null;
      
      // Record agent execution (always, even for anonymous agents)
      if (telemetry) {
        telemetry.recordMetric('agent.execution', 1, {
          agent_name: agentName || 'anonymous',
          parent_agent: parentAgentName || 'none',
          is_subagent: isSubAgent.toString()
        });
      }
      
      // Start agent span
      const agentSpan = telemetry?.startAgentSpan(steps.length, agentName) || null;
      const out: StepResult[] = [];
      
      // Inherit parent context if this is a subagent
      if (!inheritedParentContext && (builder as any).__parentContext) {
        contextHistory = [...(builder as any).__parentContext];
        inheritedParentContext = true;
      }
      
      try {
        // snapshot steps array to make run isolated from later .then() calls
        const planned = [...steps];
        for (const raw of planned) {
          if ((raw as any).__reset) { contextHistory = []; continue; }
          
          // Handle advanced pattern steps
          if ((raw as any).__parallel) {
            const hooks = (raw as any).__hooks;
            try {
              hooks?.pre?.();
            } catch (e) {
              console.warn('Pre-hook failed for parallel:', e);
            }
            
            const parallelResult = await executeParallel(
              (raw as any).__parallel,
              async (step: any) => {
                const subAgent = agent(opts).then(step);
                const results = await subAgent.run();
                return results[0];
              }
            );
            out.push(parallelResult);
            contextHistory.push(parallelResult);
            log?.(parallelResult, out.length - 1);
            
            try {
              hooks?.post?.();
            } catch (e) {
              console.warn('Post-hook failed for parallel:', e);
            }
            continue;
          }
          
          if ((raw as any).__branch) {
            const { condition, branches } = (raw as any).__branch;
            const hooks = (raw as any).__hooks;
            
            try {
              hooks?.pre?.();
            } catch (e) {
              console.warn('Pre-hook failed for branch:', e);
            }
            
            const branchResults = await executeBranch(condition, branches, out, () => agent(opts));
            out.push(...branchResults);
            contextHistory.push(...branchResults);
            branchResults.forEach((r, i) => log?.(r, out.length - branchResults.length + i));
            
            try {
              hooks?.post?.();
            } catch (e) {
              console.warn('Post-hook failed for branch:', e);
            }
            continue;
          }
          
          if ((raw as any).__switch) {
            const { selector, cases } = (raw as any).__switch;
            const hooks = (raw as any).__hooks;
            
            try {
              hooks?.pre?.();
            } catch (e) {
              console.warn('Pre-hook failed for switch:', e);
            }
            
            const switchResults = await executeSwitch(selector, cases, out, () => agent(opts));
            out.push(...switchResults);
            contextHistory.push(...switchResults);
            switchResults.forEach((r, i) => log?.(r, out.length - switchResults.length + i));
            
            try {
              hooks?.post?.();
            } catch (e) {
              console.warn('Post-hook failed for switch:', e);
            }
            continue;
          }
          
          if ((raw as any).__while) {
            const { condition, body, opts: whileOpts } = (raw as any).__while;
            
            try {
              whileOpts?.pre?.();
            } catch (e) {
              console.warn('Pre-hook failed for while:', e);
            }
            
            const whileResults = await executeWhile(condition, body, out, () => agent(opts), whileOpts);
            out.push(...whileResults);
            contextHistory.push(...whileResults);
            whileResults.forEach((r, i) => log?.(r, out.length - whileResults.length + i));
            
            try {
              whileOpts?.post?.();
            } catch (e) {
              console.warn('Post-hook failed for while:', e);
            }
            continue;
          }
          
          if ((raw as any).__forEach) {
            const { items, body } = (raw as any).__forEach;
            const hooks = (raw as any).__hooks;
            
            try {
              hooks?.pre?.();
            } catch (e) {
              console.warn('Pre-hook failed for forEach:', e);
            }
            
            const forEachResults = await executeForEach(items, body, () => agent(opts));
            out.push(...forEachResults);
            contextHistory.push(...forEachResults);
            forEachResults.forEach((r, i) => log?.(r, out.length - forEachResults.length + i));
            
            try {
              hooks?.post?.();
            } catch (e) {
              console.warn('Post-hook failed for forEach:', e);
            }
            continue;
          }
          
          if ((raw as any).__retryUntil) {
            const { body, successCondition, opts: retryOpts } = (raw as any).__retryUntil;
            
            try {
              retryOpts?.pre?.();
            } catch (e) {
              console.warn('Pre-hook failed for retryUntil:', e);
            }
            
            const retryResults = await executeRetryUntil(body, successCondition, () => agent(opts), retryOpts);
            out.push(...retryResults);
            contextHistory.push(...retryResults);
            retryResults.forEach((r, i) => log?.(r, out.length - retryResults.length + i));
            
            try {
              retryOpts?.post?.();
            } catch (e) {
              console.warn('Post-hook failed for retryUntil:', e);
            }
            continue;
          }
          
          if ((raw as any).__runAgent) {
            const { subAgent } = (raw as any).__runAgent;
            const hooks = (raw as any).__hooks;
            
            try {
              hooks?.pre?.();
            } catch (e) {
              console.warn('Pre-hook failed for runAgent:', e);
            }
            
            // Pass parent's context to subagent
            const subResults = await executeRunAgent(subAgent, out.length, planned.length, contextHistory);
            out.push(...subResults);
            contextHistory.push(...subResults);
            subResults.forEach((r, i) => log?.(r, out.length - subResults.length + i));
            
            try {
              hooks?.post?.();
            } catch (e) {
              console.warn('Post-hook failed for runAgent:', e);
            }
            continue;
          }
          
          const s = typeof raw === 'function' ? (raw as StepFactory)(out) : (raw as Step);
          const stepTimeoutMs = (s as any).timeout != null ? (s as any).timeout * 1000 : defaultTimeoutMs; // seconds -> ms
          const retryCfg: RetryConfig = (s as any).retry ?? defaultRetry;
          const attemptsTotal = typeof retryCfg.retries === 'number' && retryCfg.retries! > 0 ? retryCfg.retries! : (defaultRetry.retries ?? 3);
          const useDelay = typeof retryCfg.delay === 'number' ? retryCfg.delay! : (defaultRetry.delay ?? 0);
          const useBackoff = retryCfg.backoff;
          if (useDelay && useBackoff) throw new Error('retry: specify either delay or backoff, not both');
  
          const doStep = async (): Promise<StepResult> => {
            // Execute pre-step hook
            if ((s as any).pre) {
              try {
                (s as any).pre();
              } catch (e) {
                console.warn('Pre-step hook failed:', e);
              }
            }
            
            // Determine step type for telemetry
            let stepType = 'unknown';
            if ("agents" in s) stepType = 'agent_crew';
            else if ("mcps" in s) stepType = 'mcp_auto';
            else if ("mcp" in s) stepType = 'mcp_explicit';
            else if ("prompt" in s) stepType = 'llm';
            
            // Start step span
            const stepPrompt = (s as any).prompt;
            const stepName = (s as any).name;
            const stepLlm = (s as any).llm || defaultLlm;
            const stepSpan = telemetry?.startStepSpan(agentSpan, out.length, stepType, stepPrompt, stepName, stepLlm) || null;
            
            const r: StepResult = {};
            const stepStart = Date.now();
            if (progress) progress.stepStart(out.length, (s as any).prompt);
            let llmTotalMs = 0;
            
            // Automatic tool selection with iterative tool calls
            if ("mcps" in s && "prompt" in s) {
              const usedLlm = (s as any).llm ?? defaultLlm;
              if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
              const stepInstructions = (s as any).instructions ?? globalInstructions;
              const cmr = (s as any).contextMaxToolResults ?? contextMaxToolResults;
              const cmc = (s as any).contextMaxChars ?? contextMaxChars;
              const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr, cmc);
              r.prompt = (s as any).prompt;
              // Apply agent-level auth to all MCP handles
              const mcpsWithAuth = ((s as any).mcps as MCPHandle[]).map(applyAgentAuth);
              const availableTools = await discoverTools(mcpsWithAuth);
              if (availableTools.length === 0) {
                r.llmOutput = "No tools available for this request.";
              } else {
                const aggregated: Array<{ name: string; endpoint: string; result: any; ms?: number }> = [];
                const maxIterations = (s as any).maxToolIterations ?? defaultMaxToolIterations;
                let workingPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory;
                for (let i = 0; i < maxIterations; i++) {
                  const llmStart = Date.now();
                  let toolPlan: LLMToolResult;
                  try {
                    toolPlan = await usedLlm.genWithTools(workingPrompt, availableTools);
                  } catch (e) {
                    const provider = classifyProviderFromLlm(usedLlm);
                    throw normalizeError(e, 'llm', { stepId: out.length, provider });
                  }
                  const llmCallDuration = Date.now() - llmStart;
                  llmTotalMs += llmCallDuration;
                  
                  // Record LLM metrics for this iteration
                  telemetry?.recordMetric('llm.call', 1, { provider: (usedLlm as any).id || usedLlm.model, error: false });
                  telemetry?.recordMetric('llm.duration', llmCallDuration, { provider: (usedLlm as any).id || usedLlm.model, model: usedLlm.model });
                  
                  // Record token usage for this LLM call
                  const usage = (usedLlm as any).getUsage?.();
                  if (usage && telemetry) {
                    const tokenAttrs = { 
                      provider: (usedLlm as any).id,
                      model: usedLlm.model,
                      agent_name: agentName || 'anonymous'
                    };
                    if (usage.inputTokens) {
                      telemetry.recordMetric('llm.tokens.input', usage.inputTokens, tokenAttrs);
                    }
                    if (usage.outputTokens) {
                      telemetry.recordMetric('llm.tokens.output', usage.outputTokens, tokenAttrs);
                    }
                    if (usage.totalTokens) {
                      telemetry.recordMetric('llm.tokens.total', usage.totalTokens, tokenAttrs);
                      // Always record agent tokens (even for anonymous agents)
                      telemetry.recordMetric('agent.tokens', usage.totalTokens, { agent_name: agentName || 'anonymous' });
                    }
                  }
                  
                  if (!toolPlan || !Array.isArray(toolPlan.toolCalls) || toolPlan.toolCalls.length === 0) {
                    // finish with final content
                    r.llmOutput = toolPlan?.content || r.llmOutput;
                    break;
                  }
                  // Execute tools sequentially and append results to prompt for the next iteration
                  let toolResultsAppend = "\n\n[Tool results]\n";
                  for (const call of toolPlan.toolCalls) {
                    const mapped = call;
                    let handle = mapped?.mcpHandle;
                    if (!handle) continue;
                    // Apply agent-level auth
                    handle = applyAgentAuth(handle);
                    // Validate args when schema known
                    try { validateToolArgs((availableTools.find(t => t.name === mapped.name) as any)?.parameters, mapped.arguments, `Tool ${mapped.name}`); } catch (e) { throw e; }
                    const idx = mapped.name.indexOf('.');
                    const actualToolName = idx >= 0 ? mapped.name.slice(idx + 1) : mapped.name;
                    const mcpStart = Date.now();
                    let result: any;
                    try {
                      result = await withMCP(handle, (c) => c.callTool({ name: actualToolName, arguments: mapped.arguments || {} }), telemetry, 'call_tool');
                    } catch (e) {
                      const provider = classifyProviderFromMcp(handle);
                      throw normalizeError(e, 'mcp-tool', { stepId: out.length, provider });
                    }
                    const mcpMs = Date.now() - mcpStart;
                    const toolCall: any = { name: mapped.name, arguments: mapped.arguments, endpoint: handle.url, result, ms: mcpMs };
                    aggregated.push(toolCall);
                    toolResultsAppend += `- ${mapped.name} -> ${typeof result === 'string' ? result : JSON.stringify(result)}\n`;
                  }
                  if (aggregated.length) r.toolCalls = aggregated;
                  // Prepare next prompt with appended tool results
                  workingPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory + toolResultsAppend;
                  // On next iteration, model can produce final answer or ask for more tools
                }
                // Ensure toolCalls is always set for automatic tool selection steps
                if (!r.toolCalls) r.toolCalls = [];
              }
            }
            // Automatic agent selection with iterative delegation
            else if ("agents" in s && "prompt" in s) {
              const usedLlm = (s as any).llm ?? defaultLlm;
              if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
              const stepInstructions = (s as any).instructions ?? globalInstructions;
              const cmr = (s as any).contextMaxToolResults ?? contextMaxToolResults;
              const cmc = (s as any).contextMaxChars ?? contextMaxChars;
              const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr, cmc);
              r.prompt = (s as any).prompt;
              
              const availableAgents = (s as any).agents as AgentBuilder[];
              if (availableAgents.length === 0 || !availableAgents.some(a => a.name && a.description)) {
                r.llmOutput = "No agents available or agents missing name/description.";
              } else {
                const agentContext = buildAgentContext(availableAgents);
                const maxIterations = (s as any).maxAgentIterations ?? defaultMaxToolIterations;
                let workingPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory + agentContext;
                const agentCalls: Array<{ name: string; task: string; result: string }> = [];
                let totalTokens = 0;
                const modelsUsed = new Set<string>();
                
                for (let i = 0; i < maxIterations; i++) {
                  // Show coordinator thinking
                  if (progress) {
                    if (i === 0) {
                      process.stdout.write('\n🧠 Coordinator selecting agents...\n');
                      process.stdout.write("   ⏳ Waiting for LLM..");
                    } else {
                      process.stdout.write('🧠 Coordinator deciding next step...\n');
                      process.stdout.write("   ⏳ Waiting for LLM..");
                    }
                    progress.startLlmOperation();
                  }
                  
                  const llmStart = Date.now();
                  let coordinatorResponse: string;
                  let coordTokenCount = 0;
                  
                  try {
                    // Use streaming for coordinator when progress enabled
                    if (progress && typeof usedLlm.genStream === 'function') {
                      const tokens: string[] = [];
                      for await (const token of usedLlm.genStream(workingPrompt)) {
                        tokens.push(token);
                        coordTokenCount++;
                        progress.llmToken(coordTokenCount, (usedLlm as any).id || usedLlm.model);
                      }
                      coordinatorResponse = tokens.join('');
                    } else {
                      coordinatorResponse = await usedLlm.gen(workingPrompt);
                    }
                  } catch (e) {
                    const provider = classifyProviderFromLlm(usedLlm);
                    throw normalizeError(e, 'llm', { stepId: out.length, provider });
                  }
                  const coordDuration = Date.now() - llmStart;
                  llmTotalMs += coordDuration;
                  
                  // Record token usage for coordinator LLM call
                  const coordUsage = (usedLlm as any).getUsage?.();
                  if (coordUsage && telemetry) {
                    const tokenAttrs = { 
                      provider: (usedLlm as any).id,
                      model: usedLlm.model,
                      agent_name: agentName || 'coordinator'
                    };
                    if (coordUsage.inputTokens) {
                      telemetry.recordMetric('llm.tokens.input', coordUsage.inputTokens, tokenAttrs);
                    }
                    if (coordUsage.outputTokens) {
                      telemetry.recordMetric('llm.tokens.output', coordUsage.outputTokens, tokenAttrs);
                    }
                    if (coordUsage.totalTokens) {
                      telemetry.recordMetric('llm.tokens.total', coordUsage.totalTokens, tokenAttrs);
                      if (agentName) {
                        telemetry.recordMetric('agent.tokens', coordUsage.totalTokens, { agent_name: agentName });
                      }
                    }
                  }
                  
                  const decision = parseAgentDecision(coordinatorResponse);
                  
                  if (decision.type === 'done') {
                    totalTokens += coordTokenCount;
                    modelsUsed.add((usedLlm as any).id || usedLlm.model);
                    if (progress) {
                    const coordTime = (Date.now() - llmStart) / 1000;
                    // Clear token line and coordinator status line, then print decision
                    process.stdout.write('\r\x1b[K');  // Clear token line
                    process.stdout.write('\x1b[1A\r\x1b[K');  // Move up and clear coordinator status line
                    if (i === 0) {
                      process.stdout.write('🧠 Coordinator: Final answer ready\n');
                    } else {
                      process.stdout.write('🧠 Coordinator: Final answer ready\n');
                    }
                    process.stdout.write(`   ✅ Complete | ${coordTokenCount} tokens | ${coordTime.toFixed(1)}s | ${(usedLlm as any).id || usedLlm.model}\n`);
                  }
                    r.llmOutput = decision.answer;
                    break;
                  } else if (decision.type === 'use_agent') {
                    totalTokens += coordTokenCount;
                    modelsUsed.add((usedLlm as any).id || usedLlm.model);
                    if (progress) {
                    const coordTime = (Date.now() - llmStart) / 1000;
                    // Clear token line and coordinator status line, then print decision
                    process.stdout.write('\r\x1b[K');  // Clear token line
                    process.stdout.write('\x1b[1A\r\x1b[K');  // Move up and clear coordinator status line
                    if (i === 0) {
                      process.stdout.write(`🧠 Coordinator decision: USE ${decision.agentName}\n`);
                    } else {
                      process.stdout.write(`🧠 Coordinator decision: USE ${decision.agentName}\n`);
                    }
                    process.stdout.write(`   ✅ Complete | ${coordTokenCount} tokens | ${coordTime.toFixed(1)}s | ${(usedLlm as any).id || usedLlm.model}\n`);
                  }
                    const selectedAgent = availableAgents.find(a => a.name === decision.agentName);
                    if (!selectedAgent) {
                      workingPrompt += `\n\nError: Agent '${decision.agentName}' not found. Available: ${availableAgents.map(a => a.name).join(', ')}`;
                      continue;
                    }
                    
                    if (progress) progress.agentStart(decision.agentName, decision.task);
                    
                    const agentStart = Date.now();
                    let agentResult: StepResult[];
                    let agentTokenCount = 0;
                    
                    try {
                      // Pass onToken to agent for progress tracking
                      const agentStep: any = { prompt: decision.task };
                      if (progress) {
                        agentStep.onToken = () => {
                          agentTokenCount++;
                          progress.agentToken(agentTokenCount, decision.agentName);
                        };
                      }
                      // Mark delegated agent as sub-agent to suppress its progress banner
                      const delegatedAgent = selectedAgent.then(agentStep);
                      (delegatedAgent as any).__isSubAgent = true;
                      (delegatedAgent as any).__parentAgentName = agentName || 'coordinator';
                      
                      // Record sub-agent relationship
                      if (telemetry) {
                        telemetry.recordMetric('agent.subagent_call', 1, {
                          parent_agent_name: agentName || 'coordinator',
                          agent_name: decision.agentName
                        });
                      }
                      
                      agentResult = await delegatedAgent.run();
                    } catch (e) {
                      workingPrompt += `\n\nAgent '${decision.agentName}' failed: ${(e as Error).message}`;
                      continue;
                    }
                    const agentMs = Date.now() - agentStart;
                    
                    totalTokens += agentTokenCount;
                    modelsUsed.add((usedLlm as any).id || usedLlm.model);
                    
                    const agentOutput = agentResult[agentResult.length - 1]?.llmOutput || '[no output]';
                    agentCalls.push({ name: decision.agentName, task: decision.task, result: agentOutput });
                    
                    if (progress) progress.agentComplete(decision.agentName, agentTokenCount, agentMs, (usedLlm as any).id || usedLlm.model);
                    
                    workingPrompt += `\n\nAgent '${decision.agentName}' completed (${agentMs}ms):\n${agentOutput}\n\nWhat's next?`;
                  } else {
                    if (i === maxIterations - 1) {
                      r.llmOutput = decision.raw;
                    } else {
                      workingPrompt += `\n\nPlease use the USE or DONE directive.`;
                    }
                  }
                }
                
                if (!r.llmOutput && agentCalls.length > 0) {
                  r.llmOutput = agentCalls[agentCalls.length - 1].result;
                }
                
                if (agentCalls.length > 0) {
                  (r as any).agentCalls = agentCalls;
                  (r as any).__crewTotalTokens = totalTokens;
                  (r as any).__crewModels = Array.from(modelsUsed);
                  telemetry?.recordMetric('agent.delegation', agentCalls.length, { agents: agentCalls.map(c => c.name).join(',') });
                  for (const agentCall of agentCalls) {
                    telemetry?.recordMetric('agent.call', 1, { agentName: agentCall.name });
                  }
                }
              }
            }
            // LLM-only steps
            else if ("prompt" in s && !("mcp" in s) && !("mcps" in s) && !("agents" in s)) {
              const usedLlm = (s as any).llm ?? defaultLlm;
              if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
              const stepInstructions = (s as any).instructions ?? globalInstructions;
              const cmr2 = (s as any).contextMaxToolResults ?? contextMaxToolResults;
              const cmc2 = (s as any).contextMaxChars ?? contextMaxChars;
              const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr2, cmc2);
              const finalPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory;
              r.prompt = (s as any).prompt;
              const llmSpan = telemetry?.startLLMSpan(stepSpan, usedLlm, finalPrompt) || null;
              if (progress) progress.startLlmOperation();
              const llmStart = Date.now();
              try {
                let tokenCount = 0;
                const customOnToken = (s as any).onToken;
                const progressOnToken = !customOnToken && progress ? () => {
                  tokenCount++;
                  progress.llmToken(tokenCount, (usedLlm as any).id || usedLlm.model);
                } : undefined;
                
                r.llmOutput = await executeLLMWithStreaming(
                  usedLlm,
                  finalPrompt,
                  customOnToken || progressOnToken,
                  undefined,
                  { stepIndex: out.length, stepPrompt: (s as any).prompt }
                );
                (r as any).__tokenCount = tokenCount;
                (r as any).__provider = (usedLlm as any).id || usedLlm.model;
                const llmCallDuration = Date.now() - llmStart;
                telemetry?.endSpan(llmSpan);
                telemetry?.recordMetric('llm.call', 1, { provider: (usedLlm as any).id || usedLlm.model, error: false });
                telemetry?.recordMetric('llm.duration', llmCallDuration, { provider: (usedLlm as any).id || usedLlm.model, model: usedLlm.model });
                
                // Record token usage if available
                const usage = (usedLlm as any).getUsage?.();
                if (usage && telemetry) {
                  const tokenAttrs = { 
                    provider: (usedLlm as any).id,
                    model: usedLlm.model,
                    agent_name: agentName || 'anonymous'
                  };
                  if (usage.inputTokens) {
                    telemetry.recordMetric('llm.tokens.input', usage.inputTokens, tokenAttrs);
                  }
                  if (usage.outputTokens) {
                    telemetry.recordMetric('llm.tokens.output', usage.outputTokens, tokenAttrs);
                  }
                  if (usage.totalTokens) {
                    telemetry.recordMetric('llm.tokens.total', usage.totalTokens, tokenAttrs);
                    // Always record agent tokens (even for anonymous agents)
                    telemetry.recordMetric('agent.tokens', usage.totalTokens, { agent_name: agentName || 'anonymous' });
                  }
                }
              } catch (e) {
                telemetry?.endSpan(llmSpan, undefined, e);
                telemetry?.recordMetric('llm.call', 1, { provider: (usedLlm as any).id || usedLlm.model, error: true });
                telemetry?.recordMetric('error', 1, { type: 'llm', provider: (usedLlm as any).id || usedLlm.model });
                const provider = classifyProviderFromLlm(usedLlm);
                throw normalizeError(e, 'llm', { stepId: out.length, provider });
              }
              llmTotalMs += Date.now() - llmStart;
            }
            // Explicit MCP tool calls (existing behavior)
            else if ("mcp" in s && "tool" in s) {
              // Apply agent-level auth
              const mcpHandle = applyAgentAuth((s as any).mcp);
              
              if ("prompt" in s) {
                const usedLlm = (s as any).llm ?? defaultLlm;
                if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
                const stepInstructions = (s as any).instructions ?? globalInstructions;
                const cmr3 = (s as any).contextMaxToolResults ?? contextMaxToolResults;
                const cmc3 = (s as any).contextMaxChars ?? contextMaxChars;
                const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr3, cmc3);
                const finalPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory;
                r.prompt = (s as any).prompt;
                const llmStart = Date.now();
                r.llmOutput = await usedLlm.gen(finalPrompt);
                llmTotalMs += Date.now() - llmStart;
              }
              // Validate against tool schema if discoverable
              const schema = await getToolSchema(mcpHandle, (s as any).tool);
              validateToolArgs(schema, (s as any).args ?? {}, `Tool ${mcpHandle.id}.${(s as any).tool}`);
              const mcpStart = Date.now();
              let res: any;
              try {
                res = await withMCP(mcpHandle, (c) => c.callTool({ name: (s as any).tool, arguments: (s as any).args ?? {} }), telemetry, 'call_tool');
              } catch (e) {
                const provider = classifyProviderFromMcp(mcpHandle);
                throw normalizeError(e, 'mcp-tool', { stepId: out.length, provider });
              }
              const mcpMs = Date.now() - mcpStart;
              r.mcp = { endpoint: mcpHandle.url, tool: (s as any).tool, result: res, ms: mcpMs };
            }
  
            r.llmMs = llmTotalMs;
            r.durationMs = Date.now() - stepStart;
            
            // End step span
            telemetry?.endSpan(stepSpan, r);
            telemetry?.recordMetric('step.duration', r.durationMs, { type: stepType });
            
            // Flush telemetry after each step for real-time visibility
            await telemetry?.flush();
            
            // Execute post-step hook
            if ((s as any).post) {
              try {
                (s as any).post();
              } catch (e) {
                console.warn('Post-step hook failed:', e);
              }
            }
            
            return r;
          };
  
          // Retry loop with per-attempt timeout
          let lastError: any;
          let result: StepResult | undefined;
          for (let attempt = 1; attempt <= attemptsTotal; attempt++) {
          try {
            const r = await withTimeout(doStep(), stepTimeoutMs, 'Step');
            result = r;
            break;
          } catch (e) {
            // classify
            const meta = { stepId: out.length } as VolcanoErrorMeta;
            let vErr: VolcanoError | undefined;
            if (e instanceof Error && /timed out/i.test(e.message)) {
              vErr = normalizeError(e, 'timeout', meta);
            } else if (e instanceof ValidationError || /failed schema validation/i.test(String((e as any)?.message || ''))) {
              vErr = normalizeError(e, 'validation', meta);
            } else {
              vErr = e as VolcanoError;
            }
            lastError = vErr || e;
            if (lastError instanceof VolcanoError && lastError.meta?.retryable === false) {
              throw lastError; // abort retries immediately for non-retryable errors
            }
              if (attempt >= attemptsTotal) break;
              // schedule wait according to policy
              if (typeof useBackoff === 'number' && useBackoff > 0) {
                const baseMs = 1000; // start at 1s
                const waitMs = baseMs * Math.pow(useBackoff, attempt - 1);
                await sleep(waitMs);
              } else {
                const waitMs = Math.max(0, (useDelay ?? 0) * 1000);
                if (waitMs > 0) await sleep(waitMs);
              }
            }
          }
        if (!result) throw (lastError instanceof VolcanoError ? lastError : new RetryExhaustedError('Retry attempts exhausted', { stepId: out.length }, { cause: lastError }));
  
          const r = result;
          if (progress) {
            const crewTokens = (r as any).__crewTotalTokens;
            const crewModels = (r as any).__crewModels;
            progress.stepComplete(r.durationMs || 0, (r as any).__tokenCount, (r as any).__provider, crewTokens, crewModels);
          }
          log?.(r, out.length);
          out.push(r);
          contextHistory.push(r);
        }
        // Populate aggregated totals on the final step
        if (out.length > 0) {
          const totalDuration = out.reduce((acc, s) => acc + (s.durationMs || 0), 0);
          const totalLlm = out.reduce((acc, s) => acc + (s.llmMs || 0), 0);
          const totalMcp = out.reduce((acc, s) => {
            let accStep = acc;
            if (s.mcp?.ms) accStep += s.mcp.ms;
            if (s.toolCalls) accStep += s.toolCalls.reduce((a, t) => a + (t.ms || 0), 0);
            return accStep;
          }, 0);
          const last = out[out.length - 1];
          last.totalDurationMs = totalDuration;
          last.totalLlmMs = totalLlm;
          last.totalMcpMs = totalMcp;
          
          // End agent span and record metrics
          telemetry?.endSpan(agentSpan, last);
          telemetry?.recordMetric('agent.duration', totalDuration, { steps: out.length });
          telemetry?.recordMetric('workflow.steps', out.length, { agent_name: agentName || 'anonymous' });
        }
        return out;
      } catch (error) {
        // End agent span with error
        telemetry?.endSpan(agentSpan, undefined, error);
        telemetry?.recordMetric('error', 1, { type: 'agent', level: 'workflow' });
        throw error;
      } finally {
        if (progress) {
          // Calculate totals for workflow end
          const totalTokens = out.reduce((acc, s) => {
            const stepTokens = (s as any).__tokenCount || (s as any).__crewTotalTokens || 0;
            return acc + stepTokens;
          }, 0);
          const modelsUsed = new Set<string>();
          out.forEach(s => {
            const provider = (s as any).__provider;
            const crewModels = (s as any).__crewModels;
            if (provider) modelsUsed.add(provider);
            if (crewModels) crewModels.forEach((m: string) => modelsUsed.add(m));
          });
          const totalDuration = out.reduce((acc, s) => acc + (s.durationMs || 0), 0);
          progress.workflowEnd(steps.length, totalTokens, totalDuration, Array.from(modelsUsed));
        }
        isRunning = false;
      }
    },
    async *stream(optionsOrLog?: StreamOptions | ((s: StepResult, stepIndex: number) => void)): AsyncGenerator<StepResult, void, unknown> {
      if (isRunning) {
        throw new AgentConcurrencyError('This agent is already running. Create a new agent() instance for concurrent runs.');
      }
      isRunning = true;
      
      const isSubAgent = (builder as any).__isSubAgent || false;
      const isExplicitSubAgent = (builder as any).__isExplicitSubAgent || false;
      const parentStepIndex = (builder as any).__parentStepIndex;
      const parentTotalSteps = (builder as any).__parentTotalSteps;
      const progress = showProgress ? createProgressHandler(steps.length, isSubAgent, isExplicitSubAgent, parentStepIndex, parentTotalSteps) : null;
      
      // Parse options for backward compatibility
      let streamOnToken: ((token: string, meta: TokenMetadata) => void) | undefined;
      let log: ((s: StepResult, stepIndex: number) => void) | undefined;
      
      if (typeof optionsOrLog === 'function') {
        // Old API: stream(callback)
        log = optionsOrLog;
      } else if (optionsOrLog) {
        // New API: stream({ onToken, onStep })
        streamOnToken = optionsOrLog.onToken;
        log = optionsOrLog.onStep;
      }
      
      // Start agent span
      const agentSpan = telemetry?.startAgentSpan(steps.length, agentName) || null;
      const out: StepResult[] = [];
      
      // Inherit parent context if this is a subagent
      if (!inheritedParentContext && (builder as any).__parentContext) {
        contextHistory = [...(builder as any).__parentContext];
        inheritedParentContext = true;
      }
      
      // Capture streamOnToken from stream() context for use in doStep
      const capturedStreamOnToken = streamOnToken;
      
      try {
        // snapshot steps array to make run isolated from later .then() calls
        const planned = [...steps];
        for (const raw of planned) {
          if ((raw as any).__reset) { contextHistory = []; continue; }
          
          // Handle advanced pattern steps (same as run() with hooks)
          if ((raw as any).__parallel) {
            const hooks = (raw as any).__hooks;
            try { hooks?.pre?.(); } catch (e) { console.warn('Pre-hook failed for parallel:', e); }
            
            const parallelResult = await executeParallel(
              (raw as any).__parallel,
              async (step: any) => {
                const subAgent = agent(opts).then(step);
                const results = await subAgent.run();
                return results[0];
              }
            );
            out.push(parallelResult);
            contextHistory.push(parallelResult);
            log?.(parallelResult, out.length - 1);
            yield parallelResult;
            
            try { hooks?.post?.(); } catch (e) { console.warn('Post-hook failed for parallel:', e); }
            continue;
          }
          
          if ((raw as any).__branch) {
            const { condition, branches } = (raw as any).__branch;
            const hooks = (raw as any).__hooks;
            try { hooks?.pre?.(); } catch (e) { console.warn('Pre-hook failed for branch:', e); }
            
            const branchResults = await executeBranch(condition, branches, out, () => agent(opts));
            out.push(...branchResults);
            contextHistory.push(...branchResults);
            for (const r of branchResults) {
              log?.(r, out.length - branchResults.length + branchResults.indexOf(r));
              yield r;
            }
            
            try { hooks?.post?.(); } catch (e) { console.warn('Post-hook failed for branch:', e); }
            continue;
          }
          
          if ((raw as any).__switch) {
            const { selector, cases } = (raw as any).__switch;
            const hooks = (raw as any).__hooks;
            try { hooks?.pre?.(); } catch (e) { console.warn('Pre-hook failed for switch:', e); }
            
            const switchResults = await executeSwitch(selector, cases, out, () => agent(opts));
            out.push(...switchResults);
            contextHistory.push(...switchResults);
            for (const r of switchResults) {
              log?.(r, out.length - switchResults.length + switchResults.indexOf(r));
              yield r;
            }
            
            try { hooks?.post?.(); } catch (e) { console.warn('Post-hook failed for switch:', e); }
            continue;
          }
          
          if ((raw as any).__while) {
            const { condition, body, opts: whileOpts } = (raw as any).__while;
            try { whileOpts?.pre?.(); } catch (e) { console.warn('Pre-hook failed for while:', e); }
            
            const whileResults = await executeWhile(condition, body, out, () => agent(opts), whileOpts);
            out.push(...whileResults);
            contextHistory.push(...whileResults);
            for (const r of whileResults) {
              log?.(r, out.length - whileResults.length + whileResults.indexOf(r));
              yield r;
            }
            
            try { whileOpts?.post?.(); } catch (e) { console.warn('Post-hook failed for while:', e); }
            continue;
          }
          
          if ((raw as any).__forEach) {
            const { items, body } = (raw as any).__forEach;
            const hooks = (raw as any).__hooks;
            try { hooks?.pre?.(); } catch (e) { console.warn('Pre-hook failed for forEach:', e); }
            
            const forEachResults = await executeForEach(items, body, () => agent(opts));
            out.push(...forEachResults);
            contextHistory.push(...forEachResults);
            for (const r of forEachResults) {
              log?.(r, out.length - forEachResults.length + forEachResults.indexOf(r));
              yield r;
            }
            
            try { hooks?.post?.(); } catch (e) { console.warn('Post-hook failed for forEach:', e); }
            continue;
          }
          
          if ((raw as any).__retryUntil) {
            const { body, successCondition, opts: retryOpts } = (raw as any).__retryUntil;
            try { retryOpts?.pre?.(); } catch (e) { console.warn('Pre-hook failed for retryUntil:', e); }
            
            const retryResults = await executeRetryUntil(body, successCondition, () => agent(opts), retryOpts);
            out.push(...retryResults);
            contextHistory.push(...retryResults);
            for (const r of retryResults) {
              log?.(r, out.length - retryResults.length + retryResults.indexOf(r));
              yield r;
            }
            
            try { retryOpts?.post?.(); } catch (e) { console.warn('Post-hook failed for retryUntil:', e); }
            continue;
          }
          
          if ((raw as any).__runAgent) {
            const { subAgent } = (raw as any).__runAgent;
            const hooks = (raw as any).__hooks;
            try { hooks?.pre?.(); } catch (e) { console.warn('Pre-hook failed for runAgent:', e); }
            
            // Pass parent's context to subagent
            const subResults = await executeRunAgent(subAgent, out.length, planned.length, contextHistory);
            out.push(...subResults);
            contextHistory.push(...subResults);
            for (const r of subResults) {
              log?.(r, out.length - subResults.length + subResults.indexOf(r));
              yield r;
            }
            
            try { hooks?.post?.(); } catch (e) { console.warn('Post-hook failed for runAgent:', e); }
            continue;
          }
          
          const s = typeof raw === 'function' ? (raw as StepFactory)(out) : (raw as Step);
          const stepTimeoutMs = (s as any).timeout != null ? (s as any).timeout * 1000 : defaultTimeoutMs; // seconds -> ms
          const retryCfg: RetryConfig = (s as any).retry ?? defaultRetry;
          const attemptsTotal = typeof retryCfg.retries === 'number' && retryCfg.retries! > 0 ? retryCfg.retries! : (defaultRetry.retries ?? 3);
          const useDelay = typeof retryCfg.delay === 'number' ? retryCfg.delay! : (defaultRetry.delay ?? 0);
          const useBackoff = retryCfg.backoff;
          if (useDelay && useBackoff) throw new Error('retry: specify either delay or backoff, not both');
  
          const doStep = async (): Promise<StepResult> => {
            // Execute pre-step hook
            if ((s as any).pre) {
              try {
                (s as any).pre();
              } catch (e) {
                console.warn('Pre-step hook failed:', e);
              }
            }
            
            // Determine step type for telemetry
            let stepType = 'unknown';
            if ("agents" in s) stepType = 'agent_crew';
            else if ("mcps" in s) stepType = 'mcp_auto';
            else if ("mcp" in s) stepType = 'mcp_explicit';
            else if ("prompt" in s) stepType = 'llm';
            
            // Start step span
            const stepPrompt = (s as any).prompt;
            const stepName = (s as any).name;
            const stepLlm = (s as any).llm || defaultLlm;
            const stepSpan = telemetry?.startStepSpan(agentSpan, out.length, stepType, stepPrompt, stepName, stepLlm) || null;
            
            const r: StepResult = {};
            const stepStart = Date.now();
            let llmTotalMs = 0;
            
            // Automatic tool selection with iterative tool calls
            if ("mcps" in s && "prompt" in s) {
              const usedLlm = (s as any).llm ?? defaultLlm;
              if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
              const stepInstructions = (s as any).instructions ?? globalInstructions;
              const cmr = (s as any).contextMaxToolResults ?? contextMaxToolResults;
              const cmc = (s as any).contextMaxChars ?? contextMaxChars;
              const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr, cmc);
              r.prompt = (s as any).prompt;
              // Apply agent-level auth to all MCP handles
              const mcpsWithAuth = ((s as any).mcps as MCPHandle[]).map(applyAgentAuth);
              const availableTools = await discoverTools(mcpsWithAuth);
              if (availableTools.length === 0) {
                r.llmOutput = "No tools available for this request.";
              } else {
                const aggregated: Array<{ name: string; endpoint: string; result: any; ms?: number }> = [];
                const maxIterations = (s as any).maxToolIterations ?? defaultMaxToolIterations;
                let workingPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory;
                for (let i = 0; i < maxIterations; i++) {
                  const llmStart = Date.now();
                  let toolPlan: LLMToolResult;
                  try {
                    toolPlan = await usedLlm.genWithTools(workingPrompt, availableTools);
                  } catch (e) {
                    const provider = classifyProviderFromLlm(usedLlm);
                    throw normalizeError(e, 'llm', { stepId: out.length, provider });
                  }
                  const llmCallDuration = Date.now() - llmStart;
                  llmTotalMs += llmCallDuration;
                  
                  // Record LLM metrics for this iteration
                  telemetry?.recordMetric('llm.call', 1, { provider: (usedLlm as any).id || usedLlm.model, error: false });
                  telemetry?.recordMetric('llm.duration', llmCallDuration, { provider: (usedLlm as any).id || usedLlm.model, model: usedLlm.model });
                  
                  // Record token usage for this LLM call
                  const usage = (usedLlm as any).getUsage?.();
                  if (usage && telemetry) {
                    const tokenAttrs = { 
                      provider: (usedLlm as any).id,
                      model: usedLlm.model,
                      agent_name: agentName || 'anonymous'
                    };
                    if (usage.inputTokens) {
                      telemetry.recordMetric('llm.tokens.input', usage.inputTokens, tokenAttrs);
                    }
                    if (usage.outputTokens) {
                      telemetry.recordMetric('llm.tokens.output', usage.outputTokens, tokenAttrs);
                    }
                    if (usage.totalTokens) {
                      telemetry.recordMetric('llm.tokens.total', usage.totalTokens, tokenAttrs);
                      // Always record agent tokens (even for anonymous agents)
                      telemetry.recordMetric('agent.tokens', usage.totalTokens, { agent_name: agentName || 'anonymous' });
                    }
                  }
                  
                  if (!toolPlan || !Array.isArray(toolPlan.toolCalls) || toolPlan.toolCalls.length === 0) {
                    // finish with final content
                    r.llmOutput = toolPlan?.content || r.llmOutput;
                    break;
                  }
                  // Execute tools sequentially and append results to prompt for the next iteration
                  let toolResultsAppend = "\n\n[Tool results]\n";
                  for (const call of toolPlan.toolCalls) {
                    const mapped = call;
                    let handle = mapped?.mcpHandle;
                    if (!handle) continue;
                    // Apply agent-level auth
                    handle = applyAgentAuth(handle);
                    // Validate args when schema known
                    try { validateToolArgs((availableTools.find(t => t.name === mapped.name) as any)?.parameters, mapped.arguments, `Tool ${mapped.name}`); } catch (e) { throw e; }
                    const idx = mapped.name.indexOf('.');
                    const actualToolName = idx >= 0 ? mapped.name.slice(idx + 1) : mapped.name;
                    const mcpStart = Date.now();
                    let result: any;
                    try {
                      result = await withMCP(handle, (c) => c.callTool({ name: actualToolName, arguments: mapped.arguments || {} }), telemetry, 'call_tool');
                    } catch (e) {
                      const provider = classifyProviderFromMcp(handle);
                      throw normalizeError(e, 'mcp-tool', { stepId: out.length, provider });
                    }
                    const mcpMs = Date.now() - mcpStart;
                    const toolCall: any = { name: mapped.name, arguments: mapped.arguments, endpoint: handle.url, result, ms: mcpMs };
                    aggregated.push(toolCall);
                    toolResultsAppend += `- ${mapped.name} -> ${typeof result === 'string' ? result : JSON.stringify(result)}\n`;
                  }
                  if (aggregated.length) r.toolCalls = aggregated;
                  // Prepare next prompt with appended tool results
                  workingPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory + toolResultsAppend;
                  // On next iteration, model can produce final answer or ask for more tools
                }
                // Ensure toolCalls is always set for automatic tool selection steps
                if (!r.toolCalls) r.toolCalls = [];
              }
            }
            // Automatic agent selection with iterative delegation
            else if ("agents" in s && "prompt" in s) {
              const usedLlm = (s as any).llm ?? defaultLlm;
              if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
              const stepInstructions = (s as any).instructions ?? globalInstructions;
              const cmr = (s as any).contextMaxToolResults ?? contextMaxToolResults;
              const cmc = (s as any).contextMaxChars ?? contextMaxChars;
              const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr, cmc);
              r.prompt = (s as any).prompt;
              
              const availableAgents = (s as any).agents as AgentBuilder[];
              if (availableAgents.length === 0 || !availableAgents.some(a => a.name && a.description)) {
                r.llmOutput = "No agents available or agents missing name/description.";
              } else {
                const agentContext = buildAgentContext(availableAgents);
                const maxIterations = (s as any).maxAgentIterations ?? defaultMaxToolIterations;
                let workingPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory + agentContext;
                const agentCalls: Array<{ name: string; task: string; result: string }> = [];
                let totalTokens = 0;
                const modelsUsed = new Set<string>();
                
                for (let i = 0; i < maxIterations; i++) {
                  // Show coordinator thinking
                  if (progress) {
                    if (i === 0) {
                      process.stdout.write('\n🧠 Coordinator selecting agents...\n');
                      process.stdout.write("   ⏳ Waiting for LLM..");
                    } else {
                      process.stdout.write('🧠 Coordinator deciding next step...\n');
                      process.stdout.write("   ⏳ Waiting for LLM..");
                    }
                    progress.startLlmOperation();
                  }
                  
                  const llmStart = Date.now();
                  let coordinatorResponse: string;
                  let coordTokenCount = 0;
                  
                  try {
                    // Use streaming for coordinator when progress enabled
                    if (progress && typeof usedLlm.genStream === 'function') {
                      const tokens: string[] = [];
                      for await (const token of usedLlm.genStream(workingPrompt)) {
                        tokens.push(token);
                        coordTokenCount++;
                        progress.llmToken(coordTokenCount, (usedLlm as any).id || usedLlm.model);
                      }
                      coordinatorResponse = tokens.join('');
                    } else {
                      coordinatorResponse = await usedLlm.gen(workingPrompt);
                    }
                  } catch (e) {
                    const provider = classifyProviderFromLlm(usedLlm);
                    throw normalizeError(e, 'llm', { stepId: out.length, provider });
                  }
                  const coordDuration = Date.now() - llmStart;
                  llmTotalMs += coordDuration;
                  
                  // Record token usage for coordinator LLM call
                  const coordUsage = (usedLlm as any).getUsage?.();
                  if (coordUsage && telemetry) {
                    const tokenAttrs = { 
                      provider: (usedLlm as any).id,
                      model: usedLlm.model,
                      agent_name: agentName || 'coordinator'
                    };
                    if (coordUsage.inputTokens) {
                      telemetry.recordMetric('llm.tokens.input', coordUsage.inputTokens, tokenAttrs);
                    }
                    if (coordUsage.outputTokens) {
                      telemetry.recordMetric('llm.tokens.output', coordUsage.outputTokens, tokenAttrs);
                    }
                    if (coordUsage.totalTokens) {
                      telemetry.recordMetric('llm.tokens.total', coordUsage.totalTokens, tokenAttrs);
                      if (agentName) {
                        telemetry.recordMetric('agent.tokens', coordUsage.totalTokens, { agent_name: agentName });
                      }
                    }
                  }
                  
                  const decision = parseAgentDecision(coordinatorResponse);
                  
                  if (decision.type === 'done') {
                    totalTokens += coordTokenCount;
                    modelsUsed.add((usedLlm as any).id || usedLlm.model);
                    if (progress) {
                    const coordTime = (Date.now() - llmStart) / 1000;
                    // Clear token line and coordinator status line, then print decision
                    process.stdout.write('\r\x1b[K');  // Clear token line
                    process.stdout.write('\x1b[1A\r\x1b[K');  // Move up and clear coordinator status line
                    if (i === 0) {
                      process.stdout.write('🧠 Coordinator: Final answer ready\n');
                    } else {
                      process.stdout.write('🧠 Coordinator: Final answer ready\n');
                    }
                    process.stdout.write(`   ✅ Complete | ${coordTokenCount} tokens | ${coordTime.toFixed(1)}s | ${(usedLlm as any).id || usedLlm.model}\n`);
                  }
                    r.llmOutput = decision.answer;
                    break;
                  } else if (decision.type === 'use_agent') {
                    totalTokens += coordTokenCount;
                    modelsUsed.add((usedLlm as any).id || usedLlm.model);
                    if (progress) {
                    const coordTime = (Date.now() - llmStart) / 1000;
                    // Clear token line and coordinator status line, then print decision
                    process.stdout.write('\r\x1b[K');  // Clear token line
                    process.stdout.write('\x1b[1A\r\x1b[K');  // Move up and clear coordinator status line
                    if (i === 0) {
                      process.stdout.write(`🧠 Coordinator decision: USE ${decision.agentName}\n`);
                    } else {
                      process.stdout.write(`🧠 Coordinator decision: USE ${decision.agentName}\n`);
                    }
                    process.stdout.write(`   ✅ Complete | ${coordTokenCount} tokens | ${coordTime.toFixed(1)}s | ${(usedLlm as any).id || usedLlm.model}\n`);
                  }
                    const selectedAgent = availableAgents.find(a => a.name === decision.agentName);
                    if (!selectedAgent) {
                      workingPrompt += `\n\nError: Agent '${decision.agentName}' not found. Available: ${availableAgents.map(a => a.name).join(', ')}`;
                      continue;
                    }
                    
                    if (progress) progress.agentStart(decision.agentName, decision.task);
                    
                    const agentStart = Date.now();
                    let agentResult: StepResult[];
                    let agentTokenCount = 0;
                    
                    try {
                      // Pass onToken to agent for progress tracking
                      const agentStep: any = { prompt: decision.task };
                      if (progress) {
                        agentStep.onToken = () => {
                          agentTokenCount++;
                          progress.agentToken(agentTokenCount, decision.agentName);
                        };
                      }
                      // Mark delegated agent as sub-agent to suppress its progress banner
                      const delegatedAgent = selectedAgent.then(agentStep);
                      (delegatedAgent as any).__isSubAgent = true;
                      (delegatedAgent as any).__parentAgentName = agentName || 'coordinator';
                      
                      // Record sub-agent relationship
                      if (telemetry) {
                        telemetry.recordMetric('agent.subagent_call', 1, {
                          parent_agent_name: agentName || 'coordinator',
                          agent_name: decision.agentName
                        });
                      }
                      
                      agentResult = await delegatedAgent.run();
                    } catch (e) {
                      workingPrompt += `\n\nAgent '${decision.agentName}' failed: ${(e as Error).message}`;
                      continue;
                    }
                    const agentMs = Date.now() - agentStart;
                    
                    totalTokens += agentTokenCount;
                    modelsUsed.add((usedLlm as any).id || usedLlm.model);
                    
                    const agentOutput = agentResult[agentResult.length - 1]?.llmOutput || '[no output]';
                    agentCalls.push({ name: decision.agentName, task: decision.task, result: agentOutput });
                    
                    if (progress) progress.agentComplete(decision.agentName, agentTokenCount, agentMs, (usedLlm as any).id || usedLlm.model);
                    
                    workingPrompt += `\n\nAgent '${decision.agentName}' completed (${agentMs}ms):\n${agentOutput}\n\nWhat's next?`;
                  } else {
                    if (i === maxIterations - 1) {
                      r.llmOutput = decision.raw;
                    } else {
                      workingPrompt += `\n\nPlease use the USE or DONE directive.`;
                    }
                  }
                }
                
                if (!r.llmOutput && agentCalls.length > 0) {
                  r.llmOutput = agentCalls[agentCalls.length - 1].result;
                }
                
                if (agentCalls.length > 0) {
                  (r as any).agentCalls = agentCalls;
                  (r as any).__crewTotalTokens = totalTokens;
                  (r as any).__crewModels = Array.from(modelsUsed);
                  telemetry?.recordMetric('agent.delegation', agentCalls.length, { agents: agentCalls.map(c => c.name).join(',') });
                  for (const agentCall of agentCalls) {
                    telemetry?.recordMetric('agent.call', 1, { agentName: agentCall.name });
                  }
                }
              }
            }
            // LLM-only steps
            else if ("prompt" in s && !("mcp" in s) && !("mcps" in s) && !("agents" in s)) {
              const usedLlm = (s as any).llm ?? defaultLlm;
              if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
              const stepInstructions = (s as any).instructions ?? globalInstructions;
              const cmr2 = (s as any).contextMaxToolResults ?? contextMaxToolResults;
              const cmc2 = (s as any).contextMaxChars ?? contextMaxChars;
              const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr2, cmc2);
              const finalPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory;
              r.prompt = (s as any).prompt;
              const llmSpan = telemetry?.startLLMSpan(stepSpan, usedLlm, finalPrompt) || null;
              const llmStart = Date.now();
              try {
                r.llmOutput = await executeLLMWithStreaming(
                  usedLlm,
                  finalPrompt,
                  (s as any).onToken,
                  capturedStreamOnToken,
                  { stepIndex: out.length, stepPrompt: (s as any).prompt }
                );
                const llmCallDuration = Date.now() - llmStart;
                telemetry?.endSpan(llmSpan);
                telemetry?.recordMetric('llm.call', 1, { provider: (usedLlm as any).id || usedLlm.model, error: false });
                telemetry?.recordMetric('llm.duration', llmCallDuration, { provider: (usedLlm as any).id || usedLlm.model, model: usedLlm.model });
              } catch (e) {
                telemetry?.endSpan(llmSpan, undefined, e);
                telemetry?.recordMetric('llm.call', 1, { provider: (usedLlm as any).id || usedLlm.model, error: true });
                telemetry?.recordMetric('error', 1, { type: 'llm', provider: (usedLlm as any).id || usedLlm.model });
                const provider = classifyProviderFromLlm(usedLlm);
                throw normalizeError(e, 'llm', { stepId: out.length, provider });
              }
              llmTotalMs += Date.now() - llmStart;
            }
            // Explicit MCP tool calls (existing behavior)
            else if ("mcp" in s && "tool" in s) {
              // Apply agent-level auth
              const mcpHandle = applyAgentAuth((s as any).mcp);
              
              if ("prompt" in s) {
                const usedLlm = (s as any).llm ?? defaultLlm;
                if (!usedLlm) throw new Error("No LLM provided. Pass { llm } to agent(...) or specify per-step.");
                const stepInstructions = (s as any).instructions ?? globalInstructions;
                const cmr3 = (s as any).contextMaxToolResults ?? contextMaxToolResults;
                const cmc3 = (s as any).contextMaxChars ?? contextMaxChars;
                const promptWithHistory = (s as any).prompt + buildHistoryContextChunked(contextHistory, cmr3, cmc3);
                const finalPrompt = (stepInstructions ? stepInstructions + "\n\n" : "") + promptWithHistory;
                r.prompt = (s as any).prompt;
                const llmStart = Date.now();
                r.llmOutput = await usedLlm.gen(finalPrompt);
                llmTotalMs += Date.now() - llmStart;
              }
              // Validate against tool schema if discoverable
              const schema = await getToolSchema(mcpHandle, (s as any).tool);
              validateToolArgs(schema, (s as any).args ?? {}, `Tool ${mcpHandle.id}.${(s as any).tool}`);
              const mcpStart = Date.now();
              let res: any;
              try {
                res = await withMCP(mcpHandle, (c) => c.callTool({ name: (s as any).tool, arguments: (s as any).args ?? {} }), telemetry, 'call_tool');
              } catch (e) {
                const provider = classifyProviderFromMcp(mcpHandle);
                throw normalizeError(e, 'mcp-tool', { stepId: out.length, provider });
              }
              const mcpMs = Date.now() - mcpStart;
              r.mcp = { endpoint: mcpHandle.url, tool: (s as any).tool, result: res, ms: mcpMs };
            }
  
            r.llmMs = llmTotalMs;
            r.durationMs = Date.now() - stepStart;
            
            // End step span
            telemetry?.endSpan(stepSpan, r);
            telemetry?.recordMetric('step.duration', r.durationMs, { type: stepType });
            
            // Flush telemetry after each step for real-time visibility
            await telemetry?.flush();
            
            // Execute post-step hook
            if ((s as any).post) {
              try {
                (s as any).post();
              } catch (e) {
                console.warn('Post-step hook failed:', e);
              }
            }
            
            return r;
          };
  
          // Retry loop with per-attempt timeout
          let lastError: any;
          let result: StepResult | undefined;
          for (let attempt = 1; attempt <= attemptsTotal; attempt++) {
          try {
            const r = await withTimeout(doStep(), stepTimeoutMs, 'Step');
            result = r;
            break;
          } catch (e) {
            // classify
            const meta = { stepId: out.length } as VolcanoErrorMeta;
            let vErr: VolcanoError | undefined;
            if (e instanceof Error && /timed out/i.test(e.message)) {
              vErr = normalizeError(e, 'timeout', meta);
            } else if (e instanceof ValidationError || /failed schema validation/i.test(String((e as any)?.message || ''))) {
              vErr = normalizeError(e, 'validation', meta);
            } else {
              vErr = e as VolcanoError;
            }
            lastError = vErr || e;
            if (lastError instanceof VolcanoError && lastError.meta?.retryable === false) {
              throw lastError; // abort retries immediately for non-retryable errors
            }
              if (attempt >= attemptsTotal) break;
              // schedule wait according to policy
              if (typeof useBackoff === 'number' && useBackoff > 0) {
                const baseMs = 1000; // start at 1s
                const waitMs = baseMs * Math.pow(useBackoff, attempt - 1);
                await sleep(waitMs);
              } else {
                const waitMs = Math.max(0, (useDelay ?? 0) * 1000);
                if (waitMs > 0) await sleep(waitMs);
              }
            }
          }
        if (!result) throw (lastError instanceof VolcanoError ? lastError : new RetryExhaustedError('Retry attempts exhausted', { stepId: out.length }, { cause: lastError }));
  
          const r = result;
          log?.(r, out.length);
          out.push(r);
          contextHistory.push(r);
          
          // Yield the step result for streaming
          yield r;
        }
        // Note: We don't populate aggregated totals for streaming since it's incremental
      } finally {
        if (progress) {
          // Calculate totals for workflow end
          const totalTokens = out.reduce((acc, s) => {
            const stepTokens = (s as any).__tokenCount || (s as any).__crewTotalTokens || 0;
            return acc + stepTokens;
          }, 0);
          const modelsUsed = new Set<string>();
          out.forEach(s => {
            const provider = (s as any).__provider;
            const crewModels = (s as any).__crewModels;
            if (provider) modelsUsed.add(provider);
            if (crewModels) crewModels.forEach((m: string) => modelsUsed.add(m));
          });
          const totalDuration = out.reduce((acc, s) => acc + (s.durationMs || 0), 0);
          progress.workflowEnd(steps.length, totalTokens, totalDuration, Array.from(modelsUsed));
        }
        isRunning = false;
      }
    },
  };
  
  return builder;
}
