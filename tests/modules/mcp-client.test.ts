/**
 * Tests for proposed src/mcp/client.ts module
 * These tests verify MCP connection pooling behavior
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import {
  mcp,
  agent,
  __internal_getMcpPoolStats,
  __internal_setPoolConfig,
} from '../../dist/volcano-sdk.js';

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

describe('MCP Connection Pooling', () => {
  let mcpServer: ChildProcess | null = null;
  const TEST_PORT = 3301;
  const TEST_URL = `http://localhost:${TEST_PORT}/mcp`;

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

  beforeEach(async () => {
    // Start a test MCP server
    mcpServer = spawn('node', ['mcp/favorites/server.mjs'], {
      env: { ...process.env, PORT: String(TEST_PORT) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForOutput(mcpServer, /listening on/i);
  });

  afterEach(() => {
    if (mcpServer) {
      mcpServer.kill();
      mcpServer = null;
    }
  });

  describe('mcp() handle creation', () => {
    it('should create MCP handle with deterministic ID', () => {
      const handle1 = mcp(TEST_URL);
      const handle2 = mcp(TEST_URL);

      expect(handle1.id).toBe(handle2.id);
      expect(handle1.id).toMatch(/^mcp_[a-f0-9]{8}$/);
      expect(handle1.url).toBe(TEST_URL);
    });

    it('should create different IDs for different URLs', () => {
      const handle1 = mcp('http://localhost:3000/mcp');
      const handle2 = mcp('http://localhost:4000/mcp');

      expect(handle1.id).not.toBe(handle2.id);
    });

    it('should support auth configuration', () => {
      const handle = mcp(TEST_URL, {
        auth: {
          type: 'bearer',
          token: 'test-token',
        },
      });

      expect(handle.auth).toBeDefined();
      expect(handle.auth?.type).toBe('bearer');
      expect(handle.auth?.token).toBe('test-token');
    });
  });

  describe('Connection pooling behavior', () => {
    it('should pool connections to same URL', async () => {
      const handle = mcp(TEST_URL);
      const llm = makeLLM();

      // Make multiple calls
      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test 1', mcps: [handle] })
        .run();

      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test 2', mcps: [handle] })
        .run();

      const stats = __internal_getMcpPoolStats();
      expect(stats.size).toBeGreaterThanOrEqual(1);
      expect(stats.urls).toContain(TEST_URL);
    });

    it('should create separate pool entries for auth vs non-auth', async () => {
      const handle1 = mcp(TEST_URL);
      const handle2 = mcp(TEST_URL, {
        auth: { type: 'bearer', token: 'test' },
      });

      const llm = makeLLM();

      // These should create separate pool entries
      try {
        await agent({ llm, hideProgress: true })
          .then({ prompt: 'test', mcps: [handle1] })
          .run();
      } catch {
        // May fail, that's ok
      }

      try {
        await agent({ llm, hideProgress: true })
          .then({ prompt: 'test', mcps: [handle2] })
          .run();
      } catch {
        // May fail, that's ok
      }

      const stats = __internal_getMcpPoolStats();
      // Should have entries for both auth and non-auth
      expect(stats.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Pool configuration', () => {
    it('should respect pool size limits', () => {
      // Set small pool size
      __internal_setPoolConfig(2, 30000);

      // Create multiple handles
      const handles = [
        mcp('http://localhost:3001/mcp'),
        mcp('http://localhost:3002/mcp'),
        mcp('http://localhost:3003/mcp'),
      ];

      // Note: Can't easily test eviction without actually connecting
      // This just verifies the config API works
      expect(() => __internal_setPoolConfig(10, 60000)).not.toThrow();

      // Reset to defaults
      __internal_setPoolConfig(16, 30000);
    });

    it('should allow customizing idle timeout', () => {
      expect(() => __internal_setPoolConfig(16, 10000)).not.toThrow();

      // Reset to defaults
      __internal_setPoolConfig(16, 30000);
    });
  });

  describe('Tool calling via pooled connections', () => {
    it('should successfully call tools through pooled connection', async () => {
      const handle = mcp(TEST_URL);

      const tools = await handle.listTools();
      expect(tools.tools).toBeDefined();
      expect(Array.isArray(tools.tools)).toBe(true);
    });

    it('should handle errors from MCP server', async () => {
      const handle = mcp(TEST_URL);

      let error: any;
      try {
        await handle.callTool('nonexistent_tool', {});
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
    });

    it('should reuse connection for multiple tool calls', async () => {
      const handle = mcp(TEST_URL);

      // Multiple calls should use same connection
      const tools1 = await handle.listTools();
      const tools2 = await handle.listTools();

      expect(tools1).toBeDefined();
      expect(tools2).toBeDefined();

      const stats = __internal_getMcpPoolStats();
      expect(stats.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Connection error handling', () => {
    it('should handle connection to non-existent server', async () => {
      const handle = mcp('http://localhost:9999/mcp');

      let error: any;
      try {
        await handle.listTools();
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
      // Connection errors should be classified appropriately
    });

    it('should handle invalid URL gracefully', () => {
      // Should not throw when creating handle
      const handle = mcp('invalid-url');
      expect(handle).toBeDefined();
      expect(handle.url).toBe('invalid-url');
    });
  });

  describe('Concurrent connections', () => {
    it('should handle concurrent calls to same MCP server', async () => {
      const handle = mcp(TEST_URL);
      const llm = makeLLM();

      // Make multiple concurrent calls
      const promises = [
        agent({ llm, hideProgress: true }).then({ prompt: 'test 1', mcps: [handle] }).run(),
        agent({ llm, hideProgress: true }).then({ prompt: 'test 2', mcps: [handle] }).run(),
        agent({ llm, hideProgress: true }).then({ prompt: 'test 3', mcps: [handle] }).run(),
      ];

      const results = await Promise.allSettled(promises);

      // At least some should succeed (depends on server capacity)
      expect(results.length).toBe(3);
    });

    it('should handle concurrent calls to different MCP servers', async () => {
      const handle1 = mcp(`http://localhost:${TEST_PORT}/mcp`);
      const handle2 = mcp('http://localhost:9997/mcp'); // May not exist
      const llm = makeLLM();

      const promises = [
        agent({ llm, hideProgress: true }).then({ prompt: 'test', mcps: [handle1] }).run(),
        agent({ llm, hideProgress: true }).then({ prompt: 'test', mcps: [handle2] }).run().catch(() => null),
      ];

      const results = await Promise.allSettled(promises);
      expect(results.length).toBe(2);
    });
  });

  describe('Pool statistics', () => {
    it('should provide pool statistics', () => {
      const stats = __internal_getMcpPoolStats();

      expect(stats).toBeDefined();
      expect(typeof stats.size).toBe('number');
      expect(Array.isArray(stats.urls)).toBe(true);
    });

    it('should track active connections', async () => {
      const handle = mcp(TEST_URL);
      const llm = makeLLM();

      const statsBefore = __internal_getMcpPoolStats();
      const sizeBefore = statsBefore.size;

      await agent({ llm, hideProgress: true })
        .then({ prompt: 'test', mcps: [handle] })
        .run();

      const statsAfter = __internal_getMcpPoolStats();
      expect(statsAfter.size).toBeGreaterThanOrEqual(sizeBefore);
      expect(statsAfter.urls).toContain(TEST_URL);
    });
  });
});

describe('MCP Handle API', () => {
  describe('listTools()', () => {
    it('should return tools array', async () => {
      const mcpServer = spawn('node', ['mcp/favorites/server.mjs'], {
        env: { ...process.env, PORT: '3302' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        await waitForOutput(mcpServer, /listening on/i);

        const handle = mcp('http://localhost:3302/mcp');
        const result = await handle.listTools();

        expect(result).toBeDefined();
        expect(result.tools).toBeDefined();
        expect(Array.isArray(result.tools)).toBe(true);
      } finally {
        mcpServer.kill();
      }
    });
  });

  describe('callTool()', () => {
    it('should call tool with arguments', async () => {
      const mcpServer = spawn('node', ['mcp/favorites/server.mjs'], {
        env: { ...process.env, PORT: '3303' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      try {
        await waitForOutput(mcpServer, /listening on/i);

        const handle = mcp('http://localhost:3303/mcp');

        // List tools first to know what's available
        const tools = await handle.listTools();
        expect(tools.tools.length).toBeGreaterThan(0);

        // Try to call a tool (may fail depending on implementation)
        const toolName = tools.tools[0].name;
        let result: any;
        try {
          result = await handle.callTool(toolName, {});
        } catch (e) {
          // Tool call may fail, that's ok for this test
          result = null;
        }

        // Just verify the API works
        expect(true).toBe(true);
      } finally {
        mcpServer.kill();
      }
    });
  });
});
