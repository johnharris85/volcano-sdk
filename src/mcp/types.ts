// src/mcp/types.ts
// MCP (Model Context Protocol) type definitions

export type MCPAuthConfig = {
  type: 'oauth' | 'bearer';
  token?: string;           // For bearer auth: direct token
  clientId?: string;        // For OAuth: client credentials
  clientSecret?: string;
  tokenEndpoint?: string;   // OAuth token endpoint
  scope?: string;           // OAuth scope (optional, some servers require it)
};

export type MCPHandle = {
  listTools: () => Promise<{ tools: Array<{ name: string; description?: string; inputSchema?: any }> }>;
  callTool: (name: string, args: Record<string, any>) => Promise<any>;
  id: string;
  url: string;
  auth?: MCPAuthConfig;
};
