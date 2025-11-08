// src/mcp/client.ts
// MCP connection pooling with LRU eviction

import { Client as MCPClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { MCPAuthConfig, MCPHandle } from "./types.js";
import { getOAuthToken, executeWithAuth } from "./auth.js";
import * as CONSTANTS from "../constants.js";

type MCPPoolEntry = {
  client: MCPClient;
  transport: StreamableHTTPClientTransport;
  lastUsed: number;
  busyCount: number;
  auth?: MCPAuthConfig;
};

const MCP_POOL = new Map<string, MCPPoolEntry>();
let MCP_POOL_MAX = CONSTANTS.DEFAULT_MCP_POOL_MAX_SIZE;
let MCP_POOL_IDLE_MS = CONSTANTS.DEFAULT_MCP_POOL_IDLE_MS;

async function getPooledClient(url: string, auth?: MCPAuthConfig): Promise<MCPPoolEntry> {
  const poolKey = auth ? `${url}::auth` : url; // Separate pool entries for auth vs non-auth
  let entry = MCP_POOL.get(poolKey);
  if (!entry) {
    // Evict LRU idle if over max
    if (MCP_POOL.size >= MCP_POOL_MAX) {
      const idleEntries = Array.from(MCP_POOL.entries()).filter(([, e]) => e.busyCount === 0);
      idleEntries.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
      const toEvict = idleEntries.slice(0, Math.max(0, MCP_POOL.size - MCP_POOL_MAX + 1));
      for (const [k, e] of toEvict) {
        try { await e.client.close(); } catch {}
        MCP_POOL.delete(k);
      }
    }

    // Create transport
    const transport = new StreamableHTTPClientTransport(new URL(url));

    const client = new MCPClient({ name: "volcano-sdk", version: "0.0.1" });

    // Connect with auth if needed
    if (auth) {
      await connectWithAuth(transport, client, auth, url);
    } else {
      await client.connect(transport);
    }

    entry = { client, transport, lastUsed: Date.now(), busyCount: 0, auth };
    MCP_POOL.set(poolKey, entry);
  }
  entry.busyCount++;
  entry.lastUsed = Date.now();
  return entry;
}

async function connectWithAuth(transport: any, client: MCPClient, auth: MCPAuthConfig, endpoint: string) {
  // Get auth headers
  const authHeaders: Record<string, string> = {};

  if (auth.type === 'oauth') {
    const token = await getOAuthToken(auth, endpoint);
    authHeaders['Authorization'] = `Bearer ${token}`;
  } else if (auth.type === 'bearer' && auth.token) {
    authHeaders['Authorization'] = `Bearer ${auth.token}`;
  }

  // Wrap fetch globally during connect
  const originalFetch = global.fetch;
  global.fetch = async (url: any, init: any = {}) => {
    let mergedHeaders: any = {};
    if (init.headers) {
      if (init.headers instanceof Headers) {
        init.headers.forEach((value: string, key: string) => {
          mergedHeaders[key] = value;
        });
      } else {
        mergedHeaders = { ...init.headers };
      }
    }
    Object.assign(mergedHeaders, authHeaders);

    return originalFetch(url, {
      ...init,
      headers: mergedHeaders
    });
  };

  try {
    await client.connect(transport);
  } finally {
    global.fetch = originalFetch;
  }
}

async function cleanupIdlePool() {
  const now = Date.now();
  for (const [url, entry] of MCP_POOL) {
    if (entry.busyCount === 0 && now - entry.lastUsed > MCP_POOL_IDLE_MS) {
      try { await entry.client.close(); } catch {}
      MCP_POOL.delete(url);
    }
  }
}

// Periodic cleanup
let POOL_SWEEPER: any = undefined;
function ensurePoolSweeper() {
  if (!POOL_SWEEPER) {
    POOL_SWEEPER = setInterval(() => { cleanupIdlePool(); }, CONSTANTS.DEFAULT_MCP_POOL_SWEEP_INTERVAL_MS);
    // In tests or short-lived processes we don't need to keep the event loop alive
    if (typeof POOL_SWEEPER.unref === 'function') POOL_SWEEPER.unref();
  }
}

export async function withMCP<T>(h: MCPHandle, fn: (c: MCPClient) => Promise<T>, telemetry?: any, operation?: string): Promise<T> {
  ensurePoolSweeper();
  const poolKey = h.auth ? `${h.url}::auth` : h.url;
  const entry = await getPooledClient(h.url, h.auth);

  // Start MCP span if telemetry configured
  const mcpSpan = telemetry && operation ? telemetry.startMCPSpan(null, h, operation) : null;

  try {
    let result: T;
    // Always wrap with auth if configured (for both connect and tool calls)
    if (h.auth || entry.auth) {
      const authConfig = h.auth || entry.auth!;
      result = await executeWithAuth(authConfig, h.url, () => fn(entry.client));
    } else {
      result = await fn(entry.client);
    }

    telemetry?.endSpan(mcpSpan);
    telemetry?.recordMetric('mcp.call', 1, { endpoint: h.url, error: false });

    return result;
  } catch (error) {
    telemetry?.endSpan(mcpSpan, undefined, error);
    telemetry?.recordMetric('mcp.call', 1, { endpoint: h.url, error: true });
    throw error;
  } finally {
    const e = MCP_POOL.get(poolKey);
    if (e) {
      e.busyCount = Math.max(0, e.busyCount - 1);
      e.lastUsed = Date.now();
    }
  }
}

// Pool statistics
export function getMcpPoolStats() {
  return {
    size: MCP_POOL.size,
    urls: Array.from(MCP_POOL.keys())
  };
}

export async function forcePoolCleanup() {
  await cleanupIdlePool();
}

export function setPoolConfig(max: number, idleMs: number) {
  MCP_POOL_MAX = max;
  MCP_POOL_IDLE_MS = idleMs;
}

// Test exports
export const __internal_getMcpPoolStats = getMcpPoolStats;
export const __internal_forcePoolCleanup = forcePoolCleanup;
export const __internal_setPoolConfig = setPoolConfig;
