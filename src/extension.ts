import * as http from 'http';
import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { MessageInjector } from './injector';
import { RemoteServer } from './server';
import { TunnelManager } from './tunnel';
import { generateQrSvg } from './qr';
import { ensurePatch, applyPatch, removePatch, isPatchApplied } from './patcher';
import { checkForUpdate, performUpdate } from './updater';
import { pathToSlug } from './transcripts';

let server: RemoteServer | null = null;
let tunnel: TunnelManager | null = null;
let statusBarItem: vscode.StatusBarItem;
let authToken: string;
let serverRunning = false;
let actualPort = 0;
let isPrimary = false;

const PRIMARY_PORT = 7842;

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Cursor Remote');
  log.appendLine('[Extension] Activating Cursor Remote...');

  // Create status bar FIRST so it's visible even if something below fails
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'cursorRemote.menu';
  statusBarItem.text = '$(sync~spin) Cursor Remote';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  try {
    await doActivate(context, log);
  } catch (err: any) {
    log.appendLine(`[Extension] FATAL activation error: ${err.message}`);
    log.appendLine(`[Extension] Stack: ${err.stack || '(none)'}`);
    statusBarItem.text = '$(error) Cursor Remote (error)';
    statusBarItem.tooltip = `Activation failed: ${err.message}`;
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
    log.show();
  }
}

async function doActivate(context: vscode.ExtensionContext, log: vscode.OutputChannel) {
  authToken = crypto.randomBytes(16).toString('hex');
  log.appendLine(`[Extension] Auth token generated`);

  const config = vscode.workspace.getConfiguration('cursorRemote');
  const configPort = config.get<number>('port', PRIMARY_PORT);
  const autoStart = config.get<boolean>('autoStart', true);
  const autoTunnel = config.get<boolean>('autoTunnel', true);

  let patchReady = false;
  try {
    patchReady = await ensurePatch(context, log);
  } catch (err: any) {
    log.appendLine(`[Extension] ensurePatch threw: ${err.message}`);
  }
  if (!patchReady) {
    log.appendLine('[Extension] Patch not active yet — injection will use clipboard fallback');
  }

  const injector = new MessageInjector(log);
  await injector.initialize();

  server = new RemoteServer(injector, authToken, log);
  tunnel = new TunnelManager(log);

  tunnel.setOnUrlChange((url) => {
    if (url) {
      server?.setTunnelUrl(url);
      updateStatusBar(url);
    } else {
      updateStatusBar(null);
      statusBarItem.text = '$(sync~spin) Cursor Remote (reconnecting...)';
    }
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.menu', () => showMenu(context, log))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.start', async () => {
      const started = await startServer(configPort, log);
      if (started && isPrimary && autoTunnel) {
        await startTunnel(actualPort, log);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.stop', async () => {
      await stopServer(log);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.startTunnel', async () => {
      if (!isPrimary) {
        vscode.window.showInformationMessage('Tunnel can only run on the primary window (the first one started).');
        return;
      }
      if (tunnel?.isRunning()) {
        vscode.window.showInformationMessage('Tunnel is already running.');
        return;
      }
      await startTunnel(actualPort, log);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.showToken', () => {
      vscode.window
        .showInformationMessage(`Auth Token: ${authToken}`, 'Copy')
        .then((action) => {
          if (action === 'Copy') {
            vscode.env.clipboard.writeText(authToken);
          }
        });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.showUrl', async () => {
      const tunnelUrl = await getTunnelUrl();
      const localUrl = `http://localhost:${actualPort || configPort}/?token=${authToken}`;
      const fullUrl = tunnelUrl ? `${tunnelUrl}/?token=${authToken}` : localUrl;

      if (tunnelUrl) {
        showUrlPanel(context, fullUrl, localUrl);
      } else {
        vscode.window
          .showInformationMessage(
            `Cursor Remote (local): ${localUrl}`,
            'Copy URL',
            'Start Tunnel'
          )
          .then((action) => {
            if (action === 'Copy URL') {
              vscode.env.clipboard.writeText(localUrl);
            } else if (action === 'Start Tunnel') {
              vscode.commands.executeCommand('cursorRemote.startTunnel');
            }
          });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.diagnostics', async () => {
      const diag = await injector.diagnose();
      log.appendLine(`[Diagnostics] ${JSON.stringify(diag, null, 2)}`);
      log.show();
      vscode.window.showInformationMessage(
        `Injection: ${diag.recommendation}. See Output panel for details.`
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.applyPatch', async () => {
      const result = await applyPatch(log);
      if (result.error) {
        vscode.window.showErrorMessage(`Patch failed: ${result.error}`);
      } else if (result.alreadyPatched) {
        vscode.window.showInformationMessage('Patch is already applied.');
      } else {
        const action = await vscode.window.showInformationMessage(
          'Patch applied. Reload all windows to activate.',
          'Reload All Windows',
        );
        if (action === 'Reload All Windows') {
          server?.reloadAllWindows(PRIMARY_PORT);
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.removePatch', async () => {
      const removed = await removePatch(log);
      if (removed) {
        await context.globalState.update('patchReloadPending', undefined);
        const action = await vscode.window.showInformationMessage(
          'Patch removed. Reload all windows to restore original behavior.',
          'Reload All Windows',
        );
        if (action === 'Reload All Windows') {
          server?.reloadAllWindows(PRIMARY_PORT);
        }
      } else {
        vscode.window.showWarningMessage(
          'Could not remove patch — no backup found. You may need to reinstall Cursor.'
        );
      }
    })
  );

  const reloadAll = () => server?.reloadAllWindows(PRIMARY_PORT);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.checkForUpdates', () =>
      performUpdate(context, log, undefined, undefined, reloadAll))
  );

  if (autoStart) {
    const started = await startServer(configPort, log);

    if (started && isPrimary && autoTunnel) {
      await startTunnel(actualPort, log);
    }
  }

  if (isPrimary) {
    setTimeout(() => checkForUpdate(context, log, reloadAll).catch(() => {}), 5_000);
  }

  log.appendLine('[Extension] Cursor Remote activated.');
}

async function startTunnel(port: number, log: vscode.OutputChannel) {
  if (!tunnel) return;

  statusBarItem.text = '$(sync~spin) Cursor Remote (connecting...)';
  statusBarItem.show();

  const tunnelUrl = await tunnel.start(port);
  if (tunnelUrl) {
    server?.setTunnelUrl(tunnelUrl);
    updateStatusBar(tunnelUrl);
    const fullUrl = `${tunnelUrl}/?token=${authToken}`;
    log.appendLine(`[Extension] Tunnel ready: ${fullUrl}`);

    vscode.window
      .showInformationMessage(
        'Cursor Remote: Tunnel is live! Click the status bar to get the URL + QR code.',
        'Copy URL',
        'Show QR'
      )
      .then((action) => {
        if (action === 'Copy URL') {
          vscode.env.clipboard.writeText(fullUrl);
        } else if (action === 'Show QR') {
          vscode.commands.executeCommand('cursorRemote.showUrl');
        }
      });
  } else {
    updateStatusBar(null);
    log.appendLine('[Extension] Tunnel not started (cloudflared not available or user skipped)');
  }
}

async function startServer(configPort: number, log: vscode.OutputChannel): Promise<boolean> {
  if (!server) return false;
  try {
    actualPort = await server.startWithRetry(configPort);
    isPrimary = actualPort === configPort;
    serverRunning = true;

    const wsFolder = vscode.workspace.workspaceFolders?.[0];
    const slug = wsFolder ? pathToSlug(wsFolder.uri.fsPath) : null;

    if (isPrimary) {
      log.appendLine(`[Extension] Primary window on port ${actualPort}`);
      if (slug) {
        server.registerWindow(slug, wsFolder!.uri.fsPath, actualPort);
      }
    } else {
      log.appendLine(`[Extension] Secondary window on port ${actualPort} (primary at :${configPort})`);
      if (slug) {
        registerWithPrimary(slug, wsFolder!.uri.fsPath, actualPort, configPort, log);
      }
    }

    // Show tunnel status — secondaries fetch it from the primary
    const startupTunnelUrl = await getTunnelUrl();
    updateStatusBar(startupTunnelUrl);
    log.appendLine(`[Extension] Server started on port ${actualPort}`);
    return true;
  } catch (err: any) {
    log.appendLine(`[Extension] Failed to start server: ${err.message}`);
    vscode.window.showErrorMessage(`Cursor Remote failed to start: ${err.message}`);
    return false;
  }
}

function registerWithPrimary(
  slug: string,
  workspace: string,
  myPort: number,
  primaryPort: number,
  log: vscode.OutputChannel,
) {
  const data = JSON.stringify({ slug, workspace, port: myPort });
  const req = http.request({
    hostname: '127.0.0.1',
    port: primaryPort,
    path: '/api/_register',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => {
      log.appendLine(`[Extension] Registered with primary: ${res.statusCode} ${body}`);
    });
  });
  req.on('error', (err) => {
    log.appendLine(`[Extension] Failed to register with primary: ${err.message}`);
  });
  req.write(data);
  req.end();
}

function unregisterFromPrimary(
  myPort: number,
  primaryPort: number,
  log: vscode.OutputChannel,
) {
  const data = JSON.stringify({ port: myPort });
  const req = http.request({
    hostname: '127.0.0.1',
    port: primaryPort,
    path: '/api/_unregister',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    },
  }, () => {
    log.appendLine(`[Extension] Unregistered from primary`);
  });
  req.on('error', () => {});
  req.write(data);
  req.end();
}

async function stopServer(log: vscode.OutputChannel) {
  tunnel?.stop();
  await server?.stop();
  serverRunning = false;
  updateStatusBar(null);
  log.appendLine('[Extension] Server stopped.');
  vscode.window.showInformationMessage('Cursor Remote stopped.');
}

function updateStatusBar(tunnelUrl: string | null) {
  const portLabel = actualPort || PRIMARY_PORT;
  const roleLabel = isPrimary ? '' : ' (secondary)';

  if (!serverRunning) {
    statusBarItem.text = '$(circle-slash) Cursor Remote (stopped)';
    statusBarItem.tooltip = 'Click to start';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (tunnelUrl) {
    statusBarItem.text = `$(globe) Cursor Remote${roleLabel}`;
    statusBarItem.tooltip = `Port ${portLabel} — tunnel active — click for options`;
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(plug) Cursor Remote :${portLabel}${roleLabel}`;
    statusBarItem.tooltip = `Port ${portLabel} — local only — click for options`;
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.show();
}

async function getTunnelUrl(): Promise<string | null> {
  const local = tunnel?.getUrl() || null;
  if (local) return local;
  if (isPrimary) return null;

  // Secondary: ask the primary via the auth-free internal endpoint
  return new Promise((resolve) => {
    const req = http.get(
      `http://127.0.0.1:${PRIMARY_PORT}/api/_tunnel-url`,
      { timeout: 2000 },
      (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c.toString(); });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.tunnelUrl || null);
          } catch { resolve(null); }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function showMenu(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
) {
  const tunnelUrl = await getTunnelUrl();
  const portLabel = actualPort || PRIMARY_PORT;
  const localUrl = `http://localhost:${portLabel}/?token=${authToken}`;
  const fullUrl = tunnelUrl ? `${tunnelUrl}/?token=${authToken}` : localUrl;

  interface MenuItem extends vscode.QuickPickItem {
    action: string;
  }

  const items: MenuItem[] = [];

  if (!serverRunning) {
    items.push(
      { label: '$(play) Start Server', description: `Port ${portLabel}`, action: 'start' },
      { label: '$(output) View Logs', action: 'logs' },
      { label: '$(cloud-download) Check for Updates', action: 'check-updates' },
    );
  } else {
    if (tunnelUrl) {
      items.push(
        { label: '$(link) Show QR Code', description: 'Scan with your phone', action: 'qr' },
        { label: '$(clippy) Copy Public URL', description: tunnelUrl, action: 'copy-tunnel' },
      );
    } else if (isPrimary) {
      items.push(
        { label: '$(cloud-upload) Start Tunnel', description: 'Expose via cloudflared', action: 'start-tunnel' },
      );
    }
    items.push(
      { label: '$(clippy) Copy Local URL', description: localUrl, action: 'copy-local' },
      { label: '$(key) Copy Auth Token', action: 'copy-token' },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: '' },
      { label: '$(debug-stop) Stop Server & Tunnel', action: 'stop' },
      { label: '$(output) View Logs', action: 'logs' },
      { label: '$(cloud-download) Check for Updates', action: 'check-updates' },
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Cursor Remote${isPrimary ? ' (primary)' : ' (secondary)'}`,
    placeHolder: serverRunning ? `Server running on :${portLabel}` : 'Server stopped',
  });

  if (!picked) return;

  switch (picked.action) {
    case 'start': {
      const config = vscode.workspace.getConfiguration('cursorRemote');
      const cfgPort = config.get<number>('port', PRIMARY_PORT);
      await startServer(cfgPort, log);
      if (isPrimary && config.get<boolean>('autoTunnel', true)) {
        await startTunnel(actualPort, log);
      }
      break;
    }
    case 'stop':
      await stopServer(log);
      break;
    case 'qr':
      showUrlPanel(context, fullUrl, localUrl);
      break;
    case 'copy-tunnel':
      await vscode.env.clipboard.writeText(fullUrl);
      vscode.window.showInformationMessage('Public URL copied to clipboard.');
      break;
    case 'copy-local':
      await vscode.env.clipboard.writeText(localUrl);
      vscode.window.showInformationMessage('Local URL copied to clipboard.');
      break;
    case 'copy-token':
      await vscode.env.clipboard.writeText(authToken);
      vscode.window.showInformationMessage('Auth token copied to clipboard.');
      break;
    case 'start-tunnel':
      await startTunnel(actualPort, log);
      break;
    case 'logs':
      log.show();
      break;
    case 'check-updates':
      vscode.commands.executeCommand('cursorRemote.checkForUpdates');
      break;
  }
}

async function showUrlPanel(
  context: vscode.ExtensionContext,
  fullUrl: string,
  localUrl: string
) {
  const panel = vscode.window.createWebviewPanel(
    'cursorRemoteQR',
    'Cursor Remote — Scan to Connect',
    vscode.ViewColumn.One,
    { enableScripts: false }
  );

  const qrSvg = await generateQrSvg(fullUrl);

  panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      background: #0f0f0f;
      color: #e5e5e5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      padding: 24px;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .subtitle {
      color: #888;
      font-size: 14px;
      margin-bottom: 28px;
    }
    .qr-container {
      background: white;
      border-radius: 16px;
      padding: 20px;
      margin-bottom: 28px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .qr-container svg {
      display: block;
      width: 220px;
      height: 220px;
    }
    .url-box {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 10px;
      padding: 14px 20px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      font-size: 13px;
      color: #3b82f6;
      word-break: break-all;
      text-align: center;
      max-width: 500px;
      margin-bottom: 12px;
      user-select: all;
    }
    .label {
      color: #666;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 6px;
      margin-top: 16px;
    }
    .local-url {
      color: #555;
      font-size: 12px;
      font-family: 'SF Mono', monospace;
    }
    .hint {
      color: #555;
      font-size: 12px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <h1>Cursor Remote</h1>
  <p class="subtitle">Scan the QR code with your phone to connect</p>
  <div class="qr-container">${qrSvg}</div>
  <p class="label">Public URL</p>
  <div class="url-box">${escapeHtml(fullUrl)}</div>
  <p class="label">Local URL</p>
  <p class="local-url">${escapeHtml(localUrl)}</p>
  <p class="hint">The tunnel URL changes each restart. QR code is the fastest way to connect.</p>
</body>
</html>`;

  context.subscriptions.push(panel);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function deactivate() {
  const log = vscode.window.createOutputChannel('Cursor Remote');
  if (!isPrimary && actualPort && serverRunning) {
    unregisterFromPrimary(actualPort, PRIMARY_PORT, log);
  }
  tunnel?.stop();
  return server?.stop();
}
