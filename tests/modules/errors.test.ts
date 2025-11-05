/**
 * Tests for proposed src/errors.ts module
 * These tests verify current behavior from volcano-sdk.ts to ensure backwards compatibility
 */
import { describe, it, expect } from 'vitest';
import {
  VolcanoError,
  AgentConcurrencyError,
  TimeoutError,
  ValidationError,
  RetryExhaustedError,
  LLMError,
  MCPError,
  MCPConnectionError,
  MCPToolError,
  agent,
  mcp,
} from '../../dist/index.js';

describe('Error Classes', () => {
  describe('VolcanoError', () => {
    it('should create error with message and metadata', () => {
      const error = new VolcanoError('test error', { stepId: 5, provider: 'test-provider' });

      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(VolcanoError);
      expect(error.message).toBe('test error');
      expect(error.name).toBe('VolcanoError');
      expect(error.meta.stepId).toBe(5);
      expect(error.meta.provider).toBe('test-provider');
    });

    it('should support cause option', () => {
      const cause = new Error('original error');
      const error = new VolcanoError('wrapped error', {}, { cause });

      expect((error as any).cause).toBe(cause);
    });

    it('should have empty meta by default', () => {
      const error = new VolcanoError('test');

      expect(error.meta).toEqual({});
    });
  });

  describe('Error Class Hierarchy', () => {
    it('AgentConcurrencyError extends VolcanoError', () => {
      const error = new AgentConcurrencyError('concurrent run detected');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(AgentConcurrencyError);
      expect(error.name).toBe('AgentConcurrencyError');
    });

    it('TimeoutError extends VolcanoError', () => {
      const error = new TimeoutError('operation timed out');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.name).toBe('TimeoutError');
    });

    it('ValidationError extends VolcanoError', () => {
      const error = new ValidationError('validation failed');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(ValidationError);
      expect(error.name).toBe('ValidationError');
    });

    it('RetryExhaustedError extends VolcanoError', () => {
      const error = new RetryExhaustedError('all retries failed');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect(error.name).toBe('RetryExhaustedError');
    });

    it('LLMError extends VolcanoError', () => {
      const error = new LLMError('llm call failed');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(LLMError);
      expect(error.name).toBe('LLMError');
    });

    it('MCPError extends VolcanoError', () => {
      const error = new MCPError('mcp operation failed');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(MCPError);
      expect(error.name).toBe('MCPError');
    });

    it('MCPConnectionError extends MCPError', () => {
      const error = new MCPConnectionError('connection failed');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(MCPError);
      expect(error).toBeInstanceOf(MCPConnectionError);
      expect(error.name).toBe('MCPConnectionError');
    });

    it('MCPToolError extends MCPError', () => {
      const error = new MCPToolError('tool call failed');

      expect(error).toBeInstanceOf(VolcanoError);
      expect(error).toBeInstanceOf(MCPError);
      expect(error).toBeInstanceOf(MCPToolError);
      expect(error.name).toBe('MCPToolError');
    });
  });
});

describe('Error Normalization and Classification (via agent execution)', () => {
  function makeMockLLM(behavior: 'ok' | 'timeout' | 'llm-error' | 'retryable' | 'non-retryable') {
    return {
      id: 'mock-llm',
      model: 'test-model',
      client: {},
      gen: async (prompt: string) => {
        if (behavior === 'timeout') {
          await new Promise(r => setTimeout(r, 100));
          return 'OK';
        }
        if (behavior === 'llm-error') {
          const err: any = new Error('LLM API Error');
          err.status = 500;
          throw err;
        }
        if (behavior === 'retryable') {
          const err: any = new Error('Rate limited');
          err.status = 429;
          throw err;
        }
        if (behavior === 'non-retryable') {
          const err: any = new Error('Bad request');
          err.status = 400;
          throw err;
        }
        return 'OK';
      },
      genWithTools: async () => ({ content: 'OK', toolCalls: [] }),
      genStream: async function* () { yield 'OK'; },
    } as any;
  }

  it('TimeoutError should have retryable=true metadata', async () => {
    const llm = makeMockLLM('timeout');
    let caughtError: any;

    try {
      await agent({ llm, hideProgress: true, timeout: 0.05 })
        .then({ prompt: 'test', timeout: 0.05 })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(TimeoutError);
    expect(caughtError.meta.retryable).toBe(true);
    expect(typeof caughtError.meta.stepId).toBe('number');
  });

  it('LLMError from 5xx should have retryable=true', async () => {
    const llm = makeMockLLM('llm-error');
    let caughtError: any;

    try {
      await agent({ llm, hideProgress: true, retry: { retries: 1 } })
        .then({ prompt: 'test' })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(LLMError);
    expect(caughtError.meta.retryable).toBe(true);
    expect(caughtError.meta.provider).toMatch(/^llm:/);
  });

  it('LLMError from 429 should have retryable=true', async () => {
    const llm = makeMockLLM('retryable');
    let caughtError: any;

    try {
      await agent({ llm, hideProgress: true, retry: { retries: 1 } })
        .then({ prompt: 'test' })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(LLMError);
    expect(caughtError.meta.retryable).toBe(true);
  });

  it('LLMError from 4xx (except 429/408) should have retryable=false', async () => {
    const llm = makeMockLLM('non-retryable');
    let caughtError: any;

    try {
      await agent({ llm, hideProgress: true, retry: { retries: 3 } })
        .then({ prompt: 'test' })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(LLMError);
    expect(caughtError.meta.retryable).toBe(false);
  });

  it('AgentConcurrencyError is thrown when agent runs twice', async () => {
    const llm = makeMockLLM('ok');
    const a = agent({ llm, hideProgress: true });

    const firstRun = a.then({ prompt: 'test' }).run();
    let caughtError: any;

    try {
      await a.run();
    } catch (e) {
      caughtError = e;
    }

    await firstRun;

    expect(caughtError).toBeInstanceOf(AgentConcurrencyError);
    expect(caughtError.message).toMatch(/already running/i);
  });

  it('MCPConnectionError should have retryable=true', async () => {
    const llm = makeMockLLM('ok');
    const mcpHandle = mcp('http://localhost:9999/mcp'); // non-existent server
    let caughtError: any;

    try {
      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test', mcps: [mcpHandle] })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(MCPConnectionError);
    expect(caughtError.meta.retryable).toBe(true);
    expect(caughtError.meta.provider).toMatch(/^mcp:/);
  });

  it('MCPToolError should have retryable=false', async () => {
    const llm = makeMockLLM('ok');
    const mcpHandle = mcp('http://localhost:9998/mcp');
    let caughtError: any;

    try {
      await agent({ llm, hideProgress: true })
        .then({ mcp: mcpHandle, tool: 'nonexistent_tool', args: {} })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(MCPToolError);
    expect(caughtError.meta.retryable).toBe(false);
    expect(caughtError.meta.provider).toMatch(/^mcp:/);
  });
});

describe('Provider Classification', () => {
  it('should classify LLM provider from handle ID', async () => {
    const llm = {
      id: 'OpenAI-gpt-4',
      model: 'gpt-4',
      client: {},
      gen: async () => { throw new Error('test'); },
      genWithTools: async () => ({ content: '', toolCalls: [] }),
      genStream: async function* () {},
    } as any;

    let caughtError: any;
    try {
      await agent({ llm, hideProgress: true, retry: { retries: 1 } })
        .then({ prompt: 'test' })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError.meta.provider).toBe('llm:OpenAI-gpt-4');
  });

  it('should classify LLM provider from model if no ID', async () => {
    const llm = {
      model: 'test-model',
      client: {},
      gen: async () => { throw new Error('test'); },
      genWithTools: async () => ({ content: '', toolCalls: [] }),
      genStream: async function* () {},
    } as any;

    let caughtError: any;
    try {
      await agent({ llm, hideProgress: true, retry: { retries: 1 } })
        .then({ prompt: 'test' })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError.meta.provider).toBe('llm:test-model');
  });

  it('should classify MCP provider from URL host', async () => {
    const mcpHandle = mcp('http://example.com:3000/mcp');
    const llm = {
      id: 'mock',
      model: 'mock',
      client: {},
      gen: async () => 'OK',
      genWithTools: async () => ({ content: '', toolCalls: [] }),
      genStream: async function* () {},
    } as any;

    let caughtError: any;
    try {
      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test', mcps: [mcpHandle] })
        .run();
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError.meta.provider).toMatch(/^mcp:example\.com/);
  });
});
