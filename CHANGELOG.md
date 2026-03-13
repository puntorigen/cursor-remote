# Changelog

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
