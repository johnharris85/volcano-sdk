// src/errors.ts
// Error classes and normalization logic

export interface VolcanoErrorMeta {
  stepId?: number;
  provider?: string;
  requestId?: string;
  retryable?: boolean;
}

export class VolcanoError extends Error {
  meta: VolcanoErrorMeta;
  constructor(message: string, meta: VolcanoErrorMeta = {}, options?: { cause?: unknown }) {
    super(message);
    this.name = this.constructor.name;
    this.meta = meta;
    if (options?.cause) (this as any).cause = options.cause;
  }
}

export class AgentConcurrencyError extends VolcanoError {}
export class TimeoutError extends VolcanoError {}
export class ValidationError extends VolcanoError {}
export class RetryExhaustedError extends VolcanoError {}
export class LLMError extends VolcanoError {}
export class MCPError extends VolcanoError {}
export class MCPConnectionError extends MCPError {}
export class MCPToolError extends MCPError {}

export function isRetryableStatus(status?: number): boolean {
  if (!status && status !== 0) return false;
  return status >= 500 || status === 429 || status === 408;
}

export function classifyProviderFromLlm(usedLlm?: any): string | undefined {
  if (!usedLlm) return undefined;
  if ((usedLlm as any).id) return `llm:${(usedLlm as any).id}`;
  return `llm:${usedLlm.model}`;
}

export function classifyProviderFromMcp(handle?: any): string | undefined {
  if (!handle) return undefined;
  try {
    const u = new URL(handle.url);
    return `mcp:${u.host}`;
  } catch {
    return `mcp:${handle.id}`;
  }
}

export function normalizeError(
  e: any,
  kind: 'timeout' | 'validation' | 'llm' | 'mcp-conn' | 'mcp-tool' | 'retry',
  meta: VolcanoErrorMeta
): VolcanoError {
  if (kind === 'timeout') {
    return new TimeoutError(e?.message || 'Step timed out', { ...meta, retryable: true }, { cause: e });
  }
  if (kind === 'validation') {
    return new ValidationError(e?.message || 'Validation failed', { ...meta, retryable: false }, { cause: e });
  }
  if (kind === 'retry') {
    return new RetryExhaustedError(e?.message || 'Retry attempts exhausted', { ...meta }, { cause: e });
  }
  if (kind === 'llm') {
    const status = e?.status ?? e?.response?.status;
    const requestId = e?.response?.headers?.get?.('x-request-id') || e?.id || e?.response?.data?.id;
    const retryable =
      (status == null ? true : isRetryableStatus(status)) ||
      !!e?.code?.toString?.()?.includes?.('ECONN') ||
      !!e?.code?.toString?.()?.includes?.('ETIMEDOUT');
    return new LLMError(e?.message || 'LLM error', { ...meta, requestId, retryable }, { cause: e });
  }
  if (kind === 'mcp-conn') {
    const retryable = true;
    return new MCPConnectionError(e?.message || 'MCP connection error', { ...meta, retryable }, { cause: e });
  }
  // mcp-tool
  return new MCPToolError(e?.message || 'MCP tool error', { ...meta, retryable: false }, { cause: e });
}
