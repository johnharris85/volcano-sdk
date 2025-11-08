// src/mcp/auth.ts
// OAuth and Bearer token authentication for MCP

import type { MCPAuthConfig } from "./types.js";
import * as CONSTANTS from "../constants.js";

type TokenCacheEntry = { token: string; expiresAt: number };
const OAUTH_TOKEN_CACHE = new Map<string, TokenCacheEntry>();

export async function getOAuthToken(auth: MCPAuthConfig, endpoint: string): Promise<string> {
  // Check cache first
  const cached = OAUTH_TOKEN_CACHE.get(endpoint);
  if (cached && cached.expiresAt > Date.now() + CONSTANTS.OAUTH_TOKEN_EXPIRY_BUFFER_MS) {
    return cached.token;
  }

  // Acquire new token
  if (!auth.tokenEndpoint || !auth.clientId || !auth.clientSecret) {
    throw new Error(`OAuth auth requires tokenEndpoint, clientId, and clientSecret`);
  }

  // OAuth 2.0 RFC 6749 requires application/x-www-form-urlencoded for token requests
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: auth.clientId,
    client_secret: auth.clientSecret
  });

  // Add scope if provided (some OAuth servers require it)
  if (auth.scope) {
    params.set('scope', auth.scope);
  }

  const response = await fetch(auth.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    throw new Error(`OAuth token acquisition failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json();
  const token = data.access_token;
  const expiresIn = data.expires_in || 3600; // default 1 hour

  // Cache the token
  OAUTH_TOKEN_CACHE.set(endpoint, {
    token,
    expiresAt: Date.now() + (expiresIn * 1000)
  });

  return token;
}

export async function executeWithAuth<T>(
  auth: MCPAuthConfig,
  endpoint: string,
  fn: () => Promise<T>
): Promise<T> {
  // Get auth headers
  const authHeaders: Record<string, string> = {};

  if (auth.type === 'oauth') {
    const token = await getOAuthToken(auth, endpoint);
    authHeaders['Authorization'] = `Bearer ${token}`;
  } else if (auth.type === 'bearer' && auth.token) {
    authHeaders['Authorization'] = `Bearer ${auth.token}`;
  }

  // Wrap fetch globally during execution
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
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

export function clearOAuthTokenCache(): void {
  OAUTH_TOKEN_CACHE.clear();
}

export function getOAuthTokenCacheStats() {
  return {
    size: OAUTH_TOKEN_CACHE.size,
    endpoints: Array.from(OAUTH_TOKEN_CACHE.keys()),
  };
}

// Test exports
export const __internal_clearOAuthTokenCache = clearOAuthTokenCache;
export const __internal_getOAuthTokenCache = getOAuthTokenCacheStats;
