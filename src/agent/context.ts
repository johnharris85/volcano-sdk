// src/agent/context.ts
// Build context from step history

import type { StepResult } from "./types.js";

export function buildHistoryContextChunked(history: StepResult[], maxToolResults: number, maxChars: number): string {
  if (history.length === 0) return '';

  const chunks: string[] = [];

  // Include LLM outputs from all steps (not just last one)
  // This is important for subagents to see parent conversation history
  // contextMaxChars will truncate if this gets too long
  const llmOutputs: string[] = [];
  for (const step of history) {
    if (step.llmOutput) {
      llmOutputs.push(step.llmOutput);
    }
  }

  if (llmOutputs.length > 0) {
    if (llmOutputs.length === 1) {
    chunks.push('Previous LLM answer:\n');
      chunks.push(llmOutputs[0]);
    } else {
      chunks.push('Previous LLM answers:\n');
      llmOutputs.forEach((output, idx) => {
        chunks.push(`${idx + 1}. ${output}\n`);
      });
    }
    chunks.push('\n');
  }

  // Collect tool calls from ALL recent steps (not just last step)
  const allToolCalls: Array<{ name: string; arguments?: Record<string, any>; result: any }> = [];
  for (const step of history) {
    if (step.toolCalls && step.toolCalls.length > 0) {
      allToolCalls.push(...step.toolCalls);
    }
  }

  if (allToolCalls.length > 0) {
    chunks.push('Previous tool results:\n');
    // Take the most recent maxToolResults across ALL steps
    const recent = allToolCalls.slice(-maxToolResults);
    for (const t of recent) {
      chunks.push('- ');
      chunks.push(t.name);
      // Include arguments to preserve context like issue numbers, IDs, etc
      if (t.arguments) {
        try {
          chunks.push('(');
          chunks.push(JSON.stringify(t.arguments));
          chunks.push(')');
        } catch {
          // Skip if arguments can't be serialized
        }
      }
      chunks.push(' -> ');
      if (typeof t.result === 'string') {
        chunks.push(t.result);
      } else {
        try { chunks.push(JSON.stringify(t.result)); } catch { chunks.push('[unserializable]'); }
      }
      chunks.push('\n');
    }
  }

  // prefix header
  chunks.unshift('\n\n[Context from previous steps]\n');
  // assemble with maxChars cap
  let out = '';
  for (const c of chunks) {
    if (out.length + c.length > maxChars) break;
    out += c;
  }
  return out;
}
