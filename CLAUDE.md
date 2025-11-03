# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Volcano SDK is a TypeScript SDK for building multi-provider AI agents that combine LLM reasoning with real-world actions via MCP (Model Context Protocol) tools. The SDK supports OpenAI, Anthropic, Mistral, Llama, Bedrock, Vertex, and Azure providers with automatic tool selection, connection pooling, and advanced workflow patterns.

## Development Commands

### Building and Testing
```bash
npm run build              # Compile TypeScript to dist/
npm run clean              # Remove dist/ directory
npm test                   # Run all tests with vitest
npm run test:watch         # Run tests in watch mode
npm run pretest            # Kill zombie MCP test servers (auto-run before tests)
npm run test:kill-servers  # Manually kill zombie test servers on ports 3201-3702
```

### Linting
```bash
npm run lint          # Run ESLint
npm run lint:fix      # Auto-fix linting issues
```

### Running Examples
```bash
# Examples are in examples/ directory
npx tsx examples/hello-world.ts
npx tsx examples/mcp-auto-selection.ts
npx tsx examples/multi-agent-crew.ts
```

## Architecture

### Core Components

**src/volcano-sdk.ts** (main file, ~3000 lines)
- `agent()` - Main entry point for building agent workflows
- `AgentBuilder` - Fluent API for chaining steps (`.then()`, `.run()`, `.stream()`)
- `mcp()` - Connect to MCP servers via HTTP with connection pooling
- `discoverTools()` - Auto-discover tools from MCP servers (cached 60s)
- Error classes: `VolcanoError`, `LLMError`, `MCPError`, `TimeoutError`, `ValidationError`, etc.
- MCP connection pool (`MCP_POOL`) with LRU eviction (max 16 connections, 30s idle timeout)
- OAuth token cache for MCP authentication with automatic refresh
- JSON schema validation using Ajv for tool arguments

**src/patterns.ts**
- Advanced workflow patterns: `parallel`, `branch`, `switch`, `while`, `forEach`, `retryUntil`, `runAgent`
- All patterns support sub-agents that inherit context from parent

**src/telemetry.ts**
- OpenTelemetry integration (opt-in, peer dependency)
- Distributed tracing spans for agents, steps, LLM calls, and MCP operations
- Metrics for latency, token usage, tool calls
- Auto-configuration with `createVolcanoTelemetry()`

**src/llms/** directory
- Each provider has its own file: `openai.ts`, `anthropic.ts`, `mistral.ts`, `llama.ts`, `bedrock.ts`, `vertex-studio.ts`, `azure.ts`
- All providers implement the `LLMHandle` interface (see `types.ts`)
- `LLMHandle` provides: `gen()`, `genWithTools()`, `genStream()`, and optional `getUsage()`
- OpenAI provider exports `llmOpenAIResponses()` for structured outputs

### Key Design Patterns

**Agent Execution Flow:**
1. User chains steps with `.then({ prompt, mcps, tools, ... })`
2. Each step builds prompt with context from previous steps
3. If `mcps` provided, SDK auto-discovers tools and calls `genWithTools()`
4. LLM decides which tools to call (automatic selection)
5. SDK validates args with JSON schema, calls MCP tools, feeds results back to LLM
6. Iterates until LLM stops calling tools (max 10 iterations by default)
7. Returns final output and aggregated metrics

**Context Management:**
- `buildHistoryContextChunked()` creates context from previous steps
- Includes recent LLM outputs and tool results (configurable via `contextMaxChars` and `contextMaxToolResults`)
- Sub-agents inherit parent context via `__parentContext`

**MCP Connection Pooling:**
- Keyed by URL + auth config
- LRU eviction when pool exceeds max size (16)
- Connections marked busy during use, released after
- Automatic reconnection on failure

**Tool Discovery Cache:**
- Cached per MCP server URL for 60 seconds
- Tools prefixed with `{mcpId}.{toolName}` to avoid conflicts
- Short hash-based IDs (8 chars) to stay under OpenAI's 64-char tool name limit

**Retry Strategy:**
- Three modes: immediate (retry instantly), delayed (fixed delay), backoff (exponential)
- Retryable errors: HTTP 5xx, 429, 408, connection errors
- Non-retryable: validation errors, 4xx (except 429/408)

## Test Infrastructure

Tests use Vitest. Before each test run, `pretest` script kills zombie MCP servers on ports 3201-3702.

### Test Organization
- `tests/*.test.ts` - Unit and integration tests
- `tests/helpers/` - Test utilities
- `tests/llms/` - Provider-specific tests
- Tests spawn local MCP servers using `spawn()` and wait for "listening" output
- End-to-end tests marked with `e2e` in filename (e.g., `volcano.e2e.test.ts`)

### Running Specific Tests
```bash
npx vitest run tests/agent.patterns.test.ts      # Single test file
npx vitest run -t "should handle parallel steps"  # By test name pattern
```

### Test MCP Servers
- Located in `mcp/` directory: `astro/`, `auth-server/`, `favorites/`
- Used for testing tool calling, OAuth, and authentication flows

## Code Style

### Commit Convention
Follow Conventional Commits:
- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation
- `test:` - Tests
- `refactor:` - Refactoring
- `chore:` - Maintenance (deps, build, configs)
- `BREAKING CHANGE:` or `feat!:` - Breaking changes

Examples:
```
feat(agent): add parallel execution support
fix(mcp): resolve connection pooling issue
docs(readme): update installation instructions
```

### TypeScript Patterns
- All exports from `src/volcano-sdk.ts` are re-exported at root
- Use `export type` for type-only exports
- Prefer async/await over raw promises
- Error handling: throw normalized errors via `normalizeError()`
- Dynamic imports for optional dependencies (e.g., OpenTelemetry uses `createRequire()`)

## Important Implementation Details

### MCP Tool Name Format
Tools are named `{mcpId}.{toolName}` where `mcpId` is an 8-character hash of the URL. This keeps names under OpenAI's 64-char limit while avoiding collisions. When calling tools, SDK strips the prefix before sending to MCP server.

### Streaming Architecture
- Two types: step streaming (yields `StepResult` after each step) and token streaming (yields tokens as LLM generates)
- Token streaming supports both step-level and stream-level callbacks
- Step-level `onToken` takes precedence; stream-level receives `handledByStep` metadata to avoid double-processing

### Sub-Agent Context Inheritance
- Sub-agents created via `.runAgent()`, `.branch()`, `.switch()`, etc. receive parent context
- Marked with `__isSubAgent` and `__parentContext` flags
- Shows step progress but suppresses redundant headers/footers

### Tool Schema Validation
- Ajv validator with compiled schema cache (WeakMap) for performance
- Validates tool arguments before calling MCP servers
- Throws `ValidationError` with detailed error messages on failure

### OAuth Token Management
- Cached per token endpoint with expiration tracking
- 60-second buffer before expiration to avoid race conditions
- Follows OAuth 2.0 RFC 6749 with `application/x-www-form-urlencoded` encoding
- Global `fetch` wrapper adds auth headers during MCP connection

## Observability Integration

When OpenTelemetry peer dependency is installed:
```typescript
import { createVolcanoTelemetry } from 'volcano-sdk';

const telemetry = createVolcanoTelemetry({
  serviceName: 'my-agent',
  endpoint: 'http://localhost:4318', // OTLP endpoint
  traces: true,
  metrics: true
});

agent({ llm, telemetry })
  .then({ prompt: "..." })
  .run();
```

Spans created for:
- Agent runs (`volcano.agent`)
- Individual steps (`volcano.step`)
- LLM calls (`volcano.llm`)
- MCP operations (`volcano.mcp`)

Metrics tracked:
- Latency histograms
- Token usage counters
- Tool call counts
- Error rates

## Dependencies

### Production
- `@modelcontextprotocol/sdk` - MCP client
- `openai` - Unified client for OpenAI-compatible providers
- `ajv` - JSON schema validation

### Peer (Optional)
- `@aws-sdk/*` - For Bedrock provider
- `@azure/identity` - For Azure provider
- `@opentelemetry/api` - For observability

### Development
- `vitest` - Testing framework
- `tsx` - TypeScript executor for examples
- `eslint` + `typescript-eslint` - Linting
- OpenTelemetry SDK packages for telemetry tests
