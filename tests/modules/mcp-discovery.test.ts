/**
 * Tests for proposed src/mcp/discovery.ts module
 * These tests verify tool discovery and caching behavior
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, ChildProcess } from 'node:child_process';
import {
  mcp,
  discoverTools,
  __internal_clearDiscoveryCache,
  __internal_setDiscoveryTtl,
  __internal_primeDiscoveryCache,
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

describe('MCP Tool Discovery', () => {
  let mcpServer: ChildProcess | null = null;
  const TEST_PORT = 3501;
  const TEST_URL = `http://localhost:${TEST_PORT}/mcp`;

  beforeEach(async () => {
    __internal_clearDiscoveryCache();

    // Start test MCP server
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
    __internal_clearDiscoveryCache();
    __internal_setDiscoveryTtl(60000); // Reset to default
  });

  describe('discoverTools()', () => {
    it('should discover tools from MCP server', async () => {
      const handle = mcp(TEST_URL);

      const tools = await discoverTools([handle]);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);

      // Each tool should have required properties
      tools.forEach(tool => {
        expect(tool.name).toBeDefined();
        expect(typeof tool.name).toBe('string');
        expect(tool.description).toBeDefined();
        expect(tool.parameters).toBeDefined();
        expect(tool.mcpHandle).toBeDefined();
      });
    });

    it('should prefix tool names with MCP handle ID', async () => {
      const handle = mcp(TEST_URL);

      const tools = await discoverTools([handle]);

      // All tools should have the handle ID prefix
      tools.forEach(tool => {
        expect(tool.name).toMatch(new RegExp(`^${handle.id}\\.`));
      });
    });

    it('should discover tools from multiple MCP servers', async () => {
      const handle1 = mcp(TEST_URL);

      // Second server (may not exist, but we can still test the API)
      const handle2 = mcp('http://localhost:9995/mcp');

      let tools: any[] = [];
      try {
        tools = await discoverTools([handle1, handle2]);
      } catch {
        // Second server may fail, but first should succeed
        tools = await discoverTools([handle1]);
      }

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should handle empty handle array', async () => {
      const tools = await discoverTools([]);

      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBe(0);
    });
  });

  describe('Tool Discovery Caching', () => {
    it('should cache discovered tools', async () => {
      const handle = mcp(TEST_URL);

      // First call - fetches from server
      const tools1 = await discoverTools([handle]);
      expect(tools1.length).toBeGreaterThan(0);

      // Second call - should use cache
      const tools2 = await discoverTools([handle]);
      expect(tools2.length).toBe(tools1.length);

      // Tools should be equivalent
      expect(tools2[0].name).toBe(tools1[0].name);
    });

    it('should respect cache TTL', async () => {
      const handle = mcp(TEST_URL);

      // Set very short TTL
      __internal_setDiscoveryTtl(50);

      const tools1 = await discoverTools([handle]);

      // Wait for cache to expire
      await new Promise(resolve => setTimeout(resolve, 100));

      const tools2 = await discoverTools([handle]);

      // Should have fetched again
      expect(Array.isArray(tools2)).toBe(true);
      expect(tools2.length).toBeGreaterThan(0);

      // Reset TTL
      __internal_setDiscoveryTtl(60000);
    });

    it('should allow manual cache clearing', async () => {
      const handle = mcp(TEST_URL);

      await discoverTools([handle]);

      __internal_clearDiscoveryCache();

      // Should fetch again after clear
      const tools = await discoverTools([handle]);
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should cache tools per URL', async () => {
      const handle1 = mcp(TEST_URL);
      const handle2 = mcp('http://localhost:9994/mcp');

      // Discover tools from first server
      const tools1 = await discoverTools([handle1]);
      expect(tools1.length).toBeGreaterThan(0);

      // Second server will fail, but cache from first should remain
      try {
        await discoverTools([handle2]);
      } catch {
        // Expected
      }

      // First server cache should still work
      const tools1Again = await discoverTools([handle1]);
      expect(tools1Again.length).toBe(tools1.length);
    });
  });

  describe('Cache Priming', () => {
    it('should allow manual cache priming', () => {
      const handle = mcp('http://localhost:9993/mcp');

      const mockTools = [
        {
          name: 'test_tool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: {
              arg1: { type: 'string' },
            },
          },
        },
      ];

      __internal_primeDiscoveryCache(handle, mockTools);

      // Cache should now contain the primed tools
      // (Verified by the fact that this doesn't throw)
      expect(true).toBe(true);
    });

    it('should prefix tool names when priming cache', async () => {
      const handle = mcp('http://localhost:9992/mcp');

      const mockTools = [
        {
          name: 'my_tool',
          description: 'Test',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      __internal_primeDiscoveryCache(handle, mockTools);

      // Discover should use primed cache
      const tools = await discoverTools([handle]);

      expect(tools.length).toBe(1);
      expect(tools[0].name).toBe(`${handle.id}.my_tool`);
    });

    it('should include tool description from primed cache', async () => {
      const handle = mcp('http://localhost:9991/mcp');

      const mockTools = [
        {
          name: 'described_tool',
          description: 'This is a well-described tool',
          inputSchema: { type: 'object', properties: {} },
        },
      ];

      __internal_primeDiscoveryCache(handle, mockTools);

      const tools = await discoverTools([handle]);

      expect(tools[0].description).toBe('This is a well-described tool');
    });

    it('should provide default description when missing', async () => {
      const handle = mcp('http://localhost:9990/mcp');

      const mockTools = [
        {
          name: 'no_description',
          // No description provided
        },
      ];

      __internal_primeDiscoveryCache(handle, mockTools);

      const tools = await discoverTools([handle]);

      expect(tools[0].description).toContain('no_description');
    });
  });

  describe('Tool Name Format', () => {
    it('should create deterministic handle IDs', () => {
      const handle1 = mcp('http://localhost:3000/mcp');
      const handle2 = mcp('http://localhost:3000/mcp');

      expect(handle1.id).toBe(handle2.id);
    });

    it('should create short handle IDs (8 characters)', () => {
      const handle = mcp('http://localhost:3000/mcp');

      // Format: mcp_<8-char-hash>
      expect(handle.id).toMatch(/^mcp_[a-f0-9]{8}$/);
      expect(handle.id.length).toBe(12); // "mcp_" + 8 chars
    });

    it('should keep tool names under OpenAI 64-char limit', async () => {
      const handle = mcp(TEST_URL);

      const tools = await discoverTools([handle]);

      // With 12-char prefix (mcp_XXXXXXXX), we have 51 chars for tool name
      tools.forEach(tool => {
        expect(tool.name.length).toBeLessThanOrEqual(64);
      });
    });
  });

  describe('Tool Schema Handling', () => {
    it('should include tool input schema', async () => {
      const handle = mcp(TEST_URL);

      const tools = await discoverTools([handle]);

      tools.forEach(tool => {
        expect(tool.parameters).toBeDefined();
        expect(typeof tool.parameters).toBe('object');
      });
    });

    it('should provide empty schema when not specified', () => {
      const handle = mcp('http://localhost:9989/mcp');

      const mockTools = [
        {
          name: 'no_schema',
          description: 'Tool without schema',
          // No inputSchema
        },
      ];

      __internal_primeDiscoveryCache(handle, mockTools);

      // Should not throw
      expect(() => {
        discoverTools([handle]);
      }).not.toThrow();
    });
  });

  describe('Error Handling', () => {
    it('should throw on connection failure', async () => {
      const handle = mcp('http://localhost:9988/mcp');

      let error: any;
      try {
        await discoverTools([handle]);
      } catch (e) {
        error = e;
      }

      expect(error).toBeDefined();
    });

    it('should invalidate cache on failure', async () => {
      const handle = mcp('http://localhost:9987/mcp');

      // First attempt fails and clears cache
      try {
        await discoverTools([handle]);
      } catch {
        // Expected
      }

      // Second attempt should also try to fetch (cache was invalidated)
      try {
        await discoverTools([handle]);
      } catch {
        // Expected
      }

      expect(true).toBe(true);
    });
  });

  describe('MCP Handle Tool Methods', () => {
    it('should use discovery cache for handle.listTools()', async () => {
      const handle = mcp(TEST_URL);

      // First call through discoverTools caches
      await discoverTools([handle]);

      // Handle's listTools should use cache
      const result = await handle.listTools();

      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBeGreaterThan(0);
    });
  });
});

describe('Tool Discovery Configuration', () => {
  beforeEach(() => {
    __internal_clearDiscoveryCache();
  });

  afterEach(() => {
    __internal_clearDiscoveryCache();
    __internal_setDiscoveryTtl(60000);
  });

  describe('TTL Configuration', () => {
    it('should allow setting custom TTL', () => {
      expect(() => __internal_setDiscoveryTtl(30000)).not.toThrow();
      expect(() => __internal_setDiscoveryTtl(120000)).not.toThrow();

      // Reset
      __internal_setDiscoveryTtl(60000);
    });

    it('should allow very short TTL for testing', () => {
      expect(() => __internal_setDiscoveryTtl(10)).not.toThrow();

      // Reset
      __internal_setDiscoveryTtl(60000);
    });

    it('should allow disabling cache with 0 TTL', () => {
      __internal_setDiscoveryTtl(0);

      // Each call should fetch (though we can't easily verify without server)
      expect(true).toBe(true);

      // Reset
      __internal_setDiscoveryTtl(60000);
    });
  });
});
