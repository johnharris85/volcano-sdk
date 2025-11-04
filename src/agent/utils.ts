// src/agent/utils.ts
// Utility functions for agent execution

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'Step'
): Promise<T> {
  let timer: any;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
