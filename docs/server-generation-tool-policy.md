# Server Generation Tool Policy

Current server-owned generation tool support in Node mode:

| Category | Status | Notes |
| --- | --- | --- |
| `rollDice` | Supported server-native | Executed by `server/node/generation/toolRunner.cjs` |
| Plugin MCP tools | Unsupported | Browser/plugin sandbox is not available on the server |
| Filesystem MCP tools | Unsupported | Client-only/browser/Desktop assumptions |
| Google Search MCP tools | Unsupported in server generation | Requires interactive credential bootstrap in the client |
| Graph memory MCP tools | Unsupported in server generation | Depends on client chat-var state |

Behavior:

- unsupported tools are filtered out of server-owned generation requests
- generation jobs emit `provider_warning` events listing skipped tools
- supported tools run server-side and emit `tool_call_started` / `tool_call_finished`
