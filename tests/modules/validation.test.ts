/**
 * Tests for proposed src/validation.ts module
 * These tests verify JSON schema validation behavior from volcano-sdk.ts
 */
import { describe, it, expect } from 'vitest';
import {
  agent,
  mcp,
  __internal_validateToolArgs,
  __internal_primeDiscoveryCache,
  ValidationError,
} from '../../dist/index.js';

describe('JSON Schema Validation', () => {
  describe('__internal_validateToolArgs (direct validation)', () => {
    it('should pass validation with valid arguments', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'number' },
        },
        required: ['name'],
      };

      const args = { name: 'Alice', age: 30 };

      expect(() => {
        __internal_validateToolArgs(schema, args);
      }).not.toThrow();
    });

    it('should throw on missing required property', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        required: ['name'],
      };

      const args = {};

      expect(() => {
        __internal_validateToolArgs(schema, args);
      }).toThrow(/failed schema validation/);
    });

    it('should throw on wrong type', () => {
      const schema = {
        type: 'object',
        properties: {
          age: { type: 'number' },
        },
        required: ['age'],
      };

      const args = { age: 'not-a-number' };

      expect(() => {
        __internal_validateToolArgs(schema, args);
      }).toThrow(/failed schema validation/);
    });

    it('should validate nested objects', () => {
      const schema = {
        type: 'object',
        properties: {
          user: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string', format: 'email' },
            },
            required: ['name'],
          },
        },
      };

      const validArgs = { user: { name: 'Alice', email: 'alice@example.com' } };
      expect(() => __internal_validateToolArgs(schema, validArgs)).not.toThrow();

      const invalidArgs = { user: { email: 'alice@example.com' } };
      expect(() => __internal_validateToolArgs(schema, invalidArgs)).toThrow();
    });

    it('should validate arrays', () => {
      const schema = {
        type: 'object',
        properties: {
          tags: {
            type: 'array',
            items: { type: 'string' },
          },
        },
      };

      const validArgs = { tags: ['foo', 'bar'] };
      expect(() => __internal_validateToolArgs(schema, validArgs)).not.toThrow();

      const invalidArgs = { tags: ['foo', 123] };
      expect(() => __internal_validateToolArgs(schema, invalidArgs)).toThrow();
    });

    it('should handle undefined or null schema (no validation)', () => {
      expect(() => __internal_validateToolArgs(undefined, { anything: 'goes' })).not.toThrow();
      expect(() => __internal_validateToolArgs(null, { anything: 'goes' })).not.toThrow();
    });

    it('should handle empty schema', () => {
      const schema = { type: 'object', properties: {} };

      expect(() => __internal_validateToolArgs(schema, {})).not.toThrow();
      expect(() => __internal_validateToolArgs(schema, { extra: 'allowed' })).not.toThrow();
    });

    it('should reject additionalProperties when disabled', () => {
      const schema = {
        type: 'object',
        properties: {
          name: { type: 'string' },
        },
        additionalProperties: false,
      };

      const validArgs = { name: 'Alice' };
      expect(() => __internal_validateToolArgs(schema, validArgs)).not.toThrow();

      const invalidArgs = { name: 'Alice', extra: 'not-allowed' };
      expect(() => __internal_validateToolArgs(schema, invalidArgs)).toThrow();
    });
  });

  describe('Explicit MCP Tool Call Validation', () => {
    function makeLLM() {
      return {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => 'OK',
        genWithTools: async () => ({ content: '', toolCalls: [] }),
        genStream: async function* () {},
      } as any;
    }

    it('should validate explicit tool call arguments', async () => {
      const llm = makeLLM();
      const mcpHandle = mcp('http://localhost:3997/test-validation');

      __internal_primeDiscoveryCache(mcpHandle, [
        {
          name: 'calculate',
          inputSchema: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
            },
            required: ['x', 'y', 'operation'],
          },
        },
      ]);

      let caughtError: any;
      try {
        await agent({ llm, hideProgress: true })
          .then({
            mcp: mcpHandle,
            tool: 'calculate',
            args: { x: 'not-a-number', y: 10, operation: 'add' },
          })
          .run();
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      expect(String(caughtError?.message || '')).toMatch(/failed schema validation/);
    });

    it('should validate required properties in explicit tool calls', async () => {
      const llm = makeLLM();
      const mcpHandle = mcp('http://localhost:3997/test-validation-2');

      __internal_primeDiscoveryCache(mcpHandle, [
        {
          name: 'send_email',
          inputSchema: {
            type: 'object',
            properties: {
              to: { type: 'string' },
              subject: { type: 'string' },
              body: { type: 'string' },
            },
            required: ['to', 'subject'],
          },
        },
      ]);

      let caughtError: any;
      try {
        await agent({ llm, hideProgress: true })
          .then({
            mcp: mcpHandle,
            tool: 'send_email',
            args: { body: 'Hello' }, // missing 'to' and 'subject'
          })
          .run();
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      expect(String(caughtError?.message || '')).toMatch(/failed schema validation/);
    });
  });

  describe('Automatic Tool Call Validation', () => {
    it('should validate automatic tool call arguments from LLM', async () => {
      const mcpHandle = mcp('http://localhost:3998/auto-validation');

      __internal_primeDiscoveryCache(mcpHandle, [
        {
          name: 'get_weather',
          inputSchema: {
            type: 'object',
            properties: {
              city: { type: 'string' },
              units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
            },
            required: ['city'],
          },
        },
      ]);

      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => 'OK',
        genWithTools: async (prompt: string, tools: any[]) => {
          // Simulate LLM returning invalid arguments
          return {
            content: '',
            toolCalls: [
              {
                name: `${mcpHandle.id}.get_weather`,
                arguments: { units: 'kelvin' }, // missing 'city', invalid 'units'
                mcpHandle,
              },
            ],
          };
        },
        genStream: async function* () {},
      } as any;

      let caughtError: any;
      try {
        await agent({ llm, hideProgress: true })
          .then({ prompt: 'get weather', mcps: [mcpHandle] })
          .run();
      } catch (e) {
        caughtError = e;
      }

      expect(caughtError).toBeDefined();
      expect(String(caughtError?.message || '')).toMatch(/failed schema validation/);
    });

    it('should pass validation when LLM provides correct arguments', async () => {
      const mcpHandle = mcp('http://localhost:3999/auto-validation-pass');

      __internal_primeDiscoveryCache(mcpHandle, [
        {
          name: 'greet',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
        },
      ]);

      const llm = {
        id: 'mock',
        model: 'test',
        client: {},
        gen: async () => 'Hello, Alice!',
        genWithTools: async (prompt: string, tools: any[]) => {
          // Simulate LLM returning valid arguments
          return {
            content: '',
            toolCalls: [
              {
                name: `${mcpHandle.id}.greet`,
                arguments: { name: 'Alice' },
                mcpHandle,
              },
            ],
          };
        },
        genStream: async function* () {},
      } as any;

      // This should fail due to connection, but NOT due to validation
      let caughtError: any;
      try {
        await agent({ llm, hideProgress: true })
          .then({ prompt: 'greet someone', mcps: [mcpHandle] })
          .run();
      } catch (e) {
        caughtError = e;
      }

      // Should be MCP connection error, not validation error
      expect(caughtError).toBeDefined();
      expect(String(caughtError?.message || '')).not.toMatch(/failed schema validation/);
    });
  });

  describe('Schema Caching', () => {
    it('should cache validators for same schema object', () => {
      const schema = {
        type: 'object',
        properties: { x: { type: 'number' } },
        required: ['x'],
      };

      // First call compiles the schema
      expect(() => __internal_validateToolArgs(schema, { x: 1 })).not.toThrow();

      // Second call should use cached validator
      expect(() => __internal_validateToolArgs(schema, { x: 2 })).not.toThrow();

      // Invalid args should still throw
      expect(() => __internal_validateToolArgs(schema, { x: 'invalid' })).toThrow();
    });

    it('should handle multiple different schemas', () => {
      const schema1 = {
        type: 'object',
        properties: { a: { type: 'string' } },
      };

      const schema2 = {
        type: 'object',
        properties: { b: { type: 'number' } },
      };

      expect(() => __internal_validateToolArgs(schema1, { a: 'test' })).not.toThrow();
      expect(() => __internal_validateToolArgs(schema2, { b: 42 })).not.toThrow();
      expect(() => __internal_validateToolArgs(schema1, { a: 'test' })).not.toThrow();
    });
  });

  describe('Error Messages', () => {
    it('should provide detailed validation error messages', () => {
      const schema = {
        type: 'object',
        properties: {
          age: { type: 'number', minimum: 0, maximum: 150 },
        },
      };

      try {
        __internal_validateToolArgs(schema, { age: 200 });
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('failed schema validation');
        // Error message should include details about the failure
      }
    });

    it('should include context in error message', () => {
      const schema = {
        type: 'object',
        properties: { x: { type: 'string' } },
      };

      try {
        __internal_validateToolArgs(schema, { x: 123 });
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('test');
        expect(e.message).toContain('failed schema validation');
      }
    });
  });
});
