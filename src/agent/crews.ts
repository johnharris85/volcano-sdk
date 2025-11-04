// src/agent/crews.ts
// Multi-agent crew coordination

import type { AgentBuilder } from "./types.js";

/**
 * Build agent context string for multi-agent coordination.
 */
export function buildAgentContext(agents: AgentBuilder[]): string {
  const agentList = agents
    .filter(a => a.name && a.description)
    .map(a => `- ${a.name}: ${a.description}`)
    .join('\n');

  return `

Available agents to help you:
${agentList}

To delegate to an agent, respond with: USE [agent_name]: [specific task for that agent]
When you have the final answer, respond with: DONE: [your final answer]
`;
}

/**
 * Parse coordinator LLM response for agent delegation.
 */
export function parseAgentDecision(response: string):
  | { type: 'use_agent'; agentName: string; task: string }
  | { type: 'done'; answer: string }
  | { type: 'continue'; raw: string }
{
  const useMatch = response.match(/USE\s+(\w+):\s*(.+?)(?=\n(?:USE|DONE:)|$)/s);
  if (useMatch) {
    return {
      type: 'use_agent',
      agentName: useMatch[1].trim(),
      task: useMatch[2].trim()
    };
  }

  const doneMatch = response.match(/DONE:\s*(.+)/s);
  if (doneMatch) {
    return {
      type: 'done',
      answer: doneMatch[1].trim()
    };
  }

  return {
    type: 'continue',
    raw: response
  };
}
