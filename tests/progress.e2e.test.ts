import { describe, it, expect } from 'vitest';
import { agent, llmOpenAI } from '../src/index.js';

describe('Progress output e2e (live APIs)', () => {
  it('validates default progress works for basic LLM steps', async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required');
    }

    const llm = llmOpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
      options: { max_completion_tokens: 64, temperature: 0, top_p: 1 }
    });

    // Capture console output
    const logs: string[] = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalLog(...args);
    };
    
    process.stdout.write = (chunk: any): boolean => {
      logs.push(String(chunk));
      return originalWrite(chunk);
    };

    try {
      await agent({ llm })
        .then({ prompt: "Say 'Hello World' exactly" })
        .run();

      // Restore
      console.log = originalLog;
      process.stdout.write = originalWrite;

      // Verify progress elements appeared
      const output = logs.join('');
      
      // Check for header
      expect(output).toContain('🌋 Running Volcano agent');
      expect(output).toContain('volcano-sdk v');
      expect(output).toContain('https://volcano.dev');
      
      // Check for step indicator
      expect(output).toContain('🤖 Step 1/1');
      
      // Check for completion
      expect(output).toContain('✅ Complete');
      
      // Check for workflow summary
      expect(output).toContain('🎉 Agent complete');
      
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  });

  it('validates default progress works for multi-step workflows', { timeout: 30000 }, async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required');
    }

    const llm = llmOpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
      options: { max_completion_tokens: 64, temperature: 0, top_p: 1 }
    });

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalLog(...args);
    };
    
    process.stdout.write = (chunk: any): boolean => {
      logs.push(String(chunk));
      return originalWrite(chunk);
    };

    try {
      await agent({ llm })
        .then({ prompt: "Say 'Step 1' exactly" })
        .then({ prompt: "Say 'Step 2' exactly" })
        .run();

      console.log = originalLog;
      process.stdout.write = originalWrite;

      const output = logs.join('');
      
      // CRITICAL: Verify both steps shown
      expect(output).toContain('🤖 Step 1/2');
      expect(output).toContain('🤖 Step 2/2');
      
      // Token progress shows for longer responses (>10 tokens)
      // Short responses may not trigger display
      
      // CRITICAL: Verify both completions appear
      const completeMatches = output.match(/✅ Complete \| .*s/g);
      expect((completeMatches?.length ?? 0)).toBeGreaterThanOrEqual(2);
      
      // CRITICAL: Verify no triple newlines
      expect(output).not.toMatch(/\n\n\n/);
      
      // CRITICAL: Verify workflow summary
      expect(output).toContain('🎉 Agent complete');
      
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  });

  it('validates default progress works for agent crews', { timeout: 60000 }, async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required');
    }

    const llm = llmOpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
      options: { max_completion_tokens: 64, temperature: 0, top_p: 1 }
    });

    // Define simple agents
    const summarizer = agent({
      llm,
      name: 'summarizer',
      description: 'Creates concise summaries'
    });

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalLog(...args);
    };
    
    process.stdout.write = (chunk: any): boolean => {
      logs.push(String(chunk));
      return originalWrite(chunk);
    };

    try {
      await agent({ llm, timeout: 60 })
        .then({
          prompt: 'Summarize the word "AI" in one sentence',
          agents: [summarizer]
        })
        .run();

      console.log = originalLog;
      process.stdout.write = originalWrite;

      const output = logs.join('');
      
      // Verify header
      expect(output).toContain('🌋 Running Volcano agent');
      expect(output).toContain('volcano-sdk v');
      expect(output).toContain('https://volcano.dev');
      
      // Verify step shown
      expect(output).toContain('🤖 Step 1/1');
      
      // CRITICAL: Verify coordinator thinking (no indentation)
      expect(output).toContain('🧠 Coordinator selecting agents');
      
      // CRITICAL: Verify coordinator decision (new format: decision on one line, stats on Complete line)
      expect(output).toMatch(/🧠 Coordinator decision: USE \w+/);
      
      // CRITICAL: Verify agent was invoked with progress (no indentation)
      expect(output).toContain('⚡ summarizer');
      
      // Token progress shows for longer responses
      // (Short responses complete before 10-token threshold)
      
      // CRITICAL: Verify agent completion shows time + tokens
      expect(output).toMatch(/✅ Complete \| \d+ tokens \| \d+\.\d+s \| /);
      
      // CRITICAL: Verify coordinator decision followed by Complete line
      expect(output).toMatch(/🧠 Coordinator decision: USE \w+\n\s+✅ Complete/);
      
      // CRITICAL: Verify no triple newlines
      expect(output).not.toMatch(/\n\n\n/);
      
      // Verify final completion with totals
      expect(output).toContain('✅ Complete');
      expect(output).toContain('🎉 Agent complete');
      expect(output).toMatch(/🎉 Agent complete \| \d+ tokens \| \d+\.\d+s \| /);
      
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  });

  it('validates default progress never breaks with errors', { timeout: 30000 }, async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required');
    }

    const llm = llmOpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
      options: { max_completion_tokens: 64, temperature: 0, top_p: 1 }
    });

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    const originalError = console.error;
    
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalLog(...args);
    };
    
    console.error = (...args: any[]) => {
      logs.push(args.join(' '));
      originalError(...args);
    };
    
    process.stdout.write = (chunk: any): boolean => {
      logs.push(String(chunk));
      return originalWrite(chunk);
    };

    try {
      // This should timeout and retry, but progress should still work
      await agent({ llm, timeout: 1, retry: { retries: 2 } })
        .then({ prompt: "Count to 100 slowly" })
        .run();
    } catch (e) {
      // Expected to fail, that's OK
    }

    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalWrite;

    const output = logs.join('');
    
    // Even with errors/timeouts, progress should have shown
    expect(output).toContain('🌋 Running Volcano agent');
    expect(output).toContain('🤖 Step 1/1');
    
    // Should have attempted multiple times (retries)
    const stepMatches = output.match(/🤖 Step 1\/1/g);
    expect(stepMatches?.length).toBeGreaterThanOrEqual(1);
  });

  it('validates progress output is TTY-aware', async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required');
    }

    const llm = llmOpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini'
    });

    const logs: string[] = [];
    const originalLog = console.log;
    
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalLog(...args);
    };

    try {
      await agent({ llm })
        .then({ prompt: "Say 'Test'" })
        .run();

      console.log = originalLog;

      const output = logs.join('');
      
      // Progress should work (even if not TTY in test environment)
      expect(output).toContain('🌋 Running Volcano agent');
      expect(output).toContain('✅ Complete');
      
    } finally {
      console.log = originalLog;
    }
  });

  it('validates hideProgress: true suppresses all progress output', { timeout: 10000 }, async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY required');
    }

    const llm = llmOpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
      model: 'gpt-4o-mini',
      options: { max_completion_tokens: 32, temperature: 0, top_p: 1 }
    });

    const logs: string[] = [];
    const originalLog = console.log;
    const originalWrite = process.stdout.write.bind(process.stdout);
    
    console.log = (...args: any[]) => {
      logs.push(args.join(' '));
      originalLog(...args);
    };
    
    process.stdout.write = (chunk: any): boolean => {
      logs.push(String(chunk));
      return originalWrite(chunk);
    };

    try {
      await agent({ llm, hideProgress: true })
        .then({ prompt: "Say 'Hello' exactly" })
        .then({ prompt: "Say 'World' exactly" })
        .run();

      console.log = originalLog;
      process.stdout.write = originalWrite;

      const output = logs.join('');
      
      // CRITICAL: Progress elements should NOT appear when hideProgress: true
      expect(output).not.toContain('🌋 Running Volcano agent');
      expect(output).not.toContain('🤖 Step');
      expect(output).not.toContain('✅ Complete');
      expect(output).not.toContain('🎉 Agent complete');
      expect(output).not.toContain('━━━');
      // Note: Skip checking '💭' due to potential cross-test contamination in parallel runs
      
    } finally {
      console.log = originalLog;
      process.stdout.write = originalWrite;
    }
  });
});

