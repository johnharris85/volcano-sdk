// src/agent/streaming.ts
// LLM streaming with token callbacks

import type { LLMHandle } from "../llms/types.js";
import type { TokenMetadata } from "./types.js";

/**
 * Helper function to execute LLM generation with optional token streaming.
 * Handles both step-level and stream-level onToken callbacks with proper precedence.
 */
export async function executeLLMWithStreaming(
  llm: LLMHandle,
  prompt: string,
  stepOnToken: ((token: string) => void) | undefined,
  streamOnToken: ((token: string, meta: TokenMetadata) => void) | undefined,
  meta: { stepIndex: number; stepPrompt?: string }
): Promise<string> {
  const hasStepOnToken = !!stepOnToken;
  const effectiveOnToken = stepOnToken || streamOnToken;

  if (effectiveOnToken && typeof llm.genStream === 'function') {
    const tokens: string[] = [];
    const tokenMeta: TokenMetadata = {
      stepIndex: meta.stepIndex,
      handledByStep: hasStepOnToken,
      stepPrompt: meta.stepPrompt,
      llmProvider: (llm as any).id || llm.model
    };

    for await (const token of llm.genStream(prompt)) {
      tokens.push(token);
      try {
        if (hasStepOnToken) {
          stepOnToken!(token);
        } else {
          streamOnToken!(token, tokenMeta);
        }
      } catch (e) {
        console.warn('onToken callback failed:', e);
      }
    }
    return tokens.join('');
  } else {
    return await llm.gen(prompt);
  }
}
