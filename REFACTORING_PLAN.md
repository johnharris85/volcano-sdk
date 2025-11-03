# Volcano SDK Refactoring Execution Plan

**Goal:** Split `src/volcano-sdk.ts` (2,435 lines) into focused modules while maintaining 100% backwards compatibility.

**Strategy:** Extract modules one at a time, test after each extraction, commit frequently.

---

## Prerequisites

### 1. Prepare Environment

```bash
# Ensure clean working directory
git status

# Create refactoring branch
git checkout -b refactor/modularize-sdk

# Run all tests to establish baseline
npm run build
npm test

# Verify module tests pass
npm test tests/modules
```

**Success criteria:** All tests pass ✅

### 2. Set Up Continuous Verification Script

Create `scripts/verify-refactoring.sh`:

```bash
#!/bin/bash
set -e

echo "🔨 Building..."
npm run build

echo "🧪 Running module tests..."
npm test tests/modules

echo "🧪 Running all tests..."
npm test

echo "✅ All checks passed!"
```

Make executable:
```bash
chmod +x scripts/verify-refactoring.sh
```

Use after each module extraction:
```bash
./scripts/verify-refactoring.sh
```

---

## Phase 1: Extract Foundation Modules (Low Risk)

These modules have **no internal dependencies** and are **pure utilities**.

### Step 1.1: Extract Error Classes

**Time estimate:** 30 minutes

#### Actions

1. **Create `src/errors.ts`**

```typescript
// src/errors.ts
export interface VolcanoErrorMeta {
  stepId?: number;
  provider?: string;
  requestId?: string;
  retryable?: boolean;
}

export class VolcanoError extends Error {
  meta: VolcanoErrorMeta;
  constructor(message: string, meta: VolcanoErrorMeta = {}, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.meta = meta;
    if (options?.cause) (this as any).cause = options.cause;
  }
}

export class AgentConcurrencyError extends VolcanoError {}
export class TimeoutError extends VolcanoError {}
export class ValidationError extends VolcanoError {}
export class RetryExhaustedError extends VolcanoError {}
export class LLMError extends VolcanoError {}
export class MCPError extends VolcanoError {}
export class MCPConnectionError extends MCPError {}
export class MCPToolError extends MCPError {}

// Helper functions
export function isRetryableStatus(status?: number): boolean {
  if (!status && status !== 0) return false;
  return status >= 500 || status === 429 || status === 408;
}

export function classifyProviderFromLlm(usedLlm?: any): string | undefined {
  if (!usedLlm) return undefined;
  if ((usedLlm as any).id) return `llm:${(usedLlm as any).id}`;
  return `llm:${usedLlm.model}`;
}

export function classifyProviderFromMcp(handle?: any): string | undefined {
  if (!handle) return undefined;
  try {
    const u = new URL(handle.url);
    return `mcp:${u.host}`;
  } catch {
    return `mcp:${handle.id}`;
  }
}

export function normalizeError(
  e: any,
  kind: 'timeout'|'validation'|'llm'|'mcp-conn'|'mcp-tool'|'retry',
  meta: VolcanoErrorMeta
): VolcanoError {
  if (kind === 'timeout') {
    return new TimeoutError(e?.message || 'Step timed out', { ...meta, retryable: true }, { cause: e });
  }
  if (kind === 'validation') {
    return new ValidationError(e?.message || 'Validation failed', { ...meta, retryable: false }, { cause: e });
  }
  if (kind === 'retry') {
    return new RetryExhaustedError(e?.message || 'Retry attempts exhausted', { ...meta }, { cause: e });
  }
  if (kind === 'llm') {
    const status = e?.status ?? e?.response?.status;
    const requestId = e?.response?.headers?.get?.('x-request-id') || e?.id || e?.response?.data?.id;
    const retryable = (status == null ? true : isRetryableStatus(status)) ||
                      !!e?.code?.toString?.()?.includes?.('ECONN') ||
                      !!e?.code?.toString?.()?.includes?.('ETIMEDOUT');
    return new LLMError(e?.message || 'LLM error', { ...meta, requestId, retryable }, { cause: e });
  }
  if (kind === 'mcp-conn') {
    const retryable = true;
    return new MCPConnectionError(e?.message || 'MCP connection error', { ...meta, retryable }, { cause: e });
  }
  // mcp-tool
  return new MCPToolError(e?.message || 'MCP tool error', { ...meta, retryable: false }, { cause: e });
}
```

2. **Update `src/volcano-sdk.ts`**

Replace error classes section (lines 30-86) with:

```typescript
// src/volcano-sdk.ts
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

// Re-export for public API
export {
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
};

// Remove the old error class definitions and helper functions
```

3. **Update `tsconfig.json`** (if needed)

Ensure module resolution is correct (should already be fine).

4. **Test**

```bash
./scripts/verify-refactoring.sh
```

5. **Commit**

```bash
git add src/errors.ts src/volcano-sdk.ts
git commit -m "refactor: extract error classes to src/errors.ts

- Move all error classes and helpers to dedicated module
- Maintain backwards compatibility via re-exports
- No behavior changes

Tests: npm test tests/modules/errors.test.ts"
```

**Success criteria:**
- ✅ `npm test tests/modules/errors.test.ts` passes
- ✅ All other tests still pass
- ✅ Build succeeds

---

### Step 1.2: Extract Validation

**Time estimate:** 20 minutes

#### Actions

1. **Create `src/validation.ts`**

```typescript
// src/validation.ts
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });
const VALIDATOR_CACHE = new WeakMap<object, any>();

export function validateToolArgs(schema: any | undefined, args: any, context: string): void {
  if (!schema || typeof schema !== 'object') return; // nothing to validate

  let validate = VALIDATOR_CACHE.get(schema);
  if (!validate) {
    validate = ajv.compile(schema as any);
    VALIDATOR_CACHE.set(schema, validate);
  }

  const ok = validate(args);
  if (!ok) {
    const msg = (validate.errors || [])
      .map((e: any) => `${e.instancePath || e.schemaPath}: ${e.message}`)
      .join('; ');
    throw new Error(`${context} arguments failed schema validation: ${msg}`);
  }
}

// Test helper (keep the __internal_ prefix for backwards compatibility)
export function __internal_validateToolArgs(schema: any, args: any) {
  validateToolArgs(schema, args, 'test');
}
```

2. **Update `src/volcano-sdk.ts`**

Replace validation section (lines 149-165) with:

```typescript
import { validateToolArgs, __internal_validateToolArgs } from "./validation.js";

export { __internal_validateToolArgs };

// Remove old validation code
```

Update all `validateWithSchema` calls to `validateToolArgs`.

3. **Test**

```bash
./scripts/verify-refactoring.sh
```

4. **Commit**

```bash
git add src/validation.ts src/volcano-sdk.ts
git commit -m "refactor: extract validation to src/validation.ts

- Move Ajv validation logic to dedicated module
- Maintain __internal_validateToolArgs export
- No behavior changes

Tests: npm test tests/modules/validation.test.ts"
```

---

### Step 1.3: Extract Agent Utils

**Time estimate:** 20 minutes

#### Actions

1. **Create `src/agent/utils.ts`**

```typescript
// src/agent/utils.ts
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'Step'
): Promise<T> {
  let timer: any;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import { sleep, withTimeout } from "./agent/utils.js";

// Remove old sleep and withTimeout functions (lines ~418-428)
```

3. **Test**

```bash
./scripts/verify-refactoring.sh
```

4. **Commit**

```bash
git add src/agent/utils.ts src/volcano-sdk.ts
git commit -m "refactor: extract agent utils to src/agent/utils.ts

- Move sleep and withTimeout to dedicated module
- No behavior changes

Tests: npm test tests/modules/agent-utils.test.ts"
```

---

## Phase 2: Extract MCP Infrastructure (Medium Risk)

These modules depend on errors but are otherwise independent.

### Step 2.1: Extract MCP Types

**Time estimate:** 15 minutes

#### Actions

1. **Create `src/mcp/types.ts`**

```typescript
// src/mcp/types.ts
export type MCPAuthConfig = {
  type: 'oauth' | 'bearer';
  token?: string;           // For bearer auth: direct token
  clientId?: string;        // For OAuth: client credentials
  clientSecret?: string;
  tokenEndpoint?: string;   // OAuth token endpoint
  scope?: string;           // OAuth scope (optional)
};

export type MCPHandle = {
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: any }> }>;
  callTool: (name: string, args: Record<string, any>) => Promise<any>;
  id: string;
  url: string;
  auth?: MCPAuthConfig;
};
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import type { MCPAuthConfig, MCPHandle } from "./mcp/types.js";

export type { MCPAuthConfig, MCPHandle };

// Remove old type definitions
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/mcp/types.ts src/volcano-sdk.ts
git commit -m "refactor: extract MCP types to src/mcp/types.ts"
```

---

### Step 2.2: Extract MCP Auth

**Time estimate:** 45 minutes

#### Actions

1. **Create `src/mcp/auth.ts`**

Extract OAuth token cache and related functions (lines ~180-229, ~266-305, ~379-416).

```typescript
// src/mcp/auth.ts
import type { MCPAuthConfig } from "./types.js";

type TokenCacheEntry = { token: string; expiresAt: number };
const OAUTH_TOKEN_CACHE = new Map<string, TokenCacheEntry>();

export async function getOAuthToken(auth: MCPAuthConfig, endpoint: string): Promise<string> {
  // ... (copy from volcano-sdk.ts lines 183-228)
}

export async function executeWithAuth<T>(
  auth: MCPAuthConfig,
  endpoint: string,
  fn: () => Promise<T>
): Promise<T> {
  // ... (copy from volcano-sdk.ts lines 379-416)
}

export function clearOAuthTokenCache(): void {
  OAUTH_TOKEN_CACHE.clear();
}

export function getOAuthTokenCacheStats() {
  return {
    size: OAUTH_TOKEN_CACHE.size,
    endpoints: Array.from(OAUTH_TOKEN_CACHE.keys()),
  };
}

// Exports for testing
export const __internal_clearOAuthTokenCache = clearOAuthTokenCache;
export const __internal_getOAuthTokenCache = getOAuthTokenCacheStats;
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import {
  getOAuthToken,
  executeWithAuth,
  __internal_clearOAuthTokenCache,
  __internal_getOAuthTokenCache,
} from "./mcp/auth.js";

export { __internal_clearOAuthTokenCache, __internal_getOAuthTokenCache };

// Remove old auth code
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/mcp/auth.ts src/volcano-sdk.ts
git commit -m "refactor: extract MCP auth to src/mcp/auth.ts

Tests: npm test tests/modules/mcp-auth.test.ts"
```

---

### Step 2.3: Extract MCP Client

**Time estimate:** 60 minutes

This is more complex - connection pooling logic.

#### Actions

1. **Create `src/mcp/client.ts`**

Extract pool management (lines ~167-178, ~231-265, ~306-343, ~344-377).

```typescript
// src/mcp/client.ts
import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MCPHandle, MCPAuthConfig } from "./types.js";
import { normalizeError, classifyProviderFromMcp } from "../errors.js";

type MCPPoolEntry = {
  client: MCPClient;
  transport: StreamableHTTPClientTransport;
  lastUsed: number;
  busyCount: number;
  auth?: MCPAuthConfig;
};

const MCP_POOL = new Map<string, MCPPoolEntry>();
let MCP_POOL_MAX = 16;
let MCP_POOL_IDLE_MS = 30_000;

export async function getPooledClient(url: string, auth?: MCPAuthConfig): Promise<MCPPoolEntry> {
  // ... (copy pooling logic)
}

async function connectWithAuth(transport: any, client: MCPClient, auth: MCPAuthConfig, endpoint: string) {
  // ... (copy auth connection logic)
}

async function cleanupIdlePool() {
  // ...
}

function ensurePoolSweeper() {
  // ...
}

export async function withMCP<T>(
  h: MCPHandle,
  fn: (c: MCPClient) => Promise<T>,
  telemetry?: any,
  operation?: string
): Promise<T> {
  // ... (copy withMCP logic)
}

export function getMcpPoolStats() {
  return {
    size: MCP_POOL.size,
    urls: Array.from(MCP_POOL.keys()).map(k => k.split('::')[0]),
  };
}

export function setPoolConfig(max: number, idleMs: number) {
  MCP_POOL_MAX = max;
  MCP_POOL_IDLE_MS = idleMs;
}

// Test exports
export const __internal_getMcpPoolStats = getMcpPoolStats;
export const __internal_setPoolConfig = setPoolConfig;
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import {
  withMCP,
  __internal_getMcpPoolStats,
  __internal_setPoolConfig,
} from "./mcp/client.js";

export { __internal_getMcpPoolStats, __internal_setPoolConfig };

// Remove pool code
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/mcp/client.ts src/volcano-sdk.ts
git commit -m "refactor: extract MCP client pooling to src/mcp/client.ts

Tests: npm test tests/modules/mcp-client.test.ts"
```

---

### Step 2.4: Extract MCP Discovery

**Time estimate:** 45 minutes

#### Actions

1. **Create `src/mcp/discovery.ts`**

Extract tool discovery and caching (lines ~430-520).

```typescript
// src/mcp/discovery.ts
import type { MCPHandle } from "./types.js";
import type { ToolDefinition } from "../llms/types.js";
import { withMCP } from "./client.js";
import { normalizeError, classifyProviderFromMcp } from "../errors.js";

const TOOL_CACHE = new Map<string, { tools: ToolDefinition[]; ts: number }>();
let TOOL_CACHE_TTL_MS = 60_000;

export async function discoverTools(handles: MCPHandle[]): Promise<ToolDefinition[]> {
  // ... (copy discovery logic)
}

export async function getToolSchema(handle: MCPHandle, toolName: string): Promise<any | undefined> {
  // ... (copy schema fetching)
}

export function clearDiscoveryCache(): void {
  TOOL_CACHE.clear();
}

export function setDiscoveryTtl(ms: number): void {
  TOOL_CACHE_TTL_MS = ms;
}

export function primeDiscoveryCache(
  handle: MCPHandle,
  rawTools: Array<{ name: string; inputSchema?: any; description?: string }>
): void {
  // ... (copy priming logic)
}

// Test exports
export const __internal_clearDiscoveryCache = clearDiscoveryCache;
export const __internal_setDiscoveryTtl = setDiscoveryTtl;
export const __internal_primeDiscoveryCache = primeDiscoveryCache;
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import {
  discoverTools,
  __internal_clearDiscoveryCache,
  __internal_setDiscoveryTtl,
  __internal_primeDiscoveryCache,
} from "./mcp/discovery.js";

export {
  discoverTools,
  __internal_clearDiscoveryCache,
  __internal_setDiscoveryTtl,
  __internal_primeDiscoveryCache,
};

// Remove discovery code
```

3. **Create `src/mcp/index.ts` (barrel export)**

```typescript
// src/mcp/index.ts
export * from "./types.js";
export * from "./client.js";
export * from "./auth.js";
export * from "./discovery.js";
```

4. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/mcp/ src/volcano-sdk.ts
git commit -m "refactor: extract MCP discovery to src/mcp/discovery.ts

- Add src/mcp/index.ts barrel export
Tests: npm test tests/modules/mcp-discovery.test.ts"
```

---

### Step 2.5: Update mcp() Factory Function

**Time estimate:** 30 minutes

The `mcp()` function uses discovery, so update it.

#### Actions

1. **Create `src/mcp/factory.ts`**

```typescript
// src/mcp/factory.ts
import { createHash } from "node:crypto";
import type { MCPHandle, MCPAuthConfig } from "./types.js";
import { withMCP } from "./client.js";

export function mcp(url: string, options?: { auth?: MCPAuthConfig }): MCPHandle {
  // Use hash-based ID to keep tool names under OpenAI's 64-char limit
  const hash = createHash('md5').update(url).digest('hex').substring(0, 8);
  const id = `mcp_${hash}`;

  return {
    id,
    url,
    auth: options?.auth,
    listTools: async () => {
      return withMCP({ id, url, auth: options?.auth } as MCPHandle, (c) => c.listTools());
    },
    callTool: async (name, args) => {
      return withMCP({ id, url, auth: options?.auth } as MCPHandle, (c) =>
        c.callTool({ name, arguments: args })
      );
    }
  };
}
```

2. **Update `src/mcp/index.ts`**

```typescript
export * from "./types.js";
export * from "./client.js";
export * from "./auth.js";
export * from "./discovery.js";
export * from "./factory.js";
```

3. **Update `src/volcano-sdk.ts`**

```typescript
import { mcp } from "./mcp/index.js";
export { mcp };

// Remove old mcp() function
```

4. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/mcp/factory.ts src/mcp/index.ts src/volcano-sdk.ts
git commit -m "refactor: extract mcp() factory to src/mcp/factory.ts"
```

---

## Phase 3: Extract Agent Components (Higher Risk)

### Step 3.1: Extract Agent Types

**Time estimate:** 30 minutes

#### Actions

1. **Create `src/agent/types.ts`**

Extract all agent-related types (lines ~523-631):

```typescript
// src/agent/types.ts
import type { LLMHandle, ToolDefinition } from "../llms/types.js";
import type { MCPHandle } from "../mcp/types.js";
import type { VolcanoTelemetry } from "../telemetry.js";

export type RetryConfig = {
  delay?: number;
  backoff?: number;
  retries?: number;
};

export type TokenMetadata = {
  stepIndex: number;
  handledByStep: boolean;
  stepPrompt?: string;
  llmProvider?: string;
};

export type StreamOptions = {
  onToken?: (token: string, meta: TokenMetadata) => void;
  onStep?: (s: StepResult, stepIndex: number) => void;
};

export type Step =
  | { prompt: string; llm?: LLMHandle; mcps?: MCPHandle[]; /* ... */ }
  | { mcp: MCPHandle; tool: string; args?: Record<string, any>; /* ... */ }
  | { /* ... other step types */ };

export type StepResult = {
  prompt?: string;
  llmOutput?: string;
  // ... all other fields
};

export interface AgentBuilder {
  name?: string;
  description?: string;
  resetHistory(): AgentBuilder;
  then(s: Step | StepFactory): AgentBuilder;
  parallel(/* ... */): AgentBuilder;
  // ... all other methods
  run(log?: (s: StepResult, stepIndex: number) => void): Promise<StepResult[]>;
  stream(optionsOrLog?: StreamOptions | ((s: StepResult, stepIndex: number) => void)): AsyncGenerator<StepResult>;
}

export type StepFactory = (history: StepResult[]) => Step;

export type AgentOptions = {
  llm?: LLMHandle;
  instructions?: string;
  name?: string;
  // ... all other options
};
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import type {
  RetryConfig,
  TokenMetadata,
  StreamOptions,
  Step,
  StepResult,
  AgentBuilder,
  AgentOptions
} from "./agent/types.js";

export type {
  RetryConfig,
  TokenMetadata,
  StreamOptions,
  Step,
  StepResult,
  AgentBuilder
};

// Remove old type definitions
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/agent/types.ts src/volcano-sdk.ts
git commit -m "refactor: extract agent types to src/agent/types.ts"
```

---

### Step 3.2: Extract Agent Context

**Time estimate:** 30 minutes

#### Actions

1. **Create `src/agent/context.ts`**

```typescript
// src/agent/context.ts
import type { StepResult } from "./types.js";

export function buildHistoryContextChunked(
  history: StepResult[],
  maxToolResults: number,
  maxChars: number
): string {
  // ... (copy from lines 632-704)
}
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import { buildHistoryContextChunked } from "./agent/context.js";

// Remove old function
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/agent/context.ts src/volcano-sdk.ts
git commit -m "refactor: extract context building to src/agent/context.ts

Tests: npm test tests/modules/agent-context.test.ts"
```

---

### Step 3.3: Extract Agent Progress

**Time estimate:** 45 minutes

#### Actions

1. **Create `src/agent/progress.ts`**

Extract progress rendering (lines ~750-894):

```typescript
// src/agent/progress.ts
export type ProgressHandler = {
  stepStart: (stepIndex: number, prompt?: string) => void;
  startLlmOperation: () => void;
  llmToken: (count: number, provider?: string) => void;
  agentStart: (agentName: string, task: string) => void;
  agentToken: (count: number, provider?: string) => void;
  agentComplete: (agentName: string, tokens: number, durationMs: number, provider?: string) => void;
  stepComplete: (durationMs: number, tokenCount?: number, provider?: string, crewTokens?: number, crewModels?: string[]) => void;
  workflowEnd: (stepCount: number, totalTokens?: number, totalDuration?: number, models?: string[]) => void;
};

const createProgressDisplay = (workflowStart: number, isTTY: boolean) => ({
  // ... (copy display helpers)
});

export function createProgressHandler(
  totalSteps: number,
  isSubAgent: boolean = false,
  isExplicitSubAgent: boolean = false,
  parentStepIndex?: number,
  parentTotalSteps?: number
): ProgressHandler | null {
  // ... (copy from lines 781-894)
}
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import { createProgressHandler } from "./agent/progress.js";

// Remove old progress code
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/agent/progress.ts src/volcano-sdk.ts
git commit -m "refactor: extract progress rendering to src/agent/progress.ts

Tests: npm test tests/modules/agent-progress.test.ts"
```

---

### Step 3.4: Extract Multi-Agent Crews Logic

**Time estimate:** 20 minutes

#### Actions

1. **Create `src/agent/crews.ts`**

```typescript
// src/agent/crews.ts
import type { AgentBuilder } from "./types.js";

export function buildAgentContext(agents: AgentBuilder[]): string {
  // ... (copy from lines 899-913)
}

export function parseAgentDecision(response: string):
  | { type: 'use_agent'; agentName: string; task: string }
  | { type: 'done'; answer: string }
  | { type: 'continue'; raw: string }
{
  // ... (copy from lines 918-944)
}
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import { buildAgentContext, parseAgentDecision } from "./agent/crews.js";

// Remove old functions
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/agent/crews.ts src/volcano-sdk.ts
git commit -m "refactor: extract multi-agent crews to src/agent/crews.ts"
```

---

### Step 3.5: Extract Streaming Helper

**Time estimate:** 30 minutes

#### Actions

1. **Create `src/agent/streaming.ts`**

```typescript
// src/agent/streaming.ts
import type { LLMHandle } from "../llms/types.js";
import type { TokenMetadata } from "./types.js";

export async function executeLLMWithStreaming(
  llm: LLMHandle,
  prompt: string,
  stepOnToken: ((token: string) => void) | undefined,
  streamOnToken: ((token: string, meta: TokenMetadata) => void) | undefined,
  meta: { stepIndex: number; stepPrompt?: string }
): Promise<string> {
  // ... (copy from lines 710-745)
}
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import { executeLLMWithStreaming } from "./agent/streaming.js";

// Remove old function
```

3. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/agent/streaming.ts src/volcano-sdk.ts
git commit -m "refactor: extract LLM streaming to src/agent/streaming.ts"
```

---

## Phase 4: The Big Refactor - Deduplicate Executor (Highest Risk)

### Step 4.1: Create Unified Step Executor

**Time estimate:** 3-4 hours (most complex)

This is the **highest risk** step. The current `run()` and `stream()` methods have 90% duplicated code.

#### Strategy

1. Extract step execution logic into a shared executor
2. Make executor support both modes (collect vs yield)
3. Update both `run()` and `stream()` to use executor

#### Actions

1. **Create `src/agent/executor.ts`**

This requires careful analysis of the duplicated code in `run()` and `stream()`.

```typescript
// src/agent/executor.ts
import type { Step, StepResult, AgentOptions, TokenMetadata } from "./types.js";
import type { LLMHandle } from "../llms/types.js";
import type { MCPHandle } from "../mcp/types.js";
import { normalizeError } from "../errors.js";
import { validateToolArgs } from "../validation.js";
import { withTimeout, sleep } from "./utils.js";
import { buildHistoryContextChunked } from "./context.js";
import { executeLLMWithStreaming } from "./streaming.js";
import { discoverTools } from "../mcp/discovery.js";
import { withMCP } from "../mcp/client.js";

type ExecutionContext = {
  defaultLlm?: LLMHandle;
  globalInstructions?: string;
  contextMaxChars: number;
  contextMaxToolResults: number;
  defaultMaxToolIterations: number;
  telemetry?: any;
  applyAgentAuth: (handle: MCPHandle) => MCPHandle;
  streamOnToken?: (token: string, meta: TokenMetadata) => void;
};

export async function executeStep(
  step: Step,
  stepIndex: number,
  contextHistory: StepResult[],
  context: ExecutionContext,
  progress?: any
): Promise<StepResult> {
  // Unified step execution logic
  // Handle:
  // - Simple prompt steps
  // - MCP auto-selection steps
  // - Explicit MCP tool calls
  // - Crew coordination
  // - Tool calling loops
  // - Telemetry
  // - Progress updates

  const stepStart = Date.now();
  const r: StepResult = { durationMs: 0 };

  // ... (extract common logic from both run() and stream())

  r.durationMs = Date.now() - stepStart;
  return r;
}

export async function executeStepWithRetry(
  step: Step,
  stepIndex: number,
  contextHistory: StepResult[],
  retryConfig: { retries: number; delay?: number; backoff?: number },
  timeoutMs: number,
  context: ExecutionContext,
  progress?: any
): Promise<StepResult> {
  const attemptsTotal = retryConfig.retries || 1;
  const useDelay = retryConfig.delay;
  const useBackoff = retryConfig.backoff;

  let lastError: any;
  let result: StepResult | undefined;

  for (let attempt = 1; attempt <= attemptsTotal; attempt++) {
    try {
      const r = await withTimeout(
        executeStep(step, stepIndex, contextHistory, context, progress),
        timeoutMs,
        'Step'
      );
      result = r;
      break;
    } catch (e) {
      // ... (copy retry logic)
      lastError = e;

      if (attempt >= attemptsTotal) break;

      if (typeof useBackoff === 'number' && useBackoff > 0) {
        const baseMs = 1000;
        const waitMs = baseMs * Math.pow(useBackoff, attempt - 1);
        await sleep(waitMs);
      } else {
        const waitMs = Math.max(0, (useDelay ?? 0) * 1000);
        if (waitMs > 0) await sleep(waitMs);
      }
    }
  }

  if (!result) throw lastError;
  return result;
}
```

This is **complex** - you'll need to carefully merge the logic from both methods.

2. **Update `agent()` function to use executor**

In `src/volcano-sdk.ts`, the `run()` method becomes:

```typescript
async run(log?: (s: StepResult, stepIndex: number) => void): Promise<StepResult[]> {
  if (isRunning) {
    throw new AgentConcurrencyError('This agent is already running...');
  }
  isRunning = true;

  const progress = showProgress ? createProgressHandler(...) : null;
  const agentSpan = telemetry?.startAgentSpan(...) || null;
  const out: StepResult[] = [];

  // Inherit parent context if subagent
  if (!inheritedParentContext && (builder as any).__parentContext) {
    contextHistory = [...(builder as any).__parentContext];
    inheritedParentContext = true;
  }

  const executionContext: ExecutionContext = {
    defaultLlm,
    globalInstructions,
    contextMaxChars,
    contextMaxToolResults,
    defaultMaxToolIterations,
    telemetry,
    applyAgentAuth,
  };

  try {
    const planned = [...steps];

    for (const raw of planned) {
      if ((raw as any).__reset) {
        contextHistory = [];
        continue;
      }

      // Handle advanced patterns (parallel, branch, etc.)
      if ((raw as any).__parallel) {
        // ... (existing pattern handling)
        continue;
      }

      // Regular step - use executor
      const s = typeof raw === 'function' ? raw(out) : raw;

      const result = await executeStepWithRetry(
        s,
        out.length,
        contextHistory,
        stepRetryConfig,
        stepTimeoutMs,
        executionContext,
        progress
      );

      out.push(result);
      contextHistory.push(result);
      log?.(result, out.length - 1);
    }

    // ... (finalize metrics, end span)

    return out;
  } finally {
    isRunning = false;
  }
}
```

The `stream()` method becomes very similar, just yielding results.

3. **Test extensively**

This is a **high-risk change**. Test thoroughly:

```bash
# Run all tests multiple times
for i in {1..5}; do
  echo "Test run $i"
  ./scripts/verify-refactoring.sh || exit 1
done

# Run specific problematic test suites
npm test tests/agent.patterns.test.ts
npm test tests/agent.streaming.test.ts
npm test tests/agent.token-streaming.test.ts
```

4. **Commit**

```bash
git add src/agent/executor.ts src/volcano-sdk.ts
git commit -m "refactor: extract and deduplicate step executor

BREAKING: This is a major internal refactoring
- Create unified executeStep() and executeStepWithRetry()
- Deduplicate run() and stream() implementations
- Both methods now use shared executor
- No public API changes

Tests: All tests pass, verified 5x"
```

---

### Step 4.2: Extract Agent Builder

**Time estimate:** 2 hours

#### Actions

1. **Create `src/agent/builder.ts`**

Move the entire `agent()` function and `AgentBuilder` implementation:

```typescript
// src/agent/builder.ts
import type { AgentBuilder, AgentOptions, Step, StepResult, StreamOptions } from "./types.js";
import { executeStepWithRetry } from "./executor.js";
import { createProgressHandler } from "./progress.js";
import { executeParallel, executeBranch, /* ... */ } from "../patterns.js";
// ... all other imports

export function agent(opts?: AgentOptions): AgentBuilder {
  // ... (entire current implementation)
}
```

2. **Update `src/volcano-sdk.ts`**

```typescript
import { agent } from "./agent/builder.js";
export { agent };

// Remove old agent() function (should be MUCH smaller now!)
```

3. **Create `src/agent/index.ts`**

```typescript
// src/agent/index.ts
export * from "./types.js";
export * from "./builder.js";
export * from "./executor.js";
export * from "./context.js";
export * from "./utils.js";
export * from "./progress.js";
export * from "./streaming.js";
export * from "./crews.js";
```

4. **Test & Commit**

```bash
./scripts/verify-refactoring.sh
git add src/agent/builder.ts src/agent/index.ts src/volcano-sdk.ts
git commit -m "refactor: extract agent builder to src/agent/builder.ts

- Move agent() function to dedicated module
- Create src/agent/index.ts barrel export"
```

---

## Phase 5: Final Cleanup

### Step 5.1: Convert src/volcano-sdk.ts to src/index.ts

**Time estimate:** 30 minutes

At this point, `src/volcano-sdk.ts` should be just re-exports.

#### Actions

1. **Create `src/index.ts`**

```typescript
// src/index.ts - Main entry point for Volcano SDK

// LLM providers
export { llmOpenAI, llmOpenAIResponses } from "./llms/openai.js";
export { llmAnthropic } from "./llms/anthropic.js";
export { llmLlama } from "./llms/llama.js";
export { llmMistral } from "./llms/mistral.js";
export { llmBedrock } from "./llms/bedrock.js";
export { llmVertexStudio } from "./llms/vertex-studio.js";
export { llmAzure } from "./llms/azure.js";

// LLM types
export type { LLMHandle, ToolDefinition, LLMToolResult } from "./llms/types.js";
export type { OpenAIConfig, OpenAIOptions } from "./llms/openai.js";
export type { AnthropicConfig, AnthropicOptions } from "./llms/anthropic.js";
export type { LlamaConfig, LlamaOptions } from "./llms/llama.js";
export type { MistralConfig, MistralOptions } from "./llms/mistral.js";
export type { BedrockConfig, BedrockOptions } from "./llms/bedrock.js";
export type { VertexStudioConfig, VertexStudioOptions } from "./llms/vertex-studio.js";
export type { AzureConfig, AzureOptions } from "./llms/azure.js";

// Errors
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
} from "./errors.js";
export type { VolcanoErrorMeta } from "./errors.js";

// Validation
export { __internal_validateToolArgs } from "./validation.js";

// MCP
export {
  mcp,
  discoverTools,
  __internal_clearDiscoveryCache,
  __internal_setDiscoveryTtl,
  __internal_primeDiscoveryCache,
  __internal_getMcpPoolStats,
  __internal_setPoolConfig,
  __internal_clearOAuthTokenCache,
  __internal_getOAuthTokenCache,
} from "./mcp/index.js";
export type { MCPHandle, MCPAuthConfig } from "./mcp/types.js";

// Agent
export { agent } from "./agent/index.js";
export type {
  AgentBuilder,
  Step,
  StepResult,
  RetryConfig,
  TokenMetadata,
  StreamOptions,
} from "./agent/types.js";

// Telemetry
export { createVolcanoTelemetry, noopTelemetry } from "./telemetry.js";
export type { VolcanoTelemetryConfig, VolcanoTelemetry } from "./telemetry.js";

// Patterns (keep as-is)
export {
  executeParallel,
  executeBranch,
  executeSwitch,
  executeWhile,
  executeForEach,
  executeRetryUntil,
  executeRunAgent
} from "./patterns.js";
```

2. **Update `package.json`**

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts"
}
```

3. **Delete `src/volcano-sdk.ts`**

```bash
git rm src/volcano-sdk.ts
```

4. **Test**

```bash
./scripts/verify-refactoring.sh

# Test that imports still work
npm run build
node -e "import('./dist/index.js').then(sdk => console.log(Object.keys(sdk)))"
```

5. **Commit**

```bash
git add src/index.ts package.json
git commit -m "refactor: rename volcano-sdk.ts to index.ts

- Update package.json entry point
- Delete old volcano-sdk.ts
- All exports now from modular structure"
```

---

### Step 5.2: Update Internal Test Imports

**Time estimate:** 30 minutes

Existing tests import from `dist/volcano-sdk.js` - update to `dist/index.js`.

```bash
# Find and replace in all test files
find tests -name "*.test.ts" -type f -exec sed -i 's/volcano-sdk\.js/index.js/g' {} +

git add tests/
git commit -m "test: update imports to use dist/index.js"
```

---

### Step 5.3: Final Verification

```bash
# Clean build
npm run clean
npm run build

# Run ALL tests
npm test

# Run module tests specifically
npm test tests/modules

# Check bundle size (should be similar or smaller)
ls -lh dist/

# Verify exports
node -e "import('./dist/index.js').then(sdk => {
  console.log('Exports:', Object.keys(sdk).length);
  console.log('Has agent:', typeof sdk.agent);
  console.log('Has mcp:', typeof sdk.mcp);
})"
```

---

## Post-Refactoring Tasks

### 1. Update Documentation

- Update `CLAUDE.md` with new structure
- Update `README.md` if needed
- Add migration guide for contributors

### 2. Create Pull Request

```bash
# Push refactoring branch
git push origin refactor/modularize-sdk

# Create PR with detailed description
gh pr create \
  --title "Refactor: Modularize SDK architecture" \
  --body "$(cat <<EOF
## Summary
Splits volcano-sdk.ts (2,435 lines) into focused modules for better maintainability.

## Changes
- ✅ Extract errors to src/errors.ts
- ✅ Extract validation to src/validation.ts
- ✅ Extract MCP modules to src/mcp/
- ✅ Extract agent modules to src/agent/
- ✅ Deduplicate run() and stream() executors
- ✅ Rename to src/index.ts

## Testing
- All existing tests pass
- New module tests added (tests/modules/)
- Verified 100% backwards compatibility

## Metrics
- Files: 1 → 20+ modules
- Largest file: 2,435 lines → ~400 lines
- Test coverage: +2,500 lines of module tests

See REFACTORING_PLAN.md for details.
EOF
)"
```

### 3. Monitor CI

Ensure all CI checks pass:
- ✅ Tests
- ✅ Build
- ✅ Linting
- ✅ Type checking

### 4. Metrics Comparison

Before:
```
src/volcano-sdk.ts: 2,435 lines
Total files: 13
```

After:
```
src/index.ts: ~150 lines (re-exports only)
src/errors.ts: ~100 lines
src/validation.ts: ~50 lines
src/mcp/: ~600 lines (4 files)
src/agent/: ~1,200 lines (7 files)
Total files: ~25
```

---

## Risk Mitigation

### Rollback Strategy

At any point, if tests fail and you can't fix quickly:

```bash
# Stash changes
git stash

# Or reset to last good commit
git reset --hard HEAD~1

# Or abandon branch
git checkout main
```

### Incremental Merge Strategy

Don't merge everything at once:

1. Merge Phase 1 (errors, validation, utils) first
2. Test in production
3. Merge Phase 2 (MCP modules)
4. Test in production
5. Merge Phases 3-4 (agent modules)

### Testing Checklist

After each phase:
- [ ] `npm run build` succeeds
- [ ] `npm test` all pass
- [ ] `npm test tests/modules` all pass
- [ ] No TypeScript errors
- [ ] No ESLint errors
- [ ] Examples still work: `npx tsx examples/hello-world.ts`

---

## Timeline Estimate

**Total: 12-16 hours** (spread over 2-3 days)

- Phase 1 (Foundation): 1.5 hours
- Phase 2 (MCP): 3 hours
- Phase 3 (Agent Components): 2.5 hours
- Phase 4 (Executor): 4-5 hours
- Phase 5 (Cleanup): 1.5 hours

---

## Success Criteria

✅ All existing tests pass
✅ All module tests pass
✅ No breaking changes to public API
✅ Bundle size similar or smaller
✅ TypeScript compilation succeeds
✅ Examples work unchanged
✅ CI/CD passes
✅ Code is more maintainable

---

## Questions During Refactoring?

- **Tests failing?** Check if you missed updating an import
- **TypeScript errors?** Verify export/import paths
- **Circular dependencies?** May need to adjust module structure
- **Performance regression?** Check if added extra overhead

Refer back to `arch.md` for architectural rationale.
