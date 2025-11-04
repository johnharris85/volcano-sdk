// src/agent/progress.ts
// Progress display and rendering

/**
 * Shared display helpers for consistent progress formatting.
 */
const createProgressDisplay = (workflowStart: number, isTTY: boolean) => ({
  showWaiting: () => {
    console.log('\n   ⏳ Waiting for LLM');
  },

  showTokens: (count: number, provider?: string) => {
    const elapsed = (Date.now() - workflowStart) / 1000;
    const throughput = Math.round(count / Math.max(elapsed, 0.1));
    const providerInfo = provider ? ` (via ${provider})` : '';

    if (count === 1) {
      // Clear waiting message (move up one line)
      process.stdout.write('\x1b[1A\r\x1b[K');
    }
    if (count % 10 === 0 || count === 1) {
      process.stdout.write(`\r   💭 ${count} tokens | ${throughput} tok/s${providerInfo}`);
    }
  },

  showComplete: (durationMs: number, tokens: number, provider?: string) => {
    if (isTTY) process.stdout.write('\r\x1b[K');
    const providerInfo = provider ? ` | ${provider}` : '';
    console.log(`   ✅ Complete | ${tokens.toLocaleString()} token${tokens > 1 ? 's' : ''} | ${(durationMs/1000).toFixed(1)}s${providerInfo}\n`);
  }
});

/**
 * Create beautiful TTY progress handler for workflows.
 */
export function createProgressHandler(totalSteps: number, isSubAgent: boolean = false, isExplicitSubAgent: boolean = false, parentStepIndex?: number, parentTotalSteps?: number) {
  const workflowStart = Date.now();
  const isTTY = process.stdout?.isTTY || false;
  const display = createProgressDisplay(workflowStart, isTTY);
  let operationStart = Date.now();
  let waitInterval: NodeJS.Timeout | null = null;

  if (!isSubAgent) {
    console.log('\n🌋 Running Volcano agent [volcano-sdk v1.0.1] • docs at https://volcano.dev');
    console.log('━'.repeat(50));
  }

  return {
    stepStart: (stepIndex: number, prompt?: string) => {
      // For agent crews (delegated agents), suppress step start (parent shows delegation)
      if (isSubAgent && !isExplicitSubAgent) return;

      // For explicit sub-agents, use parent step numbering
      const display = prompt?.substring(0, 60) || 'Processing';
      const actualStepNum = (isExplicitSubAgent && parentStepIndex !== undefined) ? parentStepIndex + stepIndex + 1 : stepIndex + 1;
      const actualTotalSteps = (isExplicitSubAgent && parentTotalSteps !== undefined) ? parentTotalSteps : totalSteps;
      console.log(`🤖 Step ${actualStepNum}/${actualTotalSteps}: ${display}${prompt && prompt.length > 60 ? '...' : ''}`);
    },
    startLlmOperation: () => {
      operationStart = Date.now();
      // Show elapsed time while waiting for first token
      if (isTTY && !isSubAgent) {
        waitInterval = setInterval(() => {
          const elapsed = ((Date.now() - operationStart) / 1000).toFixed(1);
          process.stdout.write(`\r   ⏳ Waiting for LLM | ${elapsed}s`);
        }, 100);
      }
    },
    llmToken: (count: number, provider?: string) => {
      // For agent crews, suppress token progress (parent tracks via onToken callback)
      // For explicit sub-agents, show token progress
      if (isSubAgent && !isExplicitSubAgent) return;

      // Clear waiting interval on first token
      if (count === 1 && waitInterval) {
        clearInterval(waitInterval);
        waitInterval = null;
      }

      const elapsed = (Date.now() - operationStart) / 1000;
      const throughput = Math.round(count / Math.max(elapsed, 0.1));
      if (count % 10 === 0 || count === 1) {
        const providerInfo = provider ? ` | ${provider}` : '';
        process.stdout.write(`\r   💭 ${count} tokens | ${throughput} tok/s | ${elapsed.toFixed(1)}s${providerInfo}`);
      }
    },
    agentStart: (agentName: string, task: string) => {
      console.log(`\n⚡ ${agentName} → ${task.substring(0, 50)}...`);
      operationStart = Date.now();
      // Show elapsed time while waiting for first token
      if (isTTY) {
        waitInterval = setInterval(() => {
          const elapsed = ((Date.now() - operationStart) / 1000).toFixed(1);
          process.stdout.write(`\r   ⏳ Waiting for LLM | ${elapsed}s`);
        }, 100);
      } else {
        process.stdout.write('   ⏳ Waiting for LLM');
      }
    },
    agentToken: (count: number, provider?: string) => {
      // Clear waiting interval on first token
      if (count === 1 && waitInterval) {
        clearInterval(waitInterval);
        waitInterval = null;
      }

      const elapsed = (Date.now() - operationStart) / 1000;
      const throughput = Math.round(count / Math.max(elapsed, 0.1));
      if (count % 10 === 0 || count === 1) {
        if (count === 1) {
          // First token - clear the "Waiting..." line
          process.stdout.write('\r\x1b[K');
        }
        const providerInfo = provider ? ` | ${provider}` : '';
        process.stdout.write(`\r   💭 ${count} tokens | ${throughput} tok/s | ${elapsed.toFixed(1)}s${providerInfo}`);
      }
    },
    agentComplete: (agentName: string, tokens: number, durationMs: number, provider?: string) => {
      display.showComplete(durationMs, tokens, provider);
    },
    stepComplete: (durationMs: number, tokenCount?: number, provider?: string, crewTokens?: number, crewModels?: string[]) => {
      // For agent crews, suppress step complete (parent shows completion)
      // For explicit sub-agents, show step complete
      if (isSubAgent && !isExplicitSubAgent) return;

      if (crewTokens && crewModels) {
        // Crew workflow - don't show anything here, workflowEnd will show the final summary
        return;
      } else if (tokenCount) {
        display.showComplete(durationMs, tokenCount, provider);
      } else {
        if (isTTY) process.stdout.write('\r\x1b[K');
        console.log(`   ✅ Complete | ${(durationMs/1000).toFixed(1)}s\n`);
      }
    },
    workflowEnd: (stepCount: number, totalTokens?: number, totalDuration?: number, models?: string[]) => {
      if (isSubAgent) return; // Suppress footer for sub-agents

      console.log('━'.repeat(50));
      if (totalTokens && models && models.length > 0) {
        const modelsList = models.join(', ');
        console.log(`🎉 Agent complete | ${totalTokens.toLocaleString()} tokens | ${((totalDuration || 0)/1000).toFixed(1)}s | ${modelsList}`);
      } else {
        const total = (Date.now() - workflowStart) / 1000;
        console.log(`🎉 Workflow complete! ${stepCount} step${stepCount > 1 ? 's' : ''} in ${total.toFixed(1)}s`);
      }
    }
  };
}
