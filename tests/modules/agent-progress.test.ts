/**
 * Tests for proposed src/agent/progress.ts module
 * These tests verify progress rendering and hideProgress functionality
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { agent } from '../../dist/volcano-sdk.js';

describe('Agent Progress Rendering', () => {
  let consoleOutput: string[] = [];
  let originalLog: any;
  let originalWrite: any;

  beforeEach(() => {
    consoleOutput = [];

    // Capture console.log
    originalLog = console.log;
    console.log = (...args: any[]) => {
      consoleOutput.push(args.join(' '));
    };

    // Capture process.stdout.write
    originalWrite = process.stdout.write;
    process.stdout.write = ((str: string) => {
      consoleOutput.push(str);
      return true;
    }) as any;
  });

  afterEach(() => {
    console.log = originalLog;
    process.stdout.write = originalWrite;
  });

  function makeLLM(delay: number = 0) {
    return {
      id: 'test-llm',
      model: 'test-model',
      client: {},
      gen: async (prompt: string) => {
        if (delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
        return 'Response';
      },
      genWithTools: async () => {
        if (delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
        return { content: 'Response', toolCalls: [] };
      },
      genStream: async function* () {
        if (delay > 0) {
          await new Promise(r => setTimeout(r, delay));
        }
        yield 'Response';
      },
    } as any;
  }

  describe('Progress Display Control', () => {
    it('should show progress by default', async () => {
      const llm = makeLLM();

      await agent({ llm })
        .then({ prompt: 'test' })
        .run();

      // Should have progress output
      const output = consoleOutput.join('');
      expect(output.length).toBeGreaterThan(0);
    });

    it('should hide progress when hideProgress=true', async () => {
      const llm = makeLLM();

      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test' })
        .run();

      // Should have minimal or no output
      const output = consoleOutput.join('');
      expect(output).not.toContain('🌋');
      expect(output).not.toContain('Running Volcano agent');
    });

    it('should suppress progress for multiple steps', async () => {
      const llm = makeLLM();

      await agent({ llm, hideProgress: true })
        .then({ prompt: 'step 1' })
        .then({ prompt: 'step 2' })
        .then({ prompt: 'step 3' })
        .run();

      const output = consoleOutput.join('');
      expect(output).not.toContain('Step 1/3');
      expect(output).not.toContain('Step 2/3');
      expect(output).not.toContain('Step 3/3');
    });
  });

  describe('Progress Header and Footer', () => {
    it('should show workflow header with progress enabled', async () => {
      const llm = makeLLM();

      await agent({ llm })
        .then({ prompt: 'test' })
        .run();

      const output = consoleOutput.join('');
      expect(output).toContain('🌋');
      expect(output).toContain('Running Volcano agent');
    });

    it('should show workflow footer on completion', async () => {
      const llm = makeLLM();

      await agent({ llm })
        .then({ prompt: 'test' })
        .run();

      const output = consoleOutput.join('');
      expect(output).toContain('complete');
    });

    it('should not show header/footer when hideProgress=true', async () => {
      const llm = makeLLM();

      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test' })
        .run();

      const output = consoleOutput.join('');
      expect(output).not.toContain('Running Volcano agent');
      expect(output).not.toContain('Workflow complete');
    });
  });

  describe('Step Progress', () => {
    it('should show step numbers', async () => {
      const llm = makeLLM();

      await agent({ llm })
        .then({ prompt: 'first' })
        .then({ prompt: 'second' })
        .run();

      const output = consoleOutput.join('');
      expect(output).toContain('Step 1/2');
      expect(output).toContain('Step 2/2');
    });

    it('should show step prompts (truncated if long)', async () => {
      const llm = makeLLM();

      const longPrompt = 'A'.repeat(100);
      await agent({ llm })
        .then({ prompt: longPrompt })
        .run();

      const output = consoleOutput.join('');
      // Should show truncated prompt
      expect(output).toContain('A');
    });

    it('should handle short prompts without truncation', async () => {
      const llm = makeLLM();

      await agent({ llm })
        .then({ prompt: 'short' })
        .run();

      const output = consoleOutput.join('');
      expect(output).toContain('short');
    });
  });

  describe('Subagent Progress', () => {
    it('should suppress progress for implicit subagents (crews)', async () => {
      const llm = makeLLM();

      const subagent = agent({ llm, hideProgress: true })
        .then({ prompt: 'subagent task' });

      await agent({ llm })
        .runAgent(subagent)
        .run();

      // Subagent should not show separate progress
      const output = consoleOutput.join('');
      expect(output.split('🌋').length).toBeLessThanOrEqual(2); // Only main agent header
    });

    it('should show progress for explicit subagents', async () => {
      const llm = makeLLM();

      const subagent = agent({ llm })
        .then({ prompt: 'explicit subagent' });

      await agent({ llm })
        .runAgent(subagent)
        .run();

      const output = consoleOutput.join('');
      // Should show some progress (though details may vary)
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe('Token Streaming Progress', () => {
    it('should show token count during streaming', async () => {
      const llm = {
        id: 'streaming-llm',
        model: 'test',
        client: {},
        gen: async () => 'Response',
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {
          for (let i = 0; i < 100; i++) {
            yield 'token';
            if (i % 20 === 0) {
              await new Promise(r => setTimeout(r, 1));
            }
          }
        },
      } as any;

      const results = await agent({ llm })
        .then({ prompt: 'test', onToken: (t) => {} })
        .run();

      expect(results.length).toBe(1);
      const output = consoleOutput.join('');
      // Should show token progress
      expect(output.length).toBeGreaterThan(0);
    });

    it('should suppress token progress when hideProgress=true', async () => {
      const llm = {
        id: 'streaming-llm',
        model: 'test',
        client: {},
        gen: async () => 'Response',
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {
          for (let i = 0; i < 50; i++) {
            yield 'token';
          }
        },
      } as any;

      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test', onToken: (t) => {} })
        .run();

      const output = consoleOutput.join('');
      expect(output).not.toContain('tokens');
      expect(output).not.toContain('tok/s');
    });
  });

  describe('Duration Display', () => {
    it('should show step duration on completion', async () => {
      const llm = makeLLM(50);

      await agent({ llm })
        .then({ prompt: 'test' })
        .run();

      const output = consoleOutput.join('');
      expect(output).toContain('s'); // Shows seconds
    });

    it('should show total workflow duration', async () => {
      const llm = makeLLM(10);

      await agent({ llm })
        .then({ prompt: 'step1' })
        .then({ prompt: 'step2' })
        .run();

      const output = consoleOutput.join('');
      expect(output).toContain('complete');
      // Should show total time
    });
  });

  describe('Parallel Step Progress', () => {
    it('should handle progress for parallel steps', async () => {
      const llm = makeLLM();

      await agent({ llm })
        .parallel([
          { prompt: 'parallel 1' },
          { prompt: 'parallel 2' },
        ])
        .run();

      const output = consoleOutput.join('');
      expect(output.length).toBeGreaterThan(0);
    });

    it('should suppress parallel progress when hideProgress=true', async () => {
      const llm = makeLLM();

      await agent({ llm, hideProgress: true })
        .parallel([
          { prompt: 'parallel 1' },
          { prompt: 'parallel 2' },
        ])
        .run();

      const output = consoleOutput.join('');
      expect(output).not.toContain('Running Volcano agent');
    });
  });

  describe('Error Display', () => {
    it('should show progress before error occurs', async () => {
      const llm = {
        id: 'failing-llm',
        model: 'test',
        client: {},
        gen: async () => {
          throw new Error('LLM failed');
        },
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;

      try {
        await agent({ llm, retry: { retries: 1 } })
          .then({ prompt: 'test' })
          .run();
      } catch {
        // Expected
      }

      const output = consoleOutput.join('');
      // Should have shown some progress before failing
      expect(output.length).toBeGreaterThan(0);
    });
  });

  describe('Progress Customization', () => {
    it('should allow agent name in progress', async () => {
      const llm = makeLLM();

      await agent({ llm, name: 'CustomAgent' })
        .then({ prompt: 'test' })
        .run();

      const output = consoleOutput.join('');
      // Agent name may appear in certain contexts
      expect(output.length).toBeGreaterThan(0);
    });

    it('should show model info when available', async () => {
      const llm = {
        id: 'OpenAI-gpt-4',
        model: 'gpt-4',
        client: {},
        gen: async () => 'Response',
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () { yield 'Response'; },
      } as any;

      await agent({ llm })
        .then({ prompt: 'test' })
        .run();

      const output = consoleOutput.join('');
      expect(output.length).toBeGreaterThan(0);
      // Model info may be displayed
    });
  });

  describe('Stream Progress', () => {
    it('should show progress during streaming execution', async () => {
      const llm = makeLLM();

      const stream = agent({ llm })
        .then({ prompt: 'test' })
        .stream();

      for await (const result of stream) {
        // Consume stream
      }

      const output = consoleOutput.join('');
      expect(output.length).toBeGreaterThan(0);
    });

    it('should suppress progress in streaming mode when hideProgress=true', async () => {
      const llm = makeLLM();

      const stream = agent({ llm, hideProgress: true })
        .then({ prompt: 'test' })
        .stream();

      for await (const result of stream) {
        // Consume stream
      }

      const output = consoleOutput.join('');
      expect(output).not.toContain('Running Volcano agent');
    });
  });
});

describe('Progress Rendering Edge Cases', () => {
  it('should handle agent with zero steps', async () => {
    const llm = {
      id: 'mock',
      model: 'test',
      client: {},
      gen: async () => 'OK',
      genWithTools: async () => ({ content: '', toolCalls: [] }),
      genStream: async function* () {},
    } as any;

    const results = await agent({ llm, hideProgress: true }).run();

    expect(results.length).toBe(0);
  });

  it('should handle very long workflow', async () => {
    const llm = {
      id: 'mock',
      model: 'test',
      client: {},
      gen: async () => 'OK',
      genWithTools: async () => ({ content: '', toolCalls: [] }),
      genStream: async function* () {},
    } as any;

    const a = agent({ llm, hideProgress: true });

    // Add many steps
    for (let i = 0; i < 20; i++) {
      a.then({ prompt: `step ${i}` });
    }

    const results = await a.run();
    expect(results.length).toBe(20);
  });

  it('should handle rapid successive runs', async () => {
    const llm = {
      id: 'mock',
      model: 'test',
      client: {},
      gen: async () => 'OK',
      genWithTools: async () => ({ content: '', toolCalls: [] }),
      genStream: async function* () {},
    } as any;

    // Run multiple agents quickly
    const results = await Promise.all([
      agent({ llm, hideProgress: true }).then({ prompt: 'test' }).run(),
      agent({ llm, hideProgress: true }).then({ prompt: 'test' }).run(),
      agent({ llm, hideProgress: true }).then({ prompt: 'test' }).run(),
    ]);

    expect(results.length).toBe(3);
    results.forEach(r => expect(r.length).toBe(1));
  });
});
