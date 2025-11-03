# Volcano SDK Architecture Analysis & Refactoring Proposal

## Current State

### Repository Layout

```
volcano-sdk/
├── src/
│   ├── volcano-sdk.ts       (2,435 lines - MONOLITHIC)
│   ├── patterns.ts          (153 lines)
│   ├── telemetry.ts         (470 lines)
│   └── llms/                (well-organized, 8 provider files)
│       ├── types.ts
│       ├── openai.ts
│       ├── anthropic.ts
│       ├── mistral.ts
│       ├── llama.ts
│       ├── bedrock.ts
│       ├── vertex-studio.ts
│       ├── azure.ts
│       └── utils.ts
├── tests/                   (47 test files, well-organized)
├── examples/                (19 example scripts)
├── mcp/                     (test MCP servers)
└── web/                     (documentation site)
```

### Problem: volcano-sdk.ts is Too Large

**File Statistics:**
- **2,435 lines** (113 KB)
- **49% of total source code** in a single file
- Contains **10+ distinct logical modules**
- Violates Single Responsibility Principle

### What's Inside volcano-sdk.ts?

The file contains these distinct modules (in order):

1. **Re-exports** (lines 1-28) - LLM providers, telemetry, types
2. **Error Classes** (lines 30-86) - 6 error classes + helpers
3. **MCP Client Infrastructure** (lines 87-521)
   - Auth types and OAuth token management
   - Connection pooling with LRU eviction
   - Tool discovery and caching
   - JSON schema validation
4. **Agent Types** (lines 522-631)
   - RetryConfig, TokenMetadata, StreamOptions
   - Step, StepResult, AgentBuilder interface
5. **Context Building** (lines 632-704) - History aggregation
6. **LLM Streaming Helper** (lines 710-745)
7. **Progress Rendering** (lines 750-894) - TTY output, spinners, formatting
8. **Multi-Agent Coordination** (lines 896-944) - Crew logic
9. **Main Agent Function** (lines 987-2435)
   - AgentBuilder implementation
   - Step execution engine (most complex)
   - Retry logic
   - Tool calling loop
   - Both run() and stream() implementations (duplicated logic)

## Architectural Issues

### 1. **Mixing of Concerns**

The file violates separation of concerns by mixing:
- **Infrastructure** (MCP pooling, OAuth) with **Business Logic** (agent execution)
- **UI/Presentation** (progress rendering) with **Core Logic** (step execution)
- **Protocol** (MCP client) with **Framework** (agent builder)

### 2. **Code Duplication**

The `run()` method (lines 1060-1732) and `stream()` method (lines 1733-2377) contain **90% duplicated code**:
- Pattern handling (parallel, branch, switch, while, forEach, retryUntil, runAgent) is copy-pasted
- Step execution logic is nearly identical
- Only difference: stream() yields results, run() collects them

**Impact:** Bug fixes must be applied twice, increasing maintenance burden.

### 3. **Tight Coupling**

- Progress rendering is tightly coupled to execution logic
- MCP client code depends on telemetry (optional dependency)
- Agent execution directly calls progress handlers
- Hard to test components in isolation

### 4. **Discoverability & Navigation**

- Finding specific functionality requires searching through 2,435 lines
- Related code is scattered (e.g., OAuth token cache at line 180, usage at line 270)
- No clear entry points for different concerns

### 5. **Testing Challenges**

- Cannot unit test MCP pooling without loading entire SDK
- Cannot test context building without agent machinery
- Progress rendering is hard to test (console output side effects)

## Proposed Architecture

### Recommended Module Structure

Split `volcano-sdk.ts` into focused modules:

```
src/
├── index.ts                 # Public API exports (barrel file)
├── errors.ts                # Error classes and normalization
├── validation.ts            # JSON schema validation (Ajv)
├── mcp/
│   ├── index.ts            # MCP exports
│   ├── types.ts            # MCPHandle, MCPAuthConfig
│   ├── client.ts           # Connection pooling, withMCP()
│   ├── auth.ts             # OAuth token management
│   ├── discovery.ts        # Tool discovery & caching
│   └── utils.ts            # Tool name formatting, etc.
├── agent/
│   ├── index.ts            # Agent exports
│   ├── types.ts            # Step, StepResult, AgentBuilder, etc.
│   ├── builder.ts          # AgentBuilder implementation
│   ├── executor.ts         # Core step execution engine
│   ├── context.ts          # History building (buildHistoryContextChunked)
│   ├── progress.ts         # TTY progress rendering
│   ├── crews.ts            # Multi-agent coordination
│   ├── streaming.ts        # Streaming execution logic
│   └── utils.ts            # Helper functions (sleep, withTimeout, etc.)
├── llms/                    # (keep as-is, well-organized)
├── patterns.ts              # (keep as-is)
└── telemetry.ts             # (keep as-is)
```

### Module Responsibilities

#### **src/errors.ts** (~100 lines)
```typescript
export class VolcanoError extends Error { ... }
export class LLMError extends VolcanoError { ... }
export class MCPError extends VolcanoError { ... }
// ... other error classes

export function normalizeError(...): VolcanoError { ... }
export function isRetryableStatus(status?: number): boolean { ... }
export function classifyProvider(...): string | undefined { ... }
```

**Benefits:**
- Centralized error handling
- Easy to add new error types
- Testable in isolation

#### **src/validation.ts** (~50 lines)
```typescript
import Ajv from "ajv";

const ajv = new Ajv({ allErrors: true, strict: false });
const VALIDATOR_CACHE = new WeakMap<object, any>();

export function validateToolArgs(schema: any, args: any, context: string): void {
  // Schema validation logic
}
```

**Benefits:**
- Single responsibility
- Can swap validation libraries easily
- Cache management is isolated

#### **src/mcp/client.ts** (~200 lines)
```typescript
// Connection pool management
const MCP_POOL = new Map<string, MCPPoolEntry>();

export async function getPooledClient(url: string, auth?: MCPAuthConfig): Promise<MCPPoolEntry> { ... }
export async function withMCP<T>(handle: MCPHandle, fn: (c: MCPClient) => Promise<T>): Promise<T> { ... }
export function getMcpPoolStats() { ... }
export function setPoolConfig(max: number, idleMs: number) { ... }
```

**Benefits:**
- Focused on connection management
- Easier to test pooling logic
- Clear lifecycle management

#### **src/mcp/auth.ts** (~150 lines)
```typescript
const OAUTH_TOKEN_CACHE = new Map<string, TokenCacheEntry>();

export async function getOAuthToken(auth: MCPAuthConfig, endpoint: string): Promise<string> { ... }
export async function executeWithAuth<T>(auth: MCPAuthConfig, endpoint: string, fn: () => Promise<T>): Promise<T> { ... }
export function clearOAuthTokenCache() { ... }
```

**Benefits:**
- Auth concerns separated from pooling
- Token caching is explicit
- Easier to add new auth methods

#### **src/mcp/discovery.ts** (~100 lines)
```typescript
const TOOL_CACHE = new Map<string, { tools: ToolDefinition[]; ts: number }>();

export async function discoverTools(handles: MCPHandle[]): Promise<ToolDefinition[]> { ... }
export async function getToolSchema(handle: MCPHandle, toolName: string): Promise<any | undefined> { ... }
export function clearDiscoveryCache() { ... }
export function setDiscoveryTtl(ms: number) { ... }
```

**Benefits:**
- Tool discovery logic is self-contained
- Cache management is explicit
- Easy to add cache invalidation strategies

#### **src/agent/types.ts** (~150 lines)
```typescript
export type Step = { prompt: string; ... } | { mcp: MCPHandle; tool: string; ... } | ...;
export type StepResult = { prompt?: string; llmOutput?: string; ... };
export type RetryConfig = { delay?: number; backoff?: number; retries?: number };
export type TokenMetadata = { stepIndex: number; handledByStep: boolean; ... };
export type StreamOptions = { onToken?: ...; onStep?: ... };
export type AgentOptions = { llm?: LLMHandle; instructions?: string; ... };

export interface AgentBuilder {
  then(s: Step): AgentBuilder;
  parallel(...): AgentBuilder;
  run(): Promise<StepResult[]>;
  stream(): AsyncGenerator<StepResult>;
  // ... all builder methods
}
```

**Benefits:**
- All types in one place
- Easy to extend
- Better IDE autocomplete

#### **src/agent/context.ts** (~100 lines)
```typescript
export function buildHistoryContextChunked(
  history: StepResult[],
  maxToolResults: number,
  maxChars: number
): string {
  // Context aggregation logic
}
```

**Benefits:**
- Testable with various history inputs
- Easy to modify context format
- No dependencies on execution engine

#### **src/agent/progress.ts** (~150 lines)
```typescript
export type ProgressHandler = {
  stepStart: (stepIndex: number, prompt?: string) => void;
  stepComplete: (durationMs: number, tokenCount?: number) => void;
  workflowEnd: (stepCount: number, totalTokens?: number) => void;
  // ...
};

export function createProgressHandler(
  totalSteps: number,
  isSubAgent: boolean,
  ...
): ProgressHandler | null {
  // TTY rendering logic
}
```

**Benefits:**
- UI concerns separated from logic
- Can swap progress implementations (JSON logs, quiet mode, etc.)
- Testable without console output
- Easy to add custom renderers

#### **src/agent/executor.ts** (~400 lines)
```typescript
export async function executeStep(
  step: Step,
  context: ExecutionContext
): Promise<StepResult> {
  // Core step execution logic
  // - LLM calls
  // - Tool calls
  // - Retry handling
  // - Timeout handling
}

export async function executeStepWithRetry(
  step: Step,
  retryConfig: RetryConfig,
  context: ExecutionContext
): Promise<StepResult> {
  // Retry loop wrapper
}
```

**Benefits:**
- Core logic is isolated
- Easier to test edge cases
- No duplication between run() and stream()
- Progress is injected, not hardcoded

#### **src/agent/builder.ts** (~300 lines)
```typescript
export function agent(opts?: AgentOptions): AgentBuilder {
  // Returns AgentBuilder implementation
  // Delegates execution to executor.ts
}
```

**Benefits:**
- Builder pattern is clear
- Execution logic is delegated
- Easier to add new builder methods

#### **src/agent/crews.ts** (~100 lines)
```typescript
export function buildAgentContext(agents: AgentBuilder[]): string { ... }
export function parseAgentDecision(response: string): { type: 'use_agent' | 'done'; ... } { ... }
```

**Benefits:**
- Multi-agent coordination is self-contained
- Easier to extend crew protocols
- Testable with mock agents

#### **src/agent/streaming.ts** (~200 lines)
```typescript
export async function executeLLMWithStreaming(
  llm: LLMHandle,
  prompt: string,
  stepOnToken?: (token: string) => void,
  streamOnToken?: (token: string, meta: TokenMetadata) => void,
  meta: { stepIndex: number; stepPrompt?: string }
): Promise<string> {
  // Token streaming logic
}
```

**Benefits:**
- Streaming concerns are isolated
- No duplication with non-streaming paths
- Easier to test callback precedence

#### **src/agent/utils.ts** (~50 lines)
```typescript
export function sleep(ms: number): Promise<void> { ... }
export function withTimeout<T>(promise: Promise<T>, ms: number, label?: string): Promise<T> { ... }
```

**Benefits:**
- Shared utilities are discoverable
- Testable
- Reusable

### Migration Strategy

**Phase 1: Extract Stable Modules (Low Risk)**
1. Create `src/errors.ts` - extract error classes
2. Create `src/validation.ts` - extract schema validation
3. Create `src/agent/utils.ts` - extract sleep, withTimeout
4. Update imports in `volcano-sdk.ts`

**Phase 2: Extract MCP Infrastructure (Medium Risk)**
5. Create `src/mcp/types.ts` - extract MCPHandle, MCPAuthConfig
6. Create `src/mcp/auth.ts` - extract OAuth logic
7. Create `src/mcp/client.ts` - extract pooling logic
8. Create `src/mcp/discovery.ts` - extract tool discovery
9. Create `src/mcp/index.ts` - barrel exports
10. Update imports in `volcano-sdk.ts`

**Phase 3: Extract Agent Components (High Risk)**
11. Create `src/agent/types.ts` - extract all agent types
12. Create `src/agent/context.ts` - extract context building
13. Create `src/agent/progress.ts` - extract progress rendering
14. Create `src/agent/crews.ts` - extract multi-agent logic
15. Create `src/agent/streaming.ts` - extract streaming helpers

**Phase 4: Refactor Executor (Highest Risk)**
16. Create `src/agent/executor.ts` - extract step execution
17. Deduplicate run() and stream() by using executor
18. Create `src/agent/builder.ts` - extract AgentBuilder
19. Create `src/agent/index.ts` - barrel exports

**Phase 5: Update Entry Point**
20. Update `src/volcano-sdk.ts` to re-export from modules (or rename to `src/index.ts`)
21. Update package.json if entry point changes
22. Run full test suite

**Testing Strategy:**
- Add tests for each new module before extraction
- Ensure 100% backward compatibility
- Run full test suite after each phase
- Use git branches for each phase

## Benefits of Refactoring

### Maintainability
- **Smaller files** are easier to understand and modify
- **Single responsibility** per module reduces cognitive load
- **Clear boundaries** make it obvious where to add new features

### Testability
- **Unit tests** for individual components (auth, pooling, context, etc.)
- **Mock dependencies** easily (inject progress handler, telemetry, etc.)
- **Isolated testing** without loading entire SDK

### Extensibility
- **New LLM providers** already well-isolated (good!)
- **New auth methods** would go in `mcp/auth.ts`
- **New progress renderers** would implement `ProgressHandler` interface
- **New execution patterns** would extend `executor.ts`

### Developer Experience
- **Faster navigation** - jump to specific module
- **Better IDE support** - smaller files load faster
- **Clearer documentation** - each module has focused docs
- **Easier onboarding** - new contributors can understand one module at a time

### Performance
- **Tree-shaking** works better with smaller modules
- **Faster compilation** - TypeScript can parallelize
- **Better caching** - changes to one module don't invalidate others

## Alternative: Keep Current Structure?

**Arguments against refactoring:**
1. **Works today** - current architecture is functional
2. **Risk of bugs** - refactoring might introduce regressions
3. **Time investment** - requires careful extraction and testing
4. **Breaking changes** - might affect internal APIs (though public API stays same)

**Counterarguments:**
1. **Technical debt grows** - will be harder to refactor later
2. **New features are harder** - adding to 2,435-line file is painful
3. **Code duplication exists** - run() and stream() should share logic
4. **Testing is limited** - can't unit test components in isolation

## Recommendation

**YES, split the SDK file.** The benefits outweigh the risks:

1. **Start with low-risk extractions** (errors, validation, utils)
2. **Extract MCP infrastructure next** (well-defined boundaries)
3. **Refactor agent execution carefully** (deduplicate run/stream)
4. **Maintain 100% backward compatibility** at public API level
5. **Add tests for each module** before extraction

The codebase is at a **tipping point**:
- Still manageable now (2,435 lines)
- Will become unwieldy at 3,000+ lines
- Better to refactor before adding more features

## Questions for Consideration

1. **Should `src/volcano-sdk.ts` become `src/index.ts`?**
   - Pros: More conventional, clearer entry point
   - Cons: Breaking change for direct imports (though package.json exports are unaffected)

2. **Should progress rendering be pluggable?**
   - Current: Hardcoded TTY output
   - Alternative: `ProgressHandler` interface, allow custom implementations
   - Use cases: JSON logs, quiet mode, custom UIs

3. **Should MCP client be its own package?**
   - Pros: Reusable by other projects, clear boundaries
   - Cons: More complex build/release, might be overkill

4. **How to handle internal exports?**
   - Keep `__internal_*` functions for tests
   - Or: Create `src/internal.ts` for test-only exports

5. **Should executor use dependency injection?**
   - Current: Hardcoded dependencies (telemetry, progress)
   - Alternative: Inject as parameters
   - Benefit: Better testability

## Metrics to Track

If refactoring proceeds, track these metrics:

- **Lines per file** (target: <400 lines)
- **Cyclomatic complexity** (target: <10 per function)
- **Test coverage** (maintain or improve current levels)
- **Bundle size** (should stay same or shrink)
- **Type check time** (should improve)
- **Test execution time** (should improve)

## Conclusion

The Volcano SDK is well-architected overall:
- ✅ LLM providers are cleanly separated
- ✅ Patterns are extracted
- ✅ Telemetry is modular
- ✅ Tests are comprehensive

But the main SDK file is a **monolith** that should be split:
- ❌ Too many responsibilities in one file
- ❌ Code duplication (run/stream)
- ❌ Hard to test components in isolation
- ❌ Progress rendering mixed with execution

**Proposed refactoring is feasible and valuable.** Start with low-risk extractions, maintain backward compatibility, and add tests at each step.
