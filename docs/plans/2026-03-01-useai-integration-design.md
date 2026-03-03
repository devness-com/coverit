# UseAI Integration Design

## Problem

Coverit has no session tracking. When a user runs `coverit scan`, `coverit cover`, or `coverit fix`, there's no record of the work done, time spent, or results achieved. Users in the devness ecosystem use UseAI for AI session tracking, and coverit should integrate with it.

## Approach

Call UseAI's local daemon HTTP API (`http://127.0.0.1:19200`) to create dedicated coverit sessions. The integration is **fail-silent** — if UseAI isn't installed or the daemon isn't running, coverit works exactly as before.

## Architecture

### New module: `src/integrations/useai.ts`

A lightweight HTTP client with 3 functions:

- `useaiStart(command, projectRoot)` — calls `useai_start` via daemon, returns `sessionId | null`
- `useaiEnd(sessionId, result)` — calls `useai_end` with coverit-specific milestones
- `useaiHeartbeat()` — keeps long sessions alive (15+ min scans)

All calls:
- Use `GET /health` (500ms timeout) to check daemon availability
- Use `POST /mcp` with JSON-RPC 2.0 to call UseAI tools
- Wrapped in try/catch — never throw, never block coverit's core flow
- Use a single `mcp-session-id` UUID per coverit invocation

### Protocol

```
POST http://127.0.0.1:19200/mcp
Content-Type: application/json
mcp-session-id: <uuid>

{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "useai_start",
    "arguments": { ... }
  },
  "id": 1
}
```

### Session data per command

| Command | task_type | title | milestone example |
|---------|-----------|-------|-------------------|
| scan | testing | Codebase quality scan | Scanned 12 modules, score 73/100 |
| cover | testing | Test generation | Generated 8 tests, score 65 -> 78 |
| run | testing | Test run and fix | Ran 42 tests, fixed 3, score 71 -> 75 |

Additional fields:
- `project`: directory name from `projectRoot`
- `languages`: from project detection or scan results
- `files_touched_count`: test files generated (cover) or modified (run), 0 for scan
- No `evaluation` object (no human prompt to evaluate)

### Hook points

**CLI** (`src/cli/index.ts`): Before/after each scan/cover/run handler
**MCP** (`src/mcp/server.ts`): Before/after each coverit_scan/coverit_cover/coverit_fix tool

Both use the same shared `useaiStart`/`useaiEnd` calls.

### Flow

```
coverit scan /path/to/project
  |-- useaiStart("scan", "/path/to/project")   <- returns sessionId or null
  |-- [scan: functionality, security, stability, conformance, regression]
  |-- useaiEnd(sessionId, { modules: 12, score: 73 })
  |-- show dashboard
```

### Error handling

- Daemon not running → `useaiStart` returns `null`, all subsequent calls are no-ops
- Daemon returns error → log debug message, continue normally
- Network timeout → 500ms for health check, 2s for MCP calls
- No retry logic — fire once, move on

## Files

1. **Create** `src/integrations/useai.ts` — UseAI daemon client
2. **Modify** `src/cli/index.ts` — add useai calls in scan/cover/run handlers
3. **Modify** `src/mcp/server.ts` — add useai calls in coverit_scan/coverit_cover/coverit_fix tools
