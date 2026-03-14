# Cursor Remote API Reference

All endpoints require authentication via query parameter `?token=AUTH_TOKEN`, Bearer header, or session cookie — except internal `_` endpoints which are localhost-only.

**Base URL**: `http://localhost:7842` (primary window) or the cloudflared tunnel URL.

---

## Status & Configuration

### `GET /api/status`

Server status and configuration.

**Response**:
```json
{
  "version": "1.0.36",
  "workspace": "/Users/you/project",
  "workspaceName": "project",
  "injectionMethod": "patched-submit",
  "patchAvailable": true,
  "tunnelUrl": "https://xyz.trycloudflare.com",
  "boundPort": 7842,
  "registry": [{ "slug": "project-slug", "workspace": "/path", "port": 7842 }],
  "uptime": 1234.5
}
```

### `GET /api/modes-and-models`

Available Cursor modes and models.

| Query Param | Type   | Description |
|-------------|--------|-------------|
| `slug`      | string | Optional — proxy to the window owning this project |

**Response**:
```json
{
  "ok": true,
  "modes": [
    { "id": "agent", "name": "Agent", "icon": "" },
    { "id": "ask", "name": "Ask", "icon": "" }
  ],
  "models": [
    { "name": "claude-3.5-sonnet", "displayName": "Claude 3.5 Sonnet", "defaultOn": true }
  ],
  "currentMode": "agent",
  "currentModel": "claude-3.5-sonnet"
}
```

---

## Projects

### `GET /api/projects`

List all discovered projects from `~/.cursor/projects/`.

**Response**: Array of project objects:
```json
[
  {
    "slug": "users-you-documents-code-myproject",
    "name": "myproject",
    "path": "/Users/you/Documents/code/myproject",
    "chatCount": 5,
    "lastModified": 1710400000000,
    "isOrphan": false,
    "hasOpenWindow": true
  }
]
```

### `POST /api/projects/:slug/open`

Launch a Cursor window on the project folder.

**Response**: `{ "ok": true, "path": "/Users/you/project" }`

---

## Chats

### `GET /api/projects/:slug/chats`

List all chat transcripts for a project.

**Response**: Array of chat objects:
```json
[
  {
    "id": "abc123",
    "title": "Refactor auth module",
    "lastModified": 1710400000000,
    "messageCount": 42
  }
]
```

### `GET /api/projects/:slug/chats/:id`

Get full chat messages.

| Query Param | Type   | Description |
|-------------|--------|-------------|
| `since`     | number | Optional — return only messages from this index onward |

**Response**:
```json
{
  "messages": [
    { "role": "user", "content": "Fix the login bug", "timestamp": 1710400000000 },
    { "role": "assistant", "content": "I'll look at the auth module..." }
  ],
  "fromIndex": 0
}
```

### `GET /api/projects/:slug/chats/:id/poll`

Lightweight polling endpoint — returns the current file size to detect changes.

**Response**: `{ "lastModified": 123456 }`

### `GET /api/projects/:slug/chats/:id/files`

List files modified by the AI in a specific chat (parsed from transcript tool calls).

**Response**: Array of file path strings.

---

## Message Injection

### `POST /api/send`

Send a message into a Cursor chat. Uses the patched `composerChatService.submitChatMaybeAbortCurrent` when available, otherwise falls back to clipboard.

**Body**:
```json
{
  "message": "Please fix the type error in auth.ts",
  "composerId": "optional-composer-id",
  "slug": "optional-project-slug",
  "mode": "agent",
  "model": "claude-3.5-sonnet"
}
```

| Field        | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `message`    | string | Yes      | The message text to send |
| `composerId` | string | No       | Target a specific composer/chat tab (transcript ID) |
| `slug`       | string | No       | Route to the window owning this project |
| `mode`       | string | No       | Set mode before sending: `agent`, `ask`, `plan`, etc. |
| `model`      | string | No       | Override model for this message |

**Response**:
```json
{
  "success": true,
  "method": "patched-submit",
  "details": "Message submitted to composer abc123",
  "composerId": "abc123"
}
```

### `POST /api/set-text`

Set text in a composer input without submitting — for preview/review workflows.

**Body**:
```json
{
  "text": "Draft message to review",
  "composerId": "optional-composer-id",
  "slug": "optional-project-slug"
}
```

### `GET /api/composers`

Get the current composer state (open tabs, selected composer).

| Query Param | Type   | Description |
|-------------|--------|-------------|
| `slug`      | string | Optional — proxy to the correct window |

**Response**:
```json
{
  "ok": true,
  "selectedComposerId": "abc123",
  "openComposerIds": ["abc123", "def456"],
  "composers": [
    { "id": "abc123", "name": "Refactor auth", "status": "idle", "lastUpdated": 1710400000000 }
  ]
}
```

---

## Programmatic LLM Access

Query Cursor's LLM models directly — uses your existing Cursor subscription, no API keys needed. Auth is handled automatically through Cursor's session.

### `POST /api/prompt`

One-shot query using the default model via `aiService.getSimplePrompt`.

**Body**:
```json
{
  "prompt": "Summarize what TypeScript generics are in one sentence",
  "placeholder": "",
  "slug": "optional-project-slug"
}
```

| Field         | Type   | Required | Description |
|---------------|--------|----------|-------------|
| `prompt`      | string | Yes      | The query text |
| `placeholder` | string | No       | Answer placeholder hint |
| `slug`        | string | No       | Route to a specific window |

**Response**:
```json
{
  "ok": true,
  "result": "TypeScript generics allow you to write reusable, type-safe code by parameterizing types."
}
```

### `POST /api/query`

Model-selectable query via `aiClient().getPassthroughPrompt`. Sends the prompt directly to the specified model without added system prompts.

**Body**:
```json
{
  "prompt": "Explain async/await in 2 sentences",
  "model": "claude-3.5-sonnet",
  "slug": "optional-project-slug"
}
```

| Field    | Type   | Required | Description |
|----------|--------|----------|-------------|
| `prompt` | string | Yes      | The query text |
| `model`  | string | No       | Model name (from `/api/modes-and-models`). Empty = default |
| `slug`   | string | No       | Route to a specific window |

**Response**:
```json
{
  "ok": true,
  "result": "Async/await lets you write asynchronous code that reads like synchronous code..."
}
```

**Error response**:
```json
{
  "ok": false,
  "error": "Patch not applied"
}
```

### `POST /api/query/json`

Structured JSON query. Wraps the prompt with schema instructions, parses the model's response as JSON, and retries automatically if parsing fails.

**Body**:
```json
{
  "prompt": "Summarize this conversation about refactoring the auth module",
  "schema": {
    "title": "string",
    "summary": "string",
    "topics": ["string"],
    "complexity": "low | medium | high"
  },
  "model": "claude-3.5-sonnet",
  "retries": 1,
  "slug": "optional-project-slug"
}
```

| Field     | Type   | Required | Description |
|-----------|--------|----------|-------------|
| `prompt`  | string | Yes      | The query text (schema instructions are appended automatically) |
| `schema`  | object | Yes      | JSON schema / example shape the response must match |
| `model`   | string | No       | Model name (from `/api/modes-and-models`). Empty = default |
| `retries` | number | No       | Extra attempts if JSON parsing fails (default: 1, max: 3) |
| `slug`    | string | No       | Route to a specific window |

**Success response** (parsed JSON in `data`):
```json
{
  "ok": true,
  "data": {
    "title": "Auth module refactoring",
    "summary": "Migrated from session-based to JWT authentication...",
    "topics": ["authentication", "JWT", "middleware"],
    "complexity": "medium"
  },
  "raw": "{\"title\":\"Auth module refactoring\",\"summary\":\"Migrated from...\"}"
}
```

**Error response** (parse failed after all attempts):
```json
{
  "ok": false,
  "raw": "Here is the summary: {invalid json...",
  "error": "JSON parse failed after 2 attempt(s): Unexpected token H"
}
```

---

## Files & Git

### `GET /api/projects/:slug/files`

Git status and diff statistics for a project.

**Response**:
```json
{
  "changes": [
    { "status": "M", "path": "src/auth.ts" },
    { "status": "A", "path": "src/new-file.ts" }
  ],
  "stat": "2 files changed, 45 insertions(+), 12 deletions(-)"
}
```

### `GET /api/projects/:slug/files/diff`

Get the diff for a specific file.

| Query Param | Type    | Required | Description |
|-------------|---------|----------|-------------|
| `path`      | string  | Yes      | File path relative to project root |
| `staged`    | boolean | No       | Show staged diff (`true`) or unstaged (default) |

**Response**: Diff object with unified diff content.

### `GET /api/projects/:slug/files/serve`

Serve a file from the project directory (images, PDFs, etc.). Security-restricted to files within the project root.

| Query Param | Type   | Required | Description |
|-------------|--------|----------|-------------|
| `path`      | string | Yes      | File path (absolute or relative to project root) |

**Response**: The file content with appropriate MIME type. Max file size: 50 MB.

### `GET /api/projects/:slug/assets/:filename`

Serve an image asset from the project's `~/.cursor/projects/:slug/assets/` folder (chat-embedded images).

**Response**: Image binary with appropriate MIME type.

---

## Diagnostics

### `GET /api/diagnostics`

Extension health check — patch status, command availability, recommendations.

**Response**:
```json
{
  "platform": "darwin/arm64",
  "patchApplied": true,
  "patchedCommandsAvailable": true,
  "selectedComposerId": "abc123",
  "openComposerCount": 3,
  "recommendation": "Full support: patched commands available, can submit to any open composer"
}
```

### `GET /api/debug/patcher`

Detailed patcher diagnostics — candidate paths, ASAR status, filesystem probing. Useful for troubleshooting patch failures on remote machines.

### `POST /api/debug/patcher/apply`

Remotely trigger patch application (for headless/remote scenarios).

**Response**: `{ "ok": true }` or `{ "ok": false, "error": "..." }`

### `GET /api/debug/projects`

Raw project discovery data for debugging path resolution issues.

---

## Internal Endpoints (localhost-only)

These endpoints use the `/api/_` prefix and skip authentication. They are only accessible from `127.0.0.1` — requests proxied through the tunnel include a `x-forwarded-by` header that prevents auth bypass.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/_register`   | POST | Register a secondary window `{slug, workspace, port}` |
| `/api/_unregister` | POST | Unregister a window `{port}` |
| `/api/_registry`   | GET  | List all registered windows |
| `/api/_tunnel-url` | GET  | Get the tunnel URL and full authenticated URL |
| `/api/_reload`     | POST | Trigger `workbench.action.reloadWindow` on this instance |
| `/api/_reloadAll`  | POST | Reload this instance and notify all registered secondaries |

---

## Internal TypeScript API (`MessageInjector`)

When writing server-side logic within the extension (e.g. in `server.ts` or a new module), use the `MessageInjector` instance directly — no HTTP round-trip needed. The `RemoteServer` class has access via `this.injector`.

### LLM Methods

```typescript
// One-shot query, default model
const r = await this.injector.prompt("Summarize this code", "");
// r: { ok: boolean, result?: string, error?: string }

// Model-selectable query
const r = await this.injector.query("Explain async/await", "claude-3.5-sonnet");
// r: { ok: boolean, result?: string, error?: string }

// Structured JSON query with auto-parse and retry
const r = await this.injector.queryJson<MyType>(
  "Analyze this conversation",
  { title: "string", summary: "string", topics: ["string"] },
  { model: "claude-3.5-sonnet", retries: 1 }
);
// r: { ok: boolean, data?: MyType, raw?: string, error?: string }
```

### Chat Injection Methods

```typescript
// Send a message to a composer (submits immediately)
const r = await this.injector.send("Fix the bug", composerId, {
  mode: "agent",           // optional: agent, ask, plan
  modelOverride: "gpt-4o"  // optional
});
// r: { success, method, details, composerId?, error? }

// Set text without submitting (preview/review workflow)
const r = await this.injector.setText("Draft message", composerId);
// r: { success, method, details, composerId?, error? }
```

### State & Configuration Methods

```typescript
// Composer state (open tabs, selected composer)
const state = await this.injector.getComposerState();
// state: { ok, selectedComposerId?, openComposerIds?, composers?, error? }

// Available modes and models
const mm = await this.injector.getModesAndModels();
// mm: { ok, modes?, models?, currentMode?, currentModel?, error? }

// Diagnostics
const diag = await this.injector.diagnose();
// diag: { platform, patchApplied, patchedCommandsAvailable, selectedComposerId, openComposerCount, recommendation }

// Check patch status
this.injector.isPatchAvailable();  // boolean
this.injector.getMethod();         // 'patched-submit' | 'clipboard' | 'none'
```

### Frontend Helpers (`webview/app.js`)

The `API` object in the web UI provides convenience wrappers that handle token auth and JSON serialization:

```javascript
// One-shot query, default model
const r = await API.prompt("Summarize this code");
// r: { ok, result?, error? }

// Model-selectable query
const r = await API.query("Explain async/await", "claude-3.5-sonnet");
// r: { ok, result?, error? }

// Structured JSON query with auto-parse and retry
const r = await API.queryJson(
  "Analyze this conversation",
  { title: "string", summary: "string", topics: ["string"] },
  { model: "claude-3.5-sonnet", retries: 1 }
);
// r: { ok, data?, raw?, error? }
```

### When to use what

| You're writing code in... | Use |
|---------------------------|-----|
| `server.ts` or any extension-side module | `this.injector.prompt()` / `.query()` / `.queryJson()` directly |
| `webview/app.js` (browser frontend) | `API.prompt()` / `API.query()` / `API.queryJson()` |
| External tool / script / `curl` | HTTP: `POST /api/prompt`, `/api/query`, `/api/query/json` |

---

## Authentication

All public endpoints require one of:

1. **Query parameter**: `?token=AUTH_TOKEN`
2. **Bearer header**: `Authorization: Bearer AUTH_TOKEN`
3. **Session cookie**: `cr_token` (set automatically when visiting `/?token=AUTH_TOKEN` in a browser)

The auth token is generated randomly at extension startup and displayed in the status bar menu or via the QR code panel.

## Multi-Window Proxying

When multiple Cursor windows are open, the primary (port 7842) acts as a gateway. Pass the `slug` parameter on any window-specific endpoint to automatically proxy the request to the correct secondary window. The `/api/projects` response includes `hasOpenWindow` to indicate which projects have an active Cursor instance.
