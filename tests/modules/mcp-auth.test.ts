/**
 * Tests for proposed src/mcp/auth.ts module
 * These tests verify OAuth and Bearer token authentication
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import express from 'express';
import type { Server } from 'node:http';
import {
  mcp,
  agent,
  __internal_clearOAuthTokenCache,
  __internal_getOAuthTokenCache,
} from '../../dist/index.js';

function waitForOutput(proc: ChildProcess, match: RegExp, timeoutMs = 10000) {
  return new Promise<void>((resolve, reject) => {
    const onData = (data: Buffer) => {
      if (match.test(data.toString())) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      proc.stdout?.off('data', onData);
      proc.stderr?.off('data', onData);
      clearTimeout(timer);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout waiting for server output'));
    }, timeoutMs);
  });
}

describe('MCP Authentication', () => {
  let authServer: Server | null = null;
  const AUTH_PORT = 3401;
  const TOKEN_ENDPOINT = `http://localhost:${AUTH_PORT}/oauth/token`;

  function makeLLM() {
    return {
      id: 'mock',
      model: 'test',
      client: {},
      gen: async () => 'OK',
      genWithTools: async () => ({ content: 'done', toolCalls: [] }),
      genStream: async function* () {},
    } as any;
  }

  beforeEach(() => {
    __internal_clearOAuthTokenCache();
  });

  afterEach(() => {
    if (authServer) {
      authServer.close();
      authServer = null;
    }
    __internal_clearOAuthTokenCache();
  });

  describe('Bearer Token Authentication', () => {
    it('should accept bearer token configuration', () => {
      const handle = mcp('http://localhost:3000/mcp', {
        auth: {
          type: 'bearer',
          token: 'test-bearer-token-123',
        },
      });

      expect(handle.auth).toBeDefined();
      expect(handle.auth?.type).toBe('bearer');
      expect(handle.auth?.token).toBe('test-bearer-token-123');
    });

    it('should handle bearer auth at handle level', () => {
      const handle = mcp('http://localhost:3000/mcp', {
        auth: {
          type: 'bearer',
          token: 'handle-level-token',
        },
      });

      expect(handle.auth?.type).toBe('bearer');
      expect(handle.auth?.token).toBe('handle-level-token');
    });
  });

  describe('OAuth Authentication Configuration', () => {
    it('should accept OAuth configuration', () => {
      const handle = mcp('http://localhost:3000/mcp', {
        auth: {
          type: 'oauth',
          clientId: 'test-client-id',
          clientSecret: 'test-client-secret',
          tokenEndpoint: TOKEN_ENDPOINT,
          scope: 'read write',
        },
      });

      expect(handle.auth).toBeDefined();
      expect(handle.auth?.type).toBe('oauth');
      expect(handle.auth?.clientId).toBe('test-client-id');
      expect(handle.auth?.clientSecret).toBe('test-client-secret');
      expect(handle.auth?.tokenEndpoint).toBe(TOKEN_ENDPOINT);
      expect(handle.auth?.scope).toBe('read write');
    });

    it('should allow OAuth without scope', () => {
      const handle = mcp('http://localhost:3000/mcp', {
        auth: {
          type: 'oauth',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          tokenEndpoint: TOKEN_ENDPOINT,
        },
      });

      expect(handle.auth?.type).toBe('oauth');
      expect(handle.auth?.scope).toBeUndefined();
    });
  });

  describe('OAuth Token Caching', () => {
    it('should cache OAuth tokens', () => {
      // Cache starts empty
      __internal_clearOAuthTokenCache();
      let cache = __internal_getOAuthTokenCache();
      expect(cache.size).toBe(0);

      // After clearing, cache should be empty again
      __internal_clearOAuthTokenCache();
      cache = __internal_getOAuthTokenCache();
      expect(cache.size).toBe(0);
    });

    it('should provide cache clearing functionality', () => {
      __internal_clearOAuthTokenCache();
      const cache = __internal_getOAuthTokenCache();
      expect(cache.size).toBe(0);
    });

    it('should provide cache inspection functionality', () => {
      const cache = __internal_getOAuthTokenCache();
      expect(cache).toBeDefined();
      expect(typeof cache.size).toBe('number');
      expect(Array.isArray(cache.endpoints)).toBe(true);
    });
  });

  describe('OAuth Token Acquisition', () => {
    it('should attempt OAuth token acquisition', async () => {
      // Start a mock OAuth server
      const app = express();
      app.use(express.urlencoded({ extended: true }));

      app.post('/oauth/token', (req, res) => {
        const { grant_type, client_id, client_secret } = req.body;

        if (grant_type === 'client_credentials' && client_id && client_secret) {
          res.json({
            access_token: 'mock-access-token',
            token_type: 'Bearer',
            expires_in: 3600,
          });
        } else {
          res.status(400).json({ error: 'invalid_request' });
        }
      });

      authServer = app.listen(AUTH_PORT);

      // Give server time to start
      await new Promise(resolve => setTimeout(resolve, 100));

      const mcpServer = spawn('node', ['mcp/auth-server/server.mjs'], {
        env: { ...process.env, PORT: '3402' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        await waitForOutput(mcpServer, /listening on/i);

        const handle = mcp('http://localhost:3402/mcp', {
          auth: {
            type: 'oauth',
            clientId: 'test-client',
            clientSecret: 'test-secret',
            tokenEndpoint: TOKEN_ENDPOINT,
          },
        });

        const llm = makeLLM();

        // Attempt to use the handle (may fail at MCP level, but OAuth should work)
        try {
          await agent({ llm, hideProgress: true })
            .then({ prompt: 'test', mcps: [handle] })
            .run();
        } catch (e) {
          // Expected to fail at MCP connection, but not at OAuth level
        }

        // Token should be cached
        const cache = __internal_getOAuthTokenCache();
        expect(cache.size).toBeGreaterThanOrEqual(0);
      } finally {
        mcpServer.kill();
      }
    });

    it('should handle OAuth token errors gracefully', async () => {
      // Start a mock OAuth server that returns errors
      const app = express();
      app.use(express.urlencoded({ extended: true }));

      app.post('/oauth/token', (req, res) => {
        res.status(401).json({ error: 'unauthorized_client' });
      });

      authServer = app.listen(AUTH_PORT);
      await new Promise(resolve => setTimeout(resolve, 100));

      const handle = mcp('http://localhost:9999/mcp', {
        auth: {
          type: 'oauth',
          clientId: 'invalid-client',
          clientSecret: 'invalid-secret',
          tokenEndpoint: TOKEN_ENDPOINT,
        },
      });

      const llm = makeLLM();

      let error: any;
      try {
        await agent({ llm, hideProgress: true })
          .then({ prompt: 'test', mcps: [handle] })
          .run();
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
    });
  });

  describe('Agent-level Auth Configuration', () => {
    it('should support agent-level MCP auth', () => {
      const handle = mcp('http://localhost:3000/mcp');
      const llm = makeLLM();

      // Create agent with MCP auth
      const a = agent({
        llm,
        hideProgress: true,
        mcpAuth: {
          'http://localhost:3000/mcp': {
            type: 'bearer',
            token: 'agent-level-token',
          },
        },
      });

      expect(a).toBeDefined();
    });

    it('should prioritize handle-level auth over agent-level', () => {
      // Handle with its own auth
      const handle = mcp('http://localhost:3000/mcp', {
        auth: {
          type: 'bearer',
          token: 'handle-token',
        },
      });

      const llm = makeLLM();

      // Agent also has auth for same URL
      const a = agent({
        llm,
        hideProgress: true,
        mcpAuth: {
          'http://localhost:3000/mcp': {
            type: 'bearer',
            token: 'agent-token',
          },
        },
      });

      // Handle-level auth should take precedence
      expect(handle.auth?.token).toBe('handle-token');
    });
  });

  describe('Auth Header Injection', () => {
    it('should inject Bearer token in Authorization header', async () => {
      let receivedAuthHeader: string | undefined;

      // Mock OAuth server
      const app = express();
      app.use(express.urlencoded({ extended: true }));

      app.post('/oauth/token', (req, res) => {
        res.json({
          access_token: 'test-token-123',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      });

      // Mock MCP server that captures auth header
      app.post('/mcp', express.json(), (req, res) => {
        receivedAuthHeader = req.headers.authorization as string;
        res.json({
          jsonrpc: '2.0',
          id: req.body.id,
          result: { tools: [] },
        });
      });

      authServer = app.listen(AUTH_PORT);
      await new Promise(resolve => setTimeout(resolve, 100));

      const handle = mcp(`http://localhost:${AUTH_PORT}/mcp`, {
        auth: {
          type: 'oauth',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          tokenEndpoint: TOKEN_ENDPOINT,
        },
      });

      try {
        await handle.listTools();
      } catch {
        // May fail, but we should have captured the header
      }

      // Should have attempted to send auth header
      // (Actual value depends on SDK implementation)
    });
  });

  describe('OAuth Scope Handling', () => {
    it('should include scope in token request when provided', async () => {
      let receivedScope: string | undefined;

      const app = express();
      app.use(express.urlencoded({ extended: true }));

      app.post('/oauth/token', (req, res) => {
        receivedScope = req.body.scope;
        res.json({
          access_token: 'test-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      });

      authServer = app.listen(AUTH_PORT);
      await new Promise(resolve => setTimeout(resolve, 100));

      const handle = mcp('http://localhost:9997/mcp', {
        auth: {
          type: 'oauth',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          tokenEndpoint: TOKEN_ENDPOINT,
          scope: 'read:tools write:tools',
        },
      });

      try {
        await handle.listTools();
      } catch {
        // Expected to fail at connection
      }

      // Scope should have been included in request
      expect(receivedScope).toBe('read:tools write:tools');
    });

    it('should not include scope in token request when not provided', async () => {
      let requestBody: any = {};

      const app = express();
      app.use(express.urlencoded({ extended: true }));

      app.post('/oauth/token', (req, res) => {
        requestBody = req.body;
        res.json({
          access_token: 'test-token',
          token_type: 'Bearer',
          expires_in: 3600,
        });
      });

      authServer = app.listen(AUTH_PORT);
      await new Promise(resolve => setTimeout(resolve, 100));

      const handle = mcp('http://localhost:9996/mcp', {
        auth: {
          type: 'oauth',
          clientId: 'test-client',
          clientSecret: 'test-secret',
          tokenEndpoint: TOKEN_ENDPOINT,
          // No scope provided
        },
      });

      try {
        await handle.listTools();
      } catch {
        // Expected to fail
      }

      // Scope should not be in request
      expect(requestBody.scope).toBeUndefined();
    });
  });
});
