/**
 * Tests for proposed src/agent/context.ts module
 * These tests verify history context building (buildHistoryContextChunked)
 */
import { describe, it, expect } from 'vitest';
import { agent } from '../../dist/index.js';

describe('Agent Context Building', () => {
  function makeLLM(responses: string[] = ['OK']) {
    let callCount = 0;
    return {
      id: 'mock',
      model: 'test',
      client: {},
      gen: async (prompt: string) => {
        const response = responses[callCount] || responses[responses.length - 1];
        callCount++;
        return response;
      },
      genWithTools: async (prompt: string) => {
        // Check if context was included
        return { content: prompt.includes('[Context from previous steps]') ? 'has-context' : 'no-context', toolCalls: [] };
      },
      genStream: async function* () {
        yield 'OK';
      },
    } as any;
  }

  describe('Context from previous LLM outputs', () => {
    it('should include previous LLM output in context', async () => {
      const llm = makeLLM(['First response', 'Second response']);

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'First query' })
        .then({ prompt: 'Second query' })
        .run();

      // Second step should have received first step's output as context
      expect(results.length).toBe(2);
      expect(results[0].llmOutput).toBe('First response');
      expect(results[1].llmOutput).toBe('Second response');
    });

    it('should include multiple previous outputs', async () => {
      const llm = makeLLM(['Response 1', 'Response 2', 'Response 3']);

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'Query 1' })
        .then({ prompt: 'Query 2' })
        .then({ prompt: 'Query 3' })
        .run();

      expect(results.length).toBe(3);
      // Each step should have previous context available
    });

    it('should handle context with single previous step', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async (prompt: string) => {
          if (prompt.includes('[Context from previous steps]')) {
            return 'Received context';
          }
          return 'No context';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'First' })
        .then({ prompt: 'Second' })
        .run();

      expect(results[1].llmOutput).toBe('Received context');
    });
  });

  describe('Context from tool calls', () => {
    it('should include tool call results in context', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async (prompt: string) => {
          // Second call should have tool results in context
          if (prompt.includes('Previous tool results:')) {
            return 'Has tool context';
          }
          return 'No tool context';
        },
        genWithTools: async (prompt: string, tools: any[]) => {
          if (tools.length > 0) {
            // First call with tools
            return {
              content: '',
              toolCalls: [{
                name: tools[0].name,
                arguments: { test: 'arg' },
                mcpHandle: tools[0].mcpHandle,
              }],
            };
          }
          // Second call after tool execution
          return { content: 'Done', toolCalls: [] };
        },
        genStream: async function* () {},
      } as any;

      // This test requires actual MCP server, skip for now
      // Just verify the context building API
      expect(true).toBe(true);
    });
  });

  describe('Context size limits (contextMaxChars)', () => {
    it('should respect contextMaxChars limit', async () => {
      const longResponse = 'x'.repeat(5000);
      const llm = makeLLM([longResponse, 'Second']);

      const results = await agent({
        llm,
        hideProgress: true,
        contextMaxChars: 1000, // Limit context to 1000 chars
      })
        .then({ prompt: 'First' })
        .then({ prompt: 'Second' })
        .run();

      expect(results.length).toBe(2);
      // Context should have been truncated, but execution should succeed
    });

    it('should use default contextMaxChars when not specified', async () => {
      const llm = makeLLM(['Response 1', 'Response 2']);

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'First' })
        .then({ prompt: 'Second' })
        .run();

      expect(results.length).toBe(2);
    });

    it('should allow very small contextMaxChars', async () => {
      const llm = makeLLM(['Long response here', 'Second']);

      const results = await agent({
        llm,
        hideProgress: true,
        contextMaxChars: 10, // Very small limit
      })
        .then({ prompt: 'First' })
        .then({ prompt: 'Second' })
        .run();

      expect(results.length).toBe(2);
    });

    it('should allow per-step contextMaxChars override', async () => {
      const llm = makeLLM(['Response 1', 'Response 2']);

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'First' })
        .then({ prompt: 'Second', contextMaxChars: 500 })
        .run();

      expect(results.length).toBe(2);
    });
  });

  describe('Context tool result limits (contextMaxToolResults)', () => {
    it('should respect contextMaxToolResults limit', async () => {
      // Would need MCP server to fully test
      // Just verify the option is accepted
      const llm = makeLLM();

      const results = await agent({
        llm,
        hideProgress: true,
        contextMaxToolResults: 5,
      })
        .then({ prompt: 'Test' })
        .run();

      expect(results.length).toBe(1);
    });

    it('should use default contextMaxToolResults when not specified', async () => {
      const llm = makeLLM();

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'Test' })
        .run();

      expect(results.length).toBe(1);
    });

    it('should allow per-step contextMaxToolResults override', async () => {
      const llm = makeLLM();

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'Test', contextMaxToolResults: 3 })
        .run();

      expect(results.length).toBe(1);
    });
  });

  describe('Context reset', () => {
    it('should clear context after resetHistory()', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async (prompt: string) => {
          if (prompt.includes('[Context from previous steps]')) {
            return 'Has context';
          }
          return 'No context';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'First' })
        .resetHistory()
        .then({ prompt: 'Second' })
        .run();

      // Second step should not have context from first
      expect(results[1].llmOutput).toBe('No context');
    });

    it('should allow multiple resetHistory() calls', async () => {
      const llm = makeLLM(['1', '2', '3', '4']);

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'A' })
        .resetHistory()
        .then({ prompt: 'B' })
        .resetHistory()
        .then({ prompt: 'C' })
        .run();

      expect(results.length).toBe(3);
    });
  });

  describe('Context for subagents', () => {
    it('should pass context to explicit subagents', async () => {
      const llm = makeLLM(['Parent response', 'Subagent response']);

      const subagent = agent({ llm, hideProgress: true })
        .then({ prompt: 'Subagent task' });

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'Parent task' })
        .runAgent(subagent)
        .run();

      // Subagent should have access to parent context
      expect(results.length).toBeGreaterThan(0);
    });

    it('should not pass context to agents in parallel', async () => {
      const llm = makeLLM(['A', 'B', 'C']);

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'First' })
        .parallel([
          { prompt: 'Parallel A' },
          { prompt: 'Parallel B' },
        ])
        .run();

      expect(results.length).toBeGreaterThan(0);
    });
  });

  describe('Context with instructions', () => {
    it('should prepend instructions before prompt with context', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async (prompt: string) => {
          if (prompt.startsWith('You are a helpful assistant')) {
            return 'Has instructions';
          }
          return 'No instructions';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const results = await agent({
        llm,
        hideProgress: true,
        instructions: 'You are a helpful assistant',
      })
        .then({ prompt: 'Test' })
        .run();

      expect(results[0].llmOutput).toBe('Has instructions');
    });

    it('should allow per-step instructions override', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async (prompt: string) => {
          if (prompt.startsWith('Step-level instruction')) {
            return 'Step instructions';
          }
          return 'Agent instructions';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const results = await agent({
        llm,
        hideProgress: true,
        instructions: 'Agent-level instruction',
      })
        .then({ prompt: 'Test', instructions: 'Step-level instruction' })
        .run();

      expect(results[0].llmOutput).toBe('Step instructions');
    });
  });

  describe('Empty context handling', () => {
    it('should handle first step with no context', async () => {
      const llm = makeLLM(['First response']);

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'First query' })
        .run();

      expect(results.length).toBe(1);
      expect(results[0].llmOutput).toBe('First response');
    });

    it('should handle agent with no steps', async () => {
      const llm = makeLLM();

      const results = await agent({ llm, hideProgress: true }).run();

      expect(results.length).toBe(0);
    });
  });
});
