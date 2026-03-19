# Changelog

## v1.0.42 — 2026-03-19

### Fix _getConversation handle resolution
- **Patch**: `_getConversation` now tries three handle resolution methods: `getHandleIfLoaded`, `getHandleIfLoaded_MIGRATED`, and `getComposerHandleById`. Falls back through each if the previous returns null.
- **Patch**: Also tries `getComposerData(handle).conversation` as a fallback for `getLoadedConversation`.
- **Patch**: Returns debug diagnostics (which methods were tried, sample composer IDs) when handle resolution fails, enabling remote troubleshooting.
- **Server**: `/live` endpoint now logs detailed debug info including the handle resolution path taken.

## v1.0.41 — 2026-03-14

### Live data resilience fixes
- **Server**: `/live` endpoint now validates that memory bubbles contain at least one AI response before using them; falls back to disk otherwise. Added diagnostic logging.
- **Frontend**: `loadChat()` now falls back to the original `/chats/:id` endpoint if `/live` returns empty data from both memory and disk paths.
- **Frontend**: Extra `try/catch` around the `/live` call so any network or parse error gracefully degrades to disk.
- **Server**: Streaming-only conversations (user just sent a message, no AI bubble yet) are still served from memory with `isStreaming: true`.

## v1.0.40 — 2026-03-14

### Live-primary chat data
- **Live bubbles**: Chat messages are now sourced from Cursor's in-memory state when available, showing richer data than disk transcripts (tool calls, code blocks, per-bubble structure).
- **Streaming visibility**: Active agent responses appear in real-time with a blinking cursor and glow border while Cursor is generating, using 500ms adaptive polling.
- **Tool call rendering**: Tool calls (Shell, Read, Write, etc.) render as structured cards with tool name, status badge, and collapsible parameter/result sections.
- **DOM patching**: Poll updates only touch changed bubbles instead of re-rendering the full conversation, preserving scroll position.
- **Disk fallback**: Conversations not loaded in Cursor's memory automatically fall back to disk transcript rendering -- no breaking changes.
- **New patch command**: `cursorRemote._getConversation` reads `composerDataService.getLoadedConversation()` and maps each bubble with `getComposerBubble()`, including `generatingBubbleIds` for streaming detection.
- **New API endpoint**: `GET /api/projects/:slug/chats/:id/live` returns `{ source: 'memory'|'disk', isStreaming, bubbles|messages }`.

## v1.0.39 — 2026-03-10

### Premium web UI overhaul
- **Glassmorphism**: Header and footer use frosted glass backgrounds with `backdrop-filter: blur(20px)`, replacing flat solid colors.
- **Card elevation**: Project and chat list items now have layered glass surfaces with subtle shadows, scale-on-press feedback, and light-edge borders.
- **Directional navigation**: View transitions slide left/right based on navigation direction (forward = slide right, back = slide left), communicating spatial hierarchy.
- **Breadcrumb trail**: The header subtitle now shows tappable breadcrumbs (e.g. `Projects / my-project / Chat title`) for direct navigation to any depth.
- **Swipe-back gesture**: Swiping from the left edge of the screen navigates back, matching iOS native behavior.
- **Logo home shortcut**: Long-pressing the header logo jumps directly to the Projects root.
- **Staggered list entrance**: Project and chat items cascade in with a 40ms waterfall delay.
- **Message entrance**: Chat messages slide in with a subtle scale animation.
- **Branded spinner**: Loading indicator now uses brand blue + cyan dual-color.
- **Scroll FAB**: The scroll-to-bottom button uses glassmorphism with a subtle blue glow.
- **Toast animations**: Slide-in entrance and fade-out exit with glass backdrop.
- **Tab indicator**: Animated underline replaces the hard border-bottom on Chats/Files tabs.
- **Status pulse**: The green online dot has a breathing pulse animation.
- **Pending shimmer**: Remote-sent messages show a gradient shimmer while awaiting confirmation.
- **Input focus glow**: The message input gets a blue ring glow on focus.
- **Send button shadow**: Accent-colored shadow with spring press effect.
- **Typography**: Tighter view headers (-0.5px tracking), bolder role labels, refined section labels, increased message spacing.
- **Code block polish**: Gradient top edge suggesting a title bar, plus subtle drop shadow.
- **Active project glow**: Projects with a live Cursor window show a cyan border glow echoing the holographic cube brand.
- All surfaces (file items, sub-tabs, workspace banner) upgraded to glass treatment.

## v1.0.38 — 2026-03-14

### Brand identity & visual assets
- **New**: Holographic cube logo — translucent blue glass cube in isometric view with a glowing text cursor caret inside, representing a remote digital workspace.
- Generated full brand asset suite in `brand/` directory: logo on dark/light backgrounds, wordmark variants, transparent icon, icon-128, and favicon.
- Created 12-page `brand-guidelines.pdf` covering logo usage, color palette, typography, clear space rules, minimum sizes, and do's/don'ts.
- **Extension icon**: `package.json` now references `brand/icon-128.png` for the VS Code marketplace listing.
- **Web UI favicon**: `/favicon.ico` route serves the cube icon; `<link rel="icon">` and `<link rel="apple-touch-icon">` added to `index.html`.
- **PWA manifest**: `/manifest.json` now includes 128, 256, and 512px icon entries.
- **QR panel**: Shows the cube logo alongside the "Cursor Remote" heading.
- **Web UI header**: Displays the cube logo next to the title on all pages.
- Icons trimmed to remove excess whitespace for crisp display at small sizes.

### Brand system
- **Primary colors**: Electric Blue (#3B82F6), Cyan Glow (#22D3EE), Deep Navy (#1E3A5F)
- **Typography**: Inter (display/UI), JetBrains Mono (code)
- **Minimum sizes**: 16×16px digital icon, 128×128px extension icon, 48×48px favicon

## v1.0.37 — 2026-03-14

### Structured JSON queries
- **New**: `POST /api/query/json` — send a prompt with a JSON schema; the endpoint wraps the prompt with schema instructions, parses the model's response, and retries automatically (up to 3 extra attempts) if JSON parsing fails.
- Returns `{ok, data, raw}` on success where `data` is the parsed JSON object.
- Strips markdown fences if the model wraps the JSON in code blocks.
- Added `API.md` with complete documentation for all endpoints.

## v1.0.36 — 2026-03-14

### Programmatic LLM access via Cursor internals
- **New**: `POST /api/prompt` — one-shot LLM query using the default model via `aiService.getSimplePrompt`. Accepts `{prompt, placeholder?}`, returns `{ok, result}`.
- **New**: `POST /api/query` — model-selectable LLM query via `aiClient().getPassthroughPrompt`. Accepts `{prompt, model?}`, returns `{ok, result}`. Model names match those from `/api/modes-and-models`.
- Patcher now discovers and injects `aiService` alongside the existing composer services.
- Two new patched commands: `cursorRemote._prompt` and `cursorRemote._query`.
- Both endpoints support multi-window proxying via the `slug` parameter.
- Auth is handled automatically through Cursor's existing session — no API keys needed.

## v1.0.35 — 2026-03-14

### Show version in web UI and QR panel
- The extension version is now displayed in the web UI header subtitle on the projects page (e.g. "v1.0.35").
- The QR code webview panel inside Cursor shows the version below the title.
- `/api/status` now returns the real version from `package.json` instead of the hardcoded `0.1.0`.

## v1.0.34 — 2026-03-14

### Fix: Secondary windows produced invalid tunnel URLs
- The QR code and "Copy Public URL" from secondary windows appended the **secondary's own auth token** to the primary's tunnel URL, producing a URL that would fail authentication.
- The `/api/_tunnel-url` internal endpoint now also returns `fullUrl` (tunnel URL + primary's token).
- Secondary windows use the primary's pre-built authenticated URL directly.
- The token is only exposed over the localhost-only `_` endpoint (never via the tunnel).

## v1.0.33 — 2026-03-14

### Fix: Secondary windows tunnel URL fetch was blocked by auth
- The secondary's `getTunnelUrl()` was calling `/api/status` on the primary, which requires authentication. Since each window generates its own random token, the request was rejected with 401.
- Added a new auth-free internal endpoint `/api/_tunnel-url` (uses the existing `_` prefix convention that skips auth middleware).
- Secondary windows now correctly show "Show QR Code" and "Copy Public URL" in their menu.

## v1.0.32 — 2026-03-14

### Tunnel URL and QR code available on secondary windows
- **Fixed**: Secondary Cursor windows now show "Show QR Code" and "Copy Public URL" in the status bar menu by fetching the tunnel URL from the primary window.
- The `showUrl` command also works from secondary windows.
- Secondary windows show the globe icon in the status bar when the primary has an active tunnel.

## v1.0.31 — 2026-03-14

### Mode and model selection from the web UI
- **New**: Select Cursor mode (Agent, Plan, Ask, Debug, Triage, Spec) from the web UI before sending a message.
- **New**: Select which AI model to use (all models available in your Cursor account) from the web UI.
- Mode and model selectors appear as compact dropdowns above the message input when viewing a chat.
- The patcher now discovers and injects two additional services: `composerModesService` and `modelConfigService`.
- New patched command `cursorRemote._getModesAndModels` returns available modes, models, and current selections.
- `cursorRemote._submitChat` now accepts optional `mode` and `modelOverride` params — sets mode via `setComposerUnifiedMode` and model via `setModelConfigForComposer` + `modelOverride` option before submitting.
- New `/api/modes-and-models` endpoint exposes mode/model data to the web UI.
- `/api/send` now accepts optional `mode` and `model` fields.
- **Important**: This version requires a patch re-application (happens automatically on reload).

## v1.0.30 — 2026-03-14

### Windows elevation for patching protected installations
- **Fixed**: When Cursor is installed in `C:\Program Files` (system-wide install), the patcher now automatically handles the EPERM error by using an elevated write strategy.
- First tries `icacls` to grant write access to the workbench directory.
- Falls back to spawning an elevated `cmd.exe` via PowerShell `Start-Process -Verb RunAs` to copy the patched file into place (triggers a single UAC prompt on the desktop).
- Post-elevation verification ensures the patch was actually written.
- Checksum update failures on protected directories are now non-fatal (logged as warnings).

## v1.0.29 — 2026-03-14

### Windows patch fix — ASAR support and remote diagnostics
- **Fixed**: Patcher now uses Electron's `original-fs` module to bypass ASAR filesystem interception, which was preventing the workbench file from being found on Windows installations that use ASAR packaging.
- **Fixed**: Added `app.asar.unpacked` candidate paths for locating the workbench file.
- **Fixed**: When the workbench file is only visible through ASAR-aware `fs` (inside `app.asar`), the patcher automatically extracts it to a writable location for patching.
- **Added**: `/api/debug/patcher` endpoint for remote diagnosis of patching issues — shows all candidate paths, which exist on disk vs. inside ASAR, directory listings, and ASAR file detection.
- **Added**: `/api/debug/patcher/apply` POST endpoint to remotely trigger patch application without needing desktop access.
- **Fixed**: Web UI now shows a clear warning toast when message injection falls back to clipboard mode ("Patch not applied — message copied to clipboard") instead of showing fake "Sent" success.
- All patcher file I/O now consistently uses `original-fs` to prevent ASAR interception issues.

## v1.0.28 — 2026-03-14

### Syntax-highlighted code blocks and table styling
- Fixed `marked` v12 integration: syntax highlighting via `highlight.js` was silently broken because `marked.setOptions({ highlight })` was removed in v12. Switched to `marked.use({ renderer: { code() } })`.
- Code blocks now render with proper syntax highlighting (github-dark theme), language badge label, and polished dark styling.
- Added markdown table styling with alternating row backgrounds and proper borders.
- Inline code gets a subtle dark background with border.

## v1.0.27 — 2026-03-14

### Robust Windows tool call parsing
- Fixed multi-line parameter absorption: tool calls like `Write` (with `contents:`), `StrReplace` (with `old_string:`/`new_string:`), and `Task` (with `prompt:`) now fully consume all their parameter lines instead of leaking file contents into the chat display.
- `Task` and `TodoWrite` tool calls are silently absorbed (internal agent noise).
- Richer tool call summaries with icons: `📄 Read`, `📝 Write`, `🗑️ Delete`, `✏️ Edit`, `🔍 Search`, `🌐 Fetch`, etc.
- Shell commands rendered as proper bash code blocks.

## v1.0.26 — 2026-03-14

### Improve Windows transcript rendering
- Consecutive `assistant:` blocks (interleaved with tool calls) are now merged into a single message instead of showing dozens of separate "CURSOR" bubbles.
- `[Tool call]` and `[Tool result]` blocks with their parameter lines are compacted into readable one-line summaries (e.g. shell commands in code blocks, file operations as `*Read* \`path\``).
- `[Thinking]` blocks are stripped from display.
- Markdown tables and other multi-line content now renders correctly as a single coherent message.

## v1.0.25 — 2026-03-14

### Fix Windows transcript parsing (plain-text format)
- On Windows, Cursor stores transcripts as plain text with `user:` / `assistant:` role markers on separate lines, not as JSON-per-line (`.jsonl`). This caused all messages to render as "assistant" with raw text including the role markers, and showed "CURSOR" labels everywhere.
- Added format auto-detection: `isJsonl()` checks whether the file is JSON-per-line or plain text.
- New `parsePlainTextTranscript()` correctly groups lines between role markers into proper user/assistant messages.
- `[Thinking]` prefixed assistant messages are filtered out for cleaner display.
- Chat titles and first-message extraction now work correctly for plain-text transcripts.

## v1.0.24 — 2026-03-14

### Fix Windows open-window detection
- `pathToSlug` now also replaces spaces with dashes to match Cursor's slug format on Windows (e.g. `pagina auto` → `pagina-auto`).
- Projects with open Cursor windows now correctly show the "open" indicator on the web UI.

## v1.0.23 — 2026-03-14

### Fix Windows transcript discovery
- On Windows, Cursor stores transcripts as flat `.txt` files directly in `agent-transcripts/` (e.g. `<uuid>.txt`), not in subdirectories with `.jsonl` extension like macOS/Linux (`<uuid>/<uuid>.jsonl`).
- All transcript functions (`listProjects`, `listChats`, `getChat`, `getChatFileSize`) now use a unified discovery layer that supports both layouts transparently.
- Fixed `slugToPath` and `pathToSlug` to handle Windows drive letters and backslashes.

## v1.0.22 — 2026-03-14

### Fix: v1.0.19–v1.0.21 shipped with stale bundle
- **Root cause**: `vsce package` was packaging the old `dist/extension.js` without rebuilding from source. All the v1.0.19–v1.0.21 source fixes (Windows workbench discovery, VSIX install, activation crash guard) were never actually included in the published VSIX.
- Build pipeline now correctly rebuilds before packaging.
- This release includes ALL accumulated fixes from v1.0.19–v1.0.21 in the actual shipped bundle.

## v1.0.21 — 2026-03-13

### Fix silent activation failure on Windows
- The status bar item is now created FIRST, before any other initialization, so it's always visible even if something downstream crashes.
- Wrapped the entire activation logic in a try-catch. If activation fails, the status bar shows an error indicator and the output log is opened automatically with the full stack trace.
- `ensurePatch` is now wrapped in its own try-catch so a patcher crash doesn't prevent the rest of the extension from loading (server, tunnel, etc.).

## v1.0.20 — 2026-03-13

### Fix VSIX installation on Windows (EINVAL error)
- `cp.execFile('cursor.cmd', ...)` fails on Windows with EINVAL because `.cmd` is a batch file, not an executable. Now uses `cp.exec()` which invokes via `cmd.exe`.
- Added fallback: if CLI install fails, uses the VS Code API `workbench.extensions.installExtension` to install the VSIX directly.
- Increased install timeout from 30s to 60s on Windows.

## v1.0.19 — 2026-03-13

### Improved workbench file discovery for Windows
- `getWorkbenchPath` now uses a multi-strategy approach with candidate search:
  1. `vscode.env.appRoot` (the running Cursor's own `resources/app` dir)
  2. Derive from `process.execPath` (Cursor.exe → `resources/app`)
  3. Platform-specific default paths (multiple candidates on Windows)
- Tries each candidate path and returns the first one that exists on disk.
- Added diagnostic logging (appRoot, execPath, resources dir contents) when the file isn't found, to help debug installation-specific issues.
- Resolves the issue where the workbench file wasn't found on some Windows installations where the Cursor executable location differs from the expected `%LOCALAPPDATA%\Programs\Cursor\` path.

## v1.0.18 — 2026-03-13

### Fix patching on Windows
- Use `vscode.env.appRoot` to locate the workbench file dynamically instead of hardcoded platform paths. Works regardless of where Cursor is installed (user install, system install, custom location).
- Fix `atomicWriteFileSync` on Windows: `fs.renameSync` fails with EPERM when the target file is memory-mapped by the running Cursor process. Now falls back to `fs.copyFileSync` when rename fails.
- Platform-specific default paths retained as fallback if `appRoot` is empty.

## v1.0.17 — 2026-03-13

### Clickable file links with preview in chat messages
- File paths mentioned in agent responses (e.g. `` `startup/docs/meeting-cheatsheet.pdf` ``) are now detected and rendered as clickable links with file-type icons.
- Clicking a link opens a preview overlay:
  - **PDFs** display in an embedded iframe viewer
  - **Images** show in a lightbox
  - **Videos/Audio** play inline with controls
  - **Other files** (xlsx, docx, pptx) open in a new tab for download
- New server endpoint `GET /api/projects/:slug/files/serve?path=<relative>` serves files from the actual project workspace folder with security checks (path traversal protection, 50MB limit).
- Supports PDF, PNG, JPG, JPEG, WebP, GIF, SVG, HTML, TXT, MD, JSON, CSV, XLSX, DOCX, PPTX, MP4, WebM, MP3, WAV.
- Preview overlay includes a title bar with the filename and an "Open" button for downloading.

## v1.0.16 — 2026-03-13

### Fix missing chat titles for inactive chats
- Chat titles from the global `cursorDiskKV` database only cover recently active composers (about 70% of chats).
- Added a fallback that reads the per-workspace `composer.composerData` from `workspaceStorage/*/state.vscdb`, which stores titles for ALL composers in that workspace (including old/inactive ones).
- Maps project slugs to workspace storage folders via `workspace.json` files, with caching.
- Result: all chats now show their Cursor-generated title instead of the first message.

## v1.0.15 — 2026-03-13

### Fix message delivery to inactive chat tabs
- Discovered that the transcript JSONL filename UUID IS the Cursor composer ID — they are the same.
- The patched `_submitChat` and `_setComposerText` commands now call `showAndFocus(composerId)` BEFORE attempting `getHandleIfLoaded`, which activates the chat tab and loads the composer into memory.
- Added an inline polling wait loop (up to 2s) for the handle to become available after `showAndFocus`.
- `resolveComposerId` now passes the transcript UUID through directly as the composer ID instead of falling back to `selectedComposerId`.
- Fixed patch syntax validator: `patchCode` already starts with `,` (prepended in `applyPatch`), so the validator wrapper must use `0${patchCode}` not `0,${patchCode}` to avoid a double comma.
- Replaced arrow functions with `function` expressions in the injected code for maximum compatibility.
- This patch change requires re-patching Cursor (automatic on reload).

## v1.0.12 — 2026-03-13

### Improved project list categorization
- **Real projects** with chats are shown first, prominently.
- **Standalone chats** (numeric-slug entries without a real workspace folder) are grouped in a collapsible "Standalone chats" section.
- **Projects without chats** are in their own collapsible section at the bottom.

### Open/closed window indicators
- Each project now shows a status tag: **LIVE** (connected, messages route here), **OPEN** (Cursor window running with this project), or **CLOSED** (no Cursor window open).
- The `/api/projects` endpoint now includes `hasOpenWindow` and `isOrphan` flags using the window registry.

### Launch Cursor from web UI
- When sending a message to a project that has no open Cursor window, a prompt asks whether to launch Cursor on that folder first.
- New `POST /api/projects/:slug/open` endpoint spawns `cursor <path>` to open the project.

## v1.0.11 — 2026-03-13

### Fix reload-all from secondary windows
- When a secondary window triggers "Reload All Windows" (e.g. after an update), it now delegates to the primary via `POST /api/_reloadAll`. The primary then fans out reload requests to all registered windows before reloading itself.
- Previously, a secondary's registry was empty so it only reloaded itself.
- Auto-update check now only runs on the primary window to avoid duplicate notifications.

## v1.0.10 — 2026-03-13

### Fix scroll-to-bottom on chat detail
- The chat messages container is now the sole scroll target when viewing a conversation — `main` is set to `overflow: hidden` in chat view so scroll commands reliably target `#messages`.
- `scrollToBottom` fires at three intervals (double rAF, 150ms, 500ms) to handle late layout shifts from markdown/syntax rendering.

### Floating scroll-to-bottom button
- A WhatsApp-style floating button (chevron-down) appears when the user scrolls up from the bottom of a conversation.
- Tapping it smooth-scrolls to the latest message.
- The button auto-hides when the user is already at the bottom.

## v1.0.9 — 2026-03-13

### Reload all windows on update
- "Reload Now" after an update now reloads **all** Cursor instances (primary + secondaries), not just the window that triggered the update.
- Each window exposes a `POST /api/_reload` internal endpoint; the primary sends reload requests to every registered secondary before reloading itself.
- Apply/remove patch commands also reload all windows.

### Fix "composer ID not found" on remote send
- The web UI was sending the transcript chat ID (JSONL filename UUID) as the `composerId`, but Cursor's internal composer IDs are different. The server now resolves the transcript ID against live composer state: if it matches an open composer it's used directly, otherwise the currently selected/focused composer in the target window is used.

## v1.0.8 — 2026-03-13

### Deduplicate replayed messages
- When a conversation is continued across sessions, Cursor replays earlier user messages into the transcript. These duplicate lines are now detected and filtered out, so the chat view no longer shows orphaned user messages without agent replies.

### Clean up context noise in messages
- `<attached_files>`, `<agent_transcripts>`, `<open_and_recently_viewed_files>`, `<user_info>`, and `<system_reminder>` blocks are now stripped from rendered messages.
- The `[Image]` text prefix on image-bearing messages is removed.
- Image-only messages display a clean "(image only)" placeholder instead of empty bubbles.

## v1.0.7 — 2026-03-13

### Chat titles from Cursor
- Chat list now shows the AI-generated title that Cursor assigns to each conversation tab, instead of the raw first message.
- Titles are read from Cursor's internal `state.vscdb` database via a batch `sqlite3` query.
- Falls back to the first message preview when no title is available.

### Inline image display
- Images attached to conversations (screenshots, etc.) are now rendered inline in the chat view.
- New server route `GET /api/projects/:slug/assets/:filename` serves image files from each project's assets folder.
- `<image_files>` blocks in transcript text are parsed and converted to authenticated image URLs.
- Tap any image to view it full-size in a lightbox overlay.

### Scroll to bottom on chat open
- Chat detail page now reliably scrolls to the latest message when opened.
- Uses double `requestAnimationFrame` plus a delayed fallback to handle late layout reflows from syntax highlighting and markdown rendering.

### Duplicate message fix
- Fixed: sending a message from the web UI showed it twice (once as the optimistic "You (remote)" and again from the polling response).
- On successful send, `messageCount` is now incremented so the poll skips the already-shown message.
- On failure, the optimistic message is removed from the DOM.

## v1.0.6 — 2026-03-13

### Multi-window routing
- Each Cursor window now starts its own server on a unique port (auto-increment on EADDRINUSE).
- The first window becomes the "primary gateway" on port 7842; subsequent windows register with it.
- Primary proxies `/api/send`, `/api/set-text`, and `/api/composers` to the correct window based on project slug.
- Tunnel only runs on the primary window.
- Web UI sends `slug` and `composerId` so messages reach the right project's chat.

## v1.0.5 — 2026-03-12

### Integrity check suppression
- Automatically updates Cursor's `product.json` checksum after patching to suppress the "installation appears to be corrupt" notification.

## v1.0.4 — 2026-03-11

### Self-update from GitHub Releases
- Added `Cursor Remote: Check for Updates` command.
- Auto-checks for new versions on startup (configurable).
- Downloads and installs the latest `.vsix` from GitHub Releases.

## v1.0.3 — 2026-03-11

### Checksum verification on activation
- Ensures the product.json checksum is correct on every activation, not just after patching.

## v1.0.2 — 2026-03-10

### Product.json checksum update
- Updates `product.json` checksum after patching to bypass Cursor's integrity check.

## v1.0.1 — 2026-03-10

### Dynamic workbench patcher
- Resilient to Cursor updates — finds injection anchor points dynamically instead of relying on hardcoded offsets.
