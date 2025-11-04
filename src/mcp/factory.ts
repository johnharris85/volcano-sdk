// src/mcp/factory.ts
// MCP handle factory function

import { createHash } from "node:crypto";
import type { MCPAuthConfig, MCPHandle } from "./types.js";
import { withMCP } from "./client.js";

/**
 * Connect to an MCP (Model Context Protocol) server via HTTP.
 * Supports connection pooling, OAuth/Bearer authentication, and automatic reconnection.
 *
 * @param url - HTTP endpoint URL for the MCP server (e.g., "http://localhost:3000/mcp")
 * @param options - Optional authentication configuration (OAuth 2.1 or Bearer token)
 * @returns MCPHandle for listing and calling tools
 *
 * @example
 * // Basic usage
 * const weather = mcp("http://localhost:3000/mcp");
 * const tools = await weather.listTools();
 * const forecast = await weather.callTool("get_forecast", { city: "San Francisco" });
 *
 * @example
 * // With OAuth authentication
 * const github = mcp("https://api.github.com/mcp", {
 *   auth: {
 *     type: 'oauth',
 *     clientId: process.env.GITHUB_CLIENT_ID!,
 *     clientSecret: process.env.GITHUB_SECRET!,
 *     tokenUrl: 'https://github.com/login/oauth/access_token'
 *   }
 * });
 */
export function mcp(url: string, options?: { auth?: MCPAuthConfig }): MCPHandle {
  // Use hash-based ID to keep tool names under OpenAI's 64-char limit
  // Tool names are: ${id}.${toolName}, so short ID = more room for tool names
  const hash = createHash('md5').update(url).digest('hex').substring(0, 8);
  const id = `mcp_${hash}`; // e.g., "mcp_f3c8a9b1" (12 chars, deterministic)

  return {
    id,
    url,
    auth: options?.auth,
    listTools: async () => {
      return withMCP({ id, url, auth: options?.auth } as MCPHandle, (c) => c.listTools());
    },
    callTool: async (name, args) => {
      return withMCP({ id, url, auth: options?.auth } as MCPHandle, (c) => c.callTool({ name, arguments: args }));
    }
  };
}
