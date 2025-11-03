# Module Refactoring Tests

This directory contains comprehensive tests for the proposed architectural refactoring outlined in `arch.md`.

## Purpose

These tests verify the current behavior of `volcano-sdk.ts` components **before** they are split into separate modules. They serve as:

1. **Regression tests** - Ensure backwards compatibility after refactoring
2. **Specification** - Document current behavior of each module
3. **Safety net** - Catch breaking changes during extraction

## Test Coverage

### Error Handling (`errors.test.ts`)
- All error classes and hierarchy
- Error normalization and classification
- Provider classification (LLM vs MCP)
- Retryable vs non-retryable error detection
- Error metadata (stepId, provider, requestId)

**Covers proposed:** `src/errors.ts`

### Validation (`validation.test.ts`)
- JSON schema validation with Ajv
- Schema validation for explicit tool calls
- Schema validation for automatic tool calls
- Validator caching
- Error messages and context
- Required properties, type checking, nested objects, arrays

**Covers proposed:** `src/validation.ts`

### MCP Client (`mcp-client.test.ts`)
- MCP handle creation with deterministic IDs
- Connection pooling and reuse
- Pool size limits and LRU eviction
- Concurrent connections
- Error handling for failed connections
- Pool statistics API

**Covers proposed:** `src/mcp/client.ts`

### MCP Authentication (`mcp-auth.test.ts`)
- Bearer token authentication
- OAuth 2.0 client credentials flow
- OAuth token caching with expiration
- OAuth scope handling
- Agent-level vs handle-level auth precedence
- Auth header injection

**Covers proposed:** `src/mcp/auth.ts`

### MCP Discovery (`mcp-discovery.test.ts`)
- Tool discovery from MCP servers
- Tool name prefixing (handle ID + tool name)
- Discovery caching with TTL
- Manual cache priming
- Tool schema handling
- Multiple MCP server coordination
- OpenAI 64-char tool name limit compliance

**Covers proposed:** `src/mcp/discovery.ts`

### Agent Context (`agent-context.test.ts`)
- History context building from previous LLM outputs
- Tool call results in context
- Context size limits (`contextMaxChars`, `contextMaxToolResults`)
- Context reset with `resetHistory()`
- Subagent context inheritance
- Instructions prepending

**Covers proposed:** `src/agent/context.ts`

### Agent Utils (`agent-utils.test.ts`)
- Timeout handling (`withTimeout`)
- Sleep/delay for retries
- Exponential backoff
- Retry configuration
- Timing accuracy (duration measurement)
- Timeout error metadata

**Covers proposed:** `src/agent/utils.ts`

### Agent Progress (`agent-progress.test.ts`)
- Progress display control (`hideProgress`)
- Workflow header and footer
- Step progress with numbering
- Subagent progress suppression
- Token streaming progress
- Duration display
- Error display
- TTY vs non-TTY handling

**Covers proposed:** `src/agent/progress.ts`

## Running Tests

### Run all module tests
```bash
npm test tests/modules
```

### Run specific module tests
```bash
npm test tests/modules/errors.test.ts
npm test tests/modules/validation.test.ts
npm test tests/modules/mcp-client.test.ts
npm test tests/modules/mcp-auth.test.ts
npm test tests/modules/mcp-discovery.test.ts
npm test tests/modules/agent-context.test.ts
npm test tests/modules/agent-utils.test.ts
npm test tests/modules/agent-progress.test.ts
```

### Run with watch mode
```bash
npm run test:watch tests/modules
```

## Test Status

**All tests should PASS** against the current codebase (`dist/volcano-sdk.js`).

After refactoring:
1. ✅ Tests continue to pass → Backwards compatibility maintained
2. ❌ Tests fail → Breaking change detected, fix before proceeding

## Integration with Refactoring

### Phase 1: Extract Stable Modules
Run after creating `src/errors.ts`, `src/validation.ts`, `src/agent/utils.ts`:
```bash
npm run build
npm test tests/modules/errors.test.ts
npm test tests/modules/validation.test.ts
npm test tests/modules/agent-utils.test.ts
```

### Phase 2: Extract MCP Infrastructure
Run after creating `src/mcp/*.ts`:
```bash
npm run build
npm test tests/modules/mcp-client.test.ts
npm test tests/modules/mcp-auth.test.ts
npm test tests/modules/mcp-discovery.test.ts
```

### Phase 3: Extract Agent Components
Run after creating `src/agent/*.ts`:
```bash
npm run build
npm test tests/modules/agent-context.test.ts
npm test tests/modules/agent-progress.test.ts
```

### Final Validation
After all refactoring is complete:
```bash
npm run build
npm test  # All tests, including these module tests
```

## Test Patterns

All tests follow these conventions:

1. **Import from dist** - Test compiled output, not source
2. **Mock LLMs** - Use simple mock objects, avoid real API calls
3. **Hide progress** - Use `hideProgress: true` to suppress console output
4. **Test isolation** - Each test is independent, no shared state
5. **Clear assertions** - Test one behavior per test case
6. **Descriptive names** - Test names explain what is being verified

## Notes

- Some tests require MCP servers (spawned during tests)
- OAuth tests require mock OAuth server (created with Express)
- Progress tests capture `console.log` and `process.stdout.write`
- All tests use vitest (existing test framework)

## Maintenance

When adding new features to the SDK:

1. Add tests here for the relevant module
2. Ensure tests pass before and after refactoring
3. Update this README if new modules are proposed

## Questions?

See `arch.md` for the complete architectural proposal and refactoring plan.
