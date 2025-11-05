// src/agent/executor-utils.ts
// Helper utilities for agent execution

import type { StepResult } from "./types.js";

/**
 * Aggregate metrics from step results for final workflow summary.
 * Extracts total tokens, models used, and total duration.
 */
export function aggregateStepMetrics(results: StepResult[]): {
  totalTokens: number;
  modelsUsed: string[];
  totalDuration: number;
} {
  const totalTokens = results.reduce((acc, s) => {
    const stepTokens = (s as any).__tokenCount || (s as any).__crewTotalTokens || 0;
    return acc + stepTokens;
  }, 0);

  const modelsSet = new Set<string>();
  results.forEach(s => {
    const provider = (s as any).__provider;
    const crewModels = (s as any).__crewModels;
    if (provider) modelsSet.add(provider);
    if (crewModels) crewModels.forEach((m: string) => modelsSet.add(m));
  });

  const totalDuration = results.reduce((acc, s) => acc + (s.durationMs || 0), 0);

  return {
    totalTokens,
    modelsUsed: Array.from(modelsSet),
    totalDuration
  };
}
