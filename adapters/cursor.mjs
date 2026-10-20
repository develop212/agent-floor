// Cursor agent hooks -> Agent Floor events.
// Cursor writes a JSON payload to the hook's stdin. We only subscribe to hooks
// that observe (after*, stop, sessionEnd, subagent*, beforeSubmitPrompt) so
// Agent Floor can never change a permission decision. See docs/integrations.md
// for the hooks.json snippet.
import { basename } from 'node:path';
import { pretty, shortId, teamFromCwd } from './common.mjs';

export function fromCursor(input) {
  if (!input || typeof input !== 'object') return [];
  const root = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined;
  const convId = input.conversation_id || input.session_id;
  const lead = `cursor:${shortId(convId)}`;
  const team = teamFromCwd(root);
  const base = {
    agent: lead,
    team,
    source: 'cursor',
    name: process.env.AGENT_FLOOR_NAME || 'Cursor',
    role: 'Lead',
  };
  const f = (p) => (p ? basename(String(p)) : 'a file');

  switch (input.hook_event_name) {
    case 'beforeSubmitPrompt':
      return [{ type: 'status', ...base, status: 'thinking', activity: `Asked: ${input.prompt ?? ''}` }];
    case 'afterAgentThought':
      return [{ type: 'status', ...base, status: 'thinking', activity: input.text || 'Thinking' }];
    case 'afterFileEdit':
      return [{ type: 'tool', ...base, tool: 'Edit', activity: `Edited ${f(input.file_path)}` }];
    case 'beforeReadFile':
      return [{ type: 'tool', ...base, tool: 'Read', activity: `Reading ${f(input.file_path)}` }];
    case 'beforeShellExecution':
    case 'afterShellExecution':
      return [{ type: 'tool', ...base, tool: 'Shell', activity: `Running ${String(input.command ?? '').slice(0, 60)}` }];
    case 'beforeMCPExecution':
    case 'afterMCPExecution':
      return [{ type: 'tool', ...base, tool: 'MCP', activity: `MCP: ${input.tool_name ?? 'tool'}` }];
    case 'afterAgentResponse':
      return [{ type: 'status', ...base, status: 'thinking', activity: `Replied: ${input.text ?? ''}` }];
    case 'subagentStart': {
      const parentId = input.parent_conversation_id ? `cursor:${shortId(input.parent_conversation_id)}` : lead;
      const subId = input.subagent_id ? `${parentId}:${shortId(input.subagent_id, 12)}` : `${parentId}:subagent`;
      const type = input.subagent_type || 'generalPurpose';
      const desc = input.task || input.description || 'Starting task';
      return [
        { type: 'message', agent: parentId, team, source: 'cursor', to: subId, text: desc },
        {
          type: 'join',
          agent: subId,
          parent: parentId,
          team,
          source: 'cursor',
          name: pretty(type),
          role: type,
          status: 'working',
          activity: desc,
          text: desc,
        },
      ];
    }
    case 'subagentStop': {
      const parentId = input.parent_conversation_id ? `cursor:${shortId(input.parent_conversation_id)}` : lead;
      const subId = input.subagent_id ? `${parentId}:${shortId(input.subagent_id, 12)}` : `${parentId}:subagent`;
      const isErr = input.status === 'error';
      const summary = input.summary || (isErr ? 'Encountered error' : 'Task completed');
      return [
        { type: 'message', agent: subId, parent: parentId, team, source: 'cursor', to: parentId, text: summary, status: isErr ? 'error' : 'done' },
        { type: 'status', agent: subId, status: isErr ? 'error' : 'done', activity: summary },
        { type: 'status', ...base, agent: parentId, status: 'thinking', activity: `Reviewing ${pretty(input.subagent_type || 'helper')} report` },
      ];
    }
    case 'stop':
      return [
        {
          type: 'status',
          ...base,
          status: input.status === 'error' ? 'error' : 'idle',
          activity: input.status === 'error' ? 'Stopped with an error' : 'Waiting for you',
        },
      ];
    case 'sessionEnd':
      return [{ type: 'leave', ...base, activity: 'Session ended' }];
    default:
      return [];
  }
}

/** What each Cursor hook must print on stdout. Observing hooks print nothing. */
export function cursorResponse(hookName) {
  if (hookName === 'beforeSubmitPrompt') return JSON.stringify({ continue: true });
  if (hookName === 'subagentStart') return JSON.stringify({ permission: 'allow' });
  return '';
}
