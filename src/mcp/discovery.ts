// src/mcp/discovery.ts
// MCP tool discovery with caching

import type { MCPHandle } from "./types.js";
import { withMCP } from "./client.js";
import type { ToolDefinition } from "../llms/types.js";
import { normalizeError, classifyProviderFromMcp } from "../errors.js";

// Tool discovery cache for automatic selection
const TOOL_CACHE = new Map<string, { tools: ToolDefinition[]; ts: number }>();
let TOOL_CACHE_TTL_MS = 60_000;

/**
 * Discover all available tools from one or more MCP servers.
 * Results are cached for 60 seconds to improve performance.
 *
 * @param handles - Array of MCP handles to query for tools
 * @returns Combined array of all available tools from all servers
 *
 * @example
 * const weather = mcp("http://localhost:3000/mcp");
 * const calendar = mcp("http://localhost:4000/mcp");
 * const tools = await discoverTools([weather, calendar]);
 * console.log(tools.map(t => t.name)); // ["get_forecast", "create_event", ...]
 */
export async function discoverTools(handles: MCPHandle[]): Promise<ToolDefinition[]> {
  const allTools: ToolDefinition[] = [];

  for (const handle of handles) {
    try {
      const cached = TOOL_CACHE.get(handle.url);
      if (cached && (Date.now() - cached.ts) < TOOL_CACHE_TTL_MS) {
        // reuse cached with endpoint-specific names
        allTools.push(...cached.tools);
        continue;
      }
      const tools = await withMCP(handle, async (client) => {
        const result = await client.listTools();
        const mapped = result.tools.map(tool => ({
          name: `${handle.id}.${tool.name}`,
          description: tool.description || `Tool: ${tool.name}`,
          parameters: tool.inputSchema || { type: "object", properties: {} },
          mcpHandle: handle,
        }));
        TOOL_CACHE.set(handle.url, { tools: mapped, ts: Date.now() });
        return mapped;
      });
      allTools.push(...tools);
    } catch (error) {
      // Invalidate cache on failure
      TOOL_CACHE.delete(handle.url);
      // Fail fast - throw connection error
      throw normalizeError(error, 'mcp-conn', {
        provider: classifyProviderFromMcp(handle),
        retryable: true  // Connection errors are retryable
      });
    }
  }

  return allTools;
}

export function clearDiscoveryCache() {
  TOOL_CACHE.clear();
}

export function setDiscoveryTtl(ms: number) {
  TOOL_CACHE_TTL_MS = ms;
}

export function primeDiscoveryCache(handle: MCPHandle, rawTools: Array<{ name: string; inputSchema?: any; description?: string }>) {
  const tools: ToolDefinition[] = rawTools.map(t => ({
    name: `${handle.id}.${t.name}`,
    description: t.description || `Tool: ${t.name}`,
    parameters: t.inputSchema || { type: 'object', properties: {} },
    mcpHandle: handle,
  }));
  TOOL_CACHE.set(handle.url, { tools, ts: Date.now() });
}

// helper to fetch tool schema for explicit calls
export async function getToolSchema(handle: MCPHandle, toolName: string): Promise<any | undefined> {
  const cached = TOOL_CACHE.get(handle.url);
  if (cached) {
    const found = cached.tools.find(t => t.name === `${handle.id}.${toolName}`);
    return found?.parameters as any;
  }
  try {
    const tools = await withMCP(handle, async (client) => {
      const result = await client.listTools();
      const mapped = result.tools.map(tool => ({
        name: `${handle.id}.${tool.name}`,
        description: tool.description || `Tool: ${tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        mcpHandle: handle,
      }));
      TOOL_CACHE.set(handle.url, { tools: mapped, ts: Date.now() });
      return mapped;
    });
    const found = tools.find(t => t.name === `${handle.id}.${toolName}`);
    return found?.parameters as any;
  } catch {
    return undefined;
  }
}

// Test exports
export const __internal_clearDiscoveryCache = clearDiscoveryCache;
export const __internal_setDiscoveryTtl = setDiscoveryTtl;
export const __internal_primeDiscoveryCache = primeDiscoveryCache;
