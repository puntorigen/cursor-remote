# Cursor Remote

Control your Cursor IDE from your phone. Browse conversations, send messages, and track file changes through a mobile-optimized web UI.

![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)
![VS Code 1.90+](https://img.shields.io/badge/vscode-%3E%3D1.90.0-blue.svg)
![Version 1.0.24](https://img.shields.io/badge/version-1.0.24-green.svg)

---

## Features

**Remote Chat Access** — Browse all your projects and conversations from `~/.cursor/projects`. Read full chat histories with rendered markdown and syntax highlighting. Messages update in real-time via polling.

**Send Messages** — Compose and send messages directly into the active Cursor chat from your phone. Works through patched internal commands or a clipboard fallback.

**File Change Tracking** — See git status and diffs for every modified, added, deleted, or renamed file. Also view which files the AI modified in a given conversation by parsing transcript tool calls.

**Secure Tunnel Access** — Connects locally on a configurable port, or exposes a public HTTPS URL through a [cloudflared](https://github.com/cloudflare/cloudflared) quick tunnel. Scan a QR code to connect instantly from your phone.

**Token Authentication** — An auth token is generated on activation. Supports query param, cookie, and `Authorization` header authentication. HttpOnly cookies with 7-day expiry.

**PWA-Ready** — The web UI works as a Progressive Web App — add it to your home screen for a native-like experience with a dark theme and mobile-first layout.

---

## Installation

### Prerequisites

- [Cursor](https://cursor.com) IDE (VS Code engine >= 1.90.0)

### Prebuilt Package

A prebuilt `cursor-remote-1.0.24.vsix` is included in the repository. Install it directly:

```bash
cursor --install-extension cursor-remote-1.0.24.vsix
```

After installing, press `Ctrl+P` (or `Cmd+P` on macOS), type `> Developer: Reload Window`, and hit Enter to activate the extension.

### From Source

If you prefer to build from source:

```bash
git clone https://github.com/your-username/cursor-remote.git
cd cursor-remote
npm install
npm run build
npm run package
cursor --install-extension cursor-remote-1.0.24.vsix
```

### Optional: cloudflared

For remote access outside your local network, the extension can start a [Cloudflare Quick Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/). When first needed, the extension will prompt you to install `cloudflared`. You can also install it manually:

```bash
# macOS
brew install cloudflared

# Or download directly (the extension handles this too)
```

---

## Quick Start

1. Install the extension and restart Cursor.
2. The server starts automatically on activation (configurable).
3. Look for the **Cursor Remote** item in the status bar.
4. Click it or run **Cursor Remote: Show Menu** from the command palette.
5. Select **Show URL + QR Code** and scan the QR code with your phone.
6. Authenticate with the token shown in the notification.

---

## Commands

| Command | Description |
|---------|-------------|
| **Cursor Remote: Show Menu** | Quick-pick menu with all actions |
| **Cursor Remote: Start Server** | Start the HTTP server (and tunnel if enabled) |
| **Cursor Remote: Stop Server** | Stop the server and tunnel |
| **Cursor Remote: Show Auth Token** | Display and copy the auth token |
| **Cursor Remote: Show URL + QR Code** | Show connection URL and QR code |
| **Cursor Remote: Start Tunnel** | Start a cloudflared tunnel |
| **Cursor Remote: Apply Patch** | Patch Cursor's workbench for direct message injection |
| **Cursor Remote: Remove Patch** | Restore the original workbench file |
| **Cursor Remote: Run Diagnostics** | Run injection diagnostics |

---

## Configuration

All settings live under the `cursorRemote` namespace in your Cursor settings:

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `cursorRemote.port` | number | `7842` | Local HTTP server port |
| `cursorRemote.autoStart` | boolean | `true` | Start server automatically when Cursor opens |
| `cursorRemote.autoTunnel` | boolean | `true` | Start cloudflared tunnel on activation |
| `cursorRemote.pollInterval` | number | `2000` | Polling interval in ms for transcript updates |

---

## API

The extension exposes a REST API on the configured port.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status` | Server status, version, workspace info |
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/:slug/chats` | List chats for a project |
| `GET` | `/api/projects/:slug/chats/:id` | Get chat messages (`?since=N` for incremental) |
| `GET` | `/api/projects/:slug/chats/:id/poll` | Last-modified timestamp for polling |
| `GET` | `/api/projects/:slug/chats/:id/files` | Files modified by AI in a chat |
| `GET` | `/api/projects/:slug/files` | Git status and diff stats |
| `GET` | `/api/projects/:slug/files/diff` | File diff (`?path=&staged=`) |
| `POST` | `/api/send` | Send a message to Cursor |
| `POST` | `/api/set-text` | Set composer text without submitting |
| `GET` | `/api/composers` | Active composer state |
| `GET` | `/api/diagnostics` | Injection method diagnostics |

All endpoints (except auth) require a valid token via query parameter `?token=`, cookie `cr_token`, or `Authorization: Bearer` header.

---

## Workbench Patching

To enable direct message injection (instead of clipboard fallback), the extension can patch Cursor's internal `workbench.desktop.main.js`. This exposes commands for setting composer text and submitting messages programmatically.

- **Apply** via command palette: **Cursor Remote: Apply Patch**
- **Remove** via command palette: **Cursor Remote: Remove Patch**
- A backup is created automatically at `workbench.desktop.main.js.cursor-remote-backup`
- Restore scripts (`cursor-remote-restore.sh` / `.bat`) are generated for recovery

> **Note:** Cursor updates may overwrite the patch. Re-apply after updates if direct injection stops working.

---

## Project Structure

```
cursor-remote/
├── src/
│   ├── extension.ts      # Entry point, activation, commands
│   ├── server.ts         # Express HTTP server and REST API
│   ├── tunnel.ts         # cloudflared tunnel manager
│   ├── injector.ts       # Message injection (patch / clipboard)
│   ├── patcher.ts        # Workbench JS patching
│   ├── transcripts.ts    # Agent transcript reader
│   ├── files.ts          # Git status and diffs
│   ├── discovery.ts      # Command discovery
│   ├── installer.ts      # cloudflared installer
│   └── qr.ts             # QR code SVG generation
├── webview/
│   ├── index.html        # Mobile web app shell
│   ├── app.js            # SPA logic
│   └── styles.css        # Dark theme, mobile-first CSS
├── dist/                  # Built extension output
├── package.json
└── tsconfig.json
```

---

## Development

```bash
# Install dependencies
npm install

# Build once
npm run build

# Watch mode (rebuild on changes)
npm run watch

# Type-check without emitting
npm run lint

# Package as .vsix
npm run package
```

---

## License

[MIT](LICENSE)
