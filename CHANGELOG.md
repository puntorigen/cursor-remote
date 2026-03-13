# Changelog

## v1.0.13 — 2026-03-13

### Fix message delivery to inactive chat tabs
- Discovered that the transcript JSONL filename UUID IS the Cursor composer ID — they are the same.
- The patched `_submitChat` and `_setComposerText` commands now call `showAndFocus(composerId)` BEFORE attempting `getHandleIfLoaded`, which activates the chat tab and loads the composer into memory.
- Added a polling wait loop (up to 2s) for the handle to become available after `showAndFocus`, handling the async loading delay.
- `resolveComposerId` now passes the transcript UUID through directly as the composer ID instead of falling back to `selectedComposerId` when tabs don't match.
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
