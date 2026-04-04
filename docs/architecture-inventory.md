# Architecture Inventory: Server-Side Request Migration

Generated as part of Phase 0: Discovery and Instrumentation.

## 1. Generation-Critical Client Modules

### Primary Orchestration
| Module | Path | Role |
|--------|------|------|
| sendChat() | `src/ts/process/index.svelte.ts` | Main generation orchestrator (prompt assembly, memory, request, post-processing) |
| requestChatData() | `src/ts/process/request/request.ts` | Request dispatcher with fallback/retry/plugin hooks |
| requestChatDataMain() | `src/ts/process/request/request.ts` | Provider routing and model resolution |

### Provider Implementations
| Provider | Path | LLMFormat(s) |
|----------|------|-------------|
| Anthropic/Claude | `src/ts/process/request/anthropic.ts` | Anthropic, AnthropicLegacy, AWSBedrockClaude |
| OpenAI | `src/ts/process/request/openAI/requests.ts` | OpenAICompatible, Mistral, OpenAILegacyInstruct, OpenAIResponseAPI |
| Google/Vertex | `src/ts/process/request/google.ts` | VertexAIGemini, GoogleCloud |
| NovelAI | `src/ts/process/request/request.ts` (inline) | NovelAI |
| Ooba | `src/ts/process/request/request.ts` (inline) | Ooba, OobaLegacy |
| Kobold | `src/ts/process/request/request.ts` (inline) | Kobold |
| Ollama | `src/ts/process/request/request.ts` (inline) | Ollama |
| Cohere | `src/ts/process/request/request.ts` (inline) | Cohere |
| Horde | `src/ts/process/request/request.ts` (inline) | Horde |
| WebLLM | `src/ts/process/request/request.ts` (inline) | WebLLM |
| Plugin | `src/ts/process/request/request.ts` (inline) | Plugin |

### Memory Systems
| System | Path |
|--------|------|
| HypaMemory V2 | `src/ts/process/memory/hypav2.ts` |
| HypaMemory V3 | `src/ts/process/memory/hypav3.ts` |
| SupaMemory | `src/ts/process/memory/supaMemory.ts` |
| Hanurai Memory | `src/ts/process/memory/hanuraiMemory.ts` |

### Network Layer
| Function | Path | Purpose |
|----------|------|---------|
| globalFetch() | `src/ts/globalApi.svelte.ts` | Non-streaming fetch (proxy or direct) |
| fetchNative() | `src/ts/globalApi.svelte.ts` | Streaming fetch (WS proxy, proxy2, or direct) |
| fetchViaProxy2() | `src/ts/globalApi.svelte.ts` | Route through /proxy2 |
| fetchViaProxyJobWs() | `src/ts/globalApi.svelte.ts` | Route through WS proxy stream jobs |

## 2. All requestChatData() Call Sites

| File | Line | Mode | Purpose |
|------|------|------|---------|
| `src/ts/process/index.svelte.ts` | ~1398 | model | Main generation |
| `src/ts/process/index.svelte.ts` | ~1634 | emotion | IGP (In-Game Prompt) |
| `src/ts/process/index.svelte.ts` | ~1825 | emotion | Emotion detection |
| `src/ts/translator/translator.ts` | ~563 | translate | Translation |
| `src/ts/process/triggers.ts` | ~1478 | varies | Trigger-initiated |
| `src/ts/process/triggers.ts` | ~1905 | varies | Trigger-initiated |
| `src/ts/process/scriptings.ts` | ~541 | varies | Lua script |
| `src/ts/process/scriptings.ts` | ~587 | varies | Lua script |
| `src/ts/process/scriptings.ts` | ~911 | varies | Lua script |
| `src/ts/process/stableDiff.ts` | ~35 | varies | SD prompt |
| `src/ts/process/memory/hypav3.ts` | ~1699 | memory | Memory summarization |
| `src/ts/process/memory/hypav2.ts` | ~128 | memory | Memory summarization |
| `src/ts/process/memory/supaMemory.ts` | ~267 | memory | Memory summarization |
| `src/ts/process/mcp/aiaccess.ts` | ~62 | varies | MCP AI access tool |

## 3. Chat State Mutations During Generation

| Module | Mutations |
|--------|----------|
| index.svelte.ts | Push new messages, update streaming data, set isStreaming, increment reloadKeys, update lastMemory/lastInteraction/statics.messages |
| supaMemory.ts | Write supaMemoryData, lastMemory |
| hypav2.ts | Write hypaV2Data |
| hypav3.ts | Write hypaV3Data |
| hanuraiMemory.ts | Modify chats array and token counts |
| triggers.ts | Modify chat via runTrigger (start/output/request), set stopSending/sendAIprompt |
| scriptings.ts | runLuaEditTrigger modifies formatted prompts |
| scripts.ts | processScript/processScriptFull transform message data |
| inlayScreen.ts | Extract/modify inlay data from response text |
| prereroll.ts | Store alternative responses |
| google.ts | saveInlayedSignature, writeInlayImage, setInlayAsset during response processing |

## 4. Tool/Plugin Entry Points During Generation

### Plugin System
| Entry Point | Location | Classification |
|-------------|----------|---------------|
| pluginV2.replacerbeforeRequest | request.ts | Client-only (plugin sandbox is browser iframe) |
| pluginV2.replacerafterRequest | request.ts | Client-only |
| pluginV2.providers (requestPlugin) | request.ts | Client-only |
| bodyIntercepterStore | globalApi.svelte.ts | Client-only |

### MCP Tools
| Entry Point | Location | Classification |
|-------------|----------|---------------|
| getTools() | request.ts via mcp/mcp.ts | Server-safe (tool definitions) |
| callTool() | anthropic.ts, openAI, google.ts | Mixed (depends on tool type) |
| dice.ts | mcp/dice.ts | Server-safe |
| googlesearchclient.ts | mcp/googlesearchclient.ts | Server-safe |
| graphmem.ts | mcp/graphmem.ts | Server-safe |
| filesystemclient.ts | mcp/filesystemclient.ts | Client-only (browser FS) |
| aiaccess.ts | mcp/aiaccess.ts | Server-safe (calls requestChatData internally) |
| pluginmcp.ts | mcp/pluginmcp.ts | Client-only |

### Trigger/Script System
| Entry Point | Location | Classification |
|-------------|----------|---------------|
| runTrigger('start') | index.svelte.ts | Client-only (accesses Svelte stores) |
| runTrigger('request') | request.ts | Client-only |
| runTrigger('output') | index.svelte.ts | Client-only |
| runLuaEditTrigger('editRequest') | index.svelte.ts | Client-only (Lua VM in browser) |
| processScript/processScriptFull | index.svelte.ts | Client-only |

## 5. Server-Safe vs Client-Bound Dependencies

### Server-Safe (can move to server)
- Provider HTTP calls (Anthropic, OpenAI, Google API interactions)
- Request parameter normalization
- Chat-to-provider message serialization
- Prompt assembly helpers (once extracted from Svelte stores)
- Tool-call encoding/decoding (pure data transforms)
- Response block normalization
- Retry and timeout logic
- Batch polling (Anthropic)

### Client-Bound (must stay client-side or need bridge)
- DBState / Svelte store access
- Plugin iframe sandbox
- Lua scripting VM
- Trigger system (depends on Svelte reactivity)
- Browser filesystem MCP tools
- UI state management (isStreaming, reloadKeys)
- bodyIntercepterStore (client fetch hooks)

## 6. Server Infrastructure (Current)

| Component | Path | Purpose |
|-----------|------|---------|
| Express server | server/node/server.cjs | HTTP/HTTPS + WebSocket server |
| SQLite DB | server/node/db.cjs | KV storage (better-sqlite3, WAL mode) |
| Utils | server/node/utils.cjs | Save format encode/decode, hashing |
| Proxy stream jobs | server/node/server.cjs | WebSocket-based local network proxy |
| Auth | server/node/server.cjs | HMAC-SHA256 JWT, session cookies |
