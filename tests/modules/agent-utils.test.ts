/**
 * Tests for proposed src/agent/utils.ts module
 * These tests verify utility functions like sleep and withTimeout
 */
import { describe, it, expect } from 'vitest';
import { agent, TimeoutError } from '../../dist/index.js';

describe('Agent Utility Functions', () => {
  describe('Timeout Handling (withTimeout)', () => {
    function makeLLM(delayMs: number = 0) {
      return {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async (prompt: string) => {
          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          return 'OK';
        },
        genWithTools: async () => {
          if (delayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, delayMs));
          }
          return { content: 'OK', toolCalls: [] };
        },
        genStream: async function* () {
          yield 'OK';
        },
      } as any;
    }

    it('should complete operations within timeout', async () => {
      const llm = makeLLM(50); // 50ms delay

      const results = await agent({ llm, hideProgress: true, timeout: 1 }) // 1 second timeout
        .then({ prompt: 'test' })
        .run();

      expect(results.length).toBe(1);
      expect(results[0].llmOutput).toBe('OK');
    });

    it('should throw TimeoutError when operation exceeds timeout', async () => {
      const llm = makeLLM(200); // 200ms delay

      let error: any;
      try {
        await agent({ llm, hideProgress: true, timeout: 0.1 }) // 100ms timeout
          .then({ prompt: 'slow operation' })
          .run();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(TimeoutError);
      expect(error.message).toMatch(/timed out/i);
    });

    it('should support per-step timeout override', async () => {
      const llm = makeLLM(150);

      let error: any;
      try {
        await agent({ llm, hideProgress: true, timeout: 10 }) // 10 second agent timeout
          .then({ prompt: 'test', timeout: 0.1 }) // 100ms step timeout
          .run();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(TimeoutError);
    });

    it('should use agent-level timeout when step timeout not specified', async () => {
      const llm = makeLLM(100);

      const results = await agent({ llm, hideProgress: true, timeout: 1 })
        .then({ prompt: 'test' }) // Uses agent timeout
        .run();

      expect(results.length).toBe(1);
    });

    it('should handle zero timeout gracefully', async () => {
      const llm = makeLLM(10);

      let error: any;
      try {
        await agent({ llm, hideProgress: true, timeout: 0 })
          .then({ prompt: 'test' })
          .run();
      } catch (e) {
        error = e;
      }

      // Should timeout immediately
      expect(error).toBeInstanceOf(TimeoutError);
    });

    it('should handle very large timeout values', async () => {
      const llm = makeLLM(10);

      const results = await agent({ llm, hideProgress: true, timeout: 3600 }) // 1 hour
        .then({ prompt: 'test' })
        .run();

      expect(results.length).toBe(1);
    });
  });

  describe('Sleep/Delay Functionality', () => {
    it('should delay between retry attempts', async () => {
      let attemptCount = 0;
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          attemptCount++;
          if (attemptCount < 3) {
            const err: any = new Error('Retry me');
            err.status = 500;
            throw err;
          }
          return 'OK';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const startTime = Date.now();
      await agent({ llm, hideProgress: true, retry: { delay: 0.1, retries: 3 } })
        .then({ prompt: 'test' })
        .run();
      const elapsed = Date.now() - startTime;

      // Should have delayed ~200ms total (2 retries * 100ms)
      expect(elapsed).toBeGreaterThanOrEqual(150);
      expect(attemptCount).toBe(3);
    });

    it('should use exponential backoff when configured', async () => {
      let attemptCount = 0;
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          attemptCount++;
          if (attemptCount < 3) {
            const err: any = new Error('Retry me');
            err.status = 500;
            throw err;
          }
          return 'OK';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const startTime = Date.now();
      await agent({ llm, hideProgress: true, retry: { backoff: 2, retries: 3 } })
        .then({ prompt: 'test' })
        .run();
      const elapsed = Date.now() - startTime;

      // Backoff: 1s, 2s (total ~3s for 2 retries with factor 2)
      expect(elapsed).toBeGreaterThanOrEqual(2500);
      expect(attemptCount).toBe(3);
    });

    it('should not delay on immediate retry', async () => {
      let attemptCount = 0;
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          attemptCount++;
          if (attemptCount === 1) {
            const err: any = new Error('Retry me');
            err.status = 500;
            throw err;
          }
          return 'OK';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const startTime = Date.now();
      await agent({ llm, hideProgress: true, retry: { delay: 0, retries: 2 } })
        .then({ prompt: 'test' })
        .run();
      const elapsed = Date.now() - startTime;

      // Should be very fast (no delays)
      expect(elapsed).toBeLessThan(500);
      expect(attemptCount).toBe(2);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle parallel steps timing out independently', async () => {
      const fastLlm = {
        id: 'fast',
        model: 'fast',
        client: {},
        gen: async () => {
          await new Promise(r => setTimeout(r, 50));
          return 'Fast';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const slowLlm = {
        id: 'slow',
        model: 'slow',
        client: {},
        gen: async () => {
          await new Promise(r => setTimeout(r, 500));
          return 'Slow';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      let error: any;
      try {
        await agent({ llm: fastLlm, hideProgress: true, timeout: 0.3 })
          .parallel([
            { prompt: 'fast', llm: fastLlm },
            { prompt: 'slow', llm: slowLlm, timeout: 0.2 },
          ])
          .run();
      } catch (e) {
        error = e;
      }

      // Slow step should timeout
      expect(error).toBeDefined();
    });
  });

  describe('Timeout Error Metadata', () => {
    it('should include step ID in timeout error', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          await new Promise(r => setTimeout(r, 200));
          return 'OK';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      let error: any;
      try {
        await agent({ llm, hideProgress: true, timeout: 0.1 })
          .then({ prompt: 'step 1' })
          .then({ prompt: 'step 2' })
          .run();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(TimeoutError);
      expect(typeof error.meta?.stepId).toBe('number');
    });

    it('should mark timeout errors as retryable', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          await new Promise(r => setTimeout(r, 200));
          return 'OK';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      let error: any;
      try {
        await agent({ llm, hideProgress: true, timeout: 0.1 })
          .then({ prompt: 'test' })
          .run();
      } catch (e) {
        error = e;
      }

      expect(error.meta?.retryable).toBe(true);
    });
  });

  describe('Timing Accuracy', () => {
    it('should accurately measure step duration', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          await new Promise(r => setTimeout(r, 100));
          return 'OK';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'test' })
        .run();

      expect(results[0].durationMs).toBeDefined();
      expect(results[0].durationMs!).toBeGreaterThanOrEqual(90);
      expect(results[0].durationMs!).toBeLessThan(500);
    });

    it('should track LLM time separately', async () => {
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          await new Promise(r => setTimeout(r, 50));
          return 'OK';
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      const results = await agent({ llm, hideProgress: true })
        .then({ prompt: 'test' })
        .run();

      expect(results[0].llmMs).toBeDefined();
      expect(results[0].llmMs!).toBeGreaterThanOrEqual(40);
    });
  });
});

describe('Retry Logic', () => {
  describe('Retry Configuration', () => {
    it('should default to 3 retries', async () => {
      let attempts = 0;
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          attempts++;
          const err: any = new Error('Always fails');
          err.status = 500;
          throw err;
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      try {
        await agent({ llm, hideProgress: true })
          .then({ prompt: 'test' })
          .run();
      } catch {
        // Expected to fail
      }

      expect(attempts).toBe(3); // Default retries
    });

    it('should respect custom retry count', async () => {
      let attempts = 0;
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          attempts++;
          const err: any = new Error('Always fails');
          err.status = 500;
          throw err;
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      try {
        await agent({ llm, hideProgress: true, retry: { retries: 5, delay: 0 } })
          .then({ prompt: 'test' })
          .run();
      } catch {
        // Expected
      }

      expect(attempts).toBe(5);
    });

    it('should allow disabling retries', async () => {
      let attempts = 0;
      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => {
          attempts++;
          const err: any = new Error('Fails');
          err.status = 500;
          throw err;
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      try {
        await agent({ llm, hideProgress: true, retry: { retries: 1, delay: 0 } })
          .then({ prompt: 'test' })
          .run();
      } catch {
        // Expected
      }

      expect(attempts).toBe(1); // No retries
    });
  });
});
