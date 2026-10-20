// Cursor agent hooks -> Agent Floor events.
// Cursor writes a JSON payload to the hook's stdin. We only subscribe to hooks
// that observe (after*, stop, preCompact, beforeSubmitPrompt) so Agent Floor can never change
// a permission decision. See docs/integrations.md for the hooks.json snippet.
import { basename } from 'node:path';
import { shortId, teamFromCwd } from './common.mjs';

export function fromCursor(input) {
  if (!input || typeof input !== 'object') return [];
  const root = Array.isArray(input.workspace_roots) ? input.workspace_roots[0] : undefined;
  const base = {
    agent: `cursor:${shortId(input.conversation_id)}`,
    team: teamFromCwd(root),
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
    case 'preCompact':
      return [{ type: 'status', ...base, status: 'thinking', activity: 'Tidying up memory' }];
    case 'stop':
      return [
        {
          type: 'status',
          ...base,
          status: input.status === 'error' ? 'error' : 'idle',
          activity: input.status === 'error' ? 'Stopped with an error' : 'Waiting for you',
        },
      ];
    default:
      return [];
  }
}

/** What each Cursor hook must print on stdout. Observing hooks print nothing. */
export function cursorResponse(hookName) {
  if (hookName === 'beforeSubmitPrompt') return JSON.stringify({ continue: true });
  return '';
}
