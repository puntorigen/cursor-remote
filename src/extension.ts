import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { MessageInjector } from './injector';
import { RemoteServer } from './server';
import { TunnelManager } from './tunnel';
import { generateQrSvg } from './qr';
import { ensurePatch, applyPatch, removePatch, isPatchApplied } from './patcher';

let server: RemoteServer | null = null;
let tunnel: TunnelManager | null = null;
let statusBarItem: vscode.StatusBarItem;
let authToken: string;
let serverRunning = false;
let currentPort = 7842;

export async function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Cursor Remote');
  log.appendLine('[Extension] Activating Cursor Remote...');

  authToken = crypto.randomBytes(16).toString('hex');
  log.appendLine(`[Extension] Auth token generated`);

  const config = vscode.workspace.getConfiguration('cursorRemote');
  const port = config.get<number>('port', 7842);
  const autoStart = config.get<boolean>('autoStart', true);
  const autoTunnel = config.get<boolean>('autoTunnel', true);

  // Silently patch Cursor's workbench JS on first activation and auto-reload.
  // On subsequent activations this is a fast no-op (sentinel check).
  const patchReady = await ensurePatch(context, log);
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
      updateStatusBar(port, url);
    } else {
      updateStatusBar(port, null);
      statusBarItem.text = '$(sync~spin) Cursor Remote (reconnecting...)';
    }
  });

  currentPort = port;

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = 'cursorRemote.menu';
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.menu', () => showMenu(context, port, log))
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorRemote.start', async () => {
      const started = await startServer(port, log);
      if (started && config.get<boolean>('autoTunnel', true)) {
        await startTunnel(port, log);
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
      if (tunnel?.isRunning()) {
        vscode.window.showInformationMessage('Tunnel is already running.');
        return;
      }
      await startTunnel(port, log);
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
    vscode.commands.registerCommand('cursorRemote.showUrl', () => {
      const tunnelUrl = tunnel?.getUrl();
      const localUrl = `http://localhost:${port}/?token=${authToken}`;
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
          'Patch applied. Reload Cursor to activate.',
          'Reload Now',
        );
        if (action === 'Reload Now') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
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
          'Patch removed. Reload Cursor to restore original behavior.',
          'Reload Now',
        );
        if (action === 'Reload Now') {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      } else {
        vscode.window.showWarningMessage(
          'Could not remove patch — no backup found. You may need to reinstall Cursor.'
        );
      }
    })
  );

  if (autoStart) {
    const started = await startServer(port, log);

    if (started && autoTunnel) {
      await startTunnel(port, log);
    }
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
    updateStatusBar(port, tunnelUrl);
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
    updateStatusBar(port, null);
    log.appendLine('[Extension] Tunnel not started (cloudflared not available or user skipped)');
  }
}

async function startServer(port: number, log: vscode.OutputChannel): Promise<boolean> {
  if (!server) return false;
  try {
    await server.start(port);
    serverRunning = true;
    updateStatusBar(port, tunnel?.getUrl() || null);
    log.appendLine(`[Extension] Server started on port ${port}`);
    return true;
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      log.appendLine(`[Extension] Port ${port} already in use — another Cursor window is running the server`);
      serverRunning = false;
      statusBarItem.text = '$(circle-slash) Remote (other window)';
      statusBarItem.tooltip = `Port ${port} in use by another Cursor window`;
      statusBarItem.show();
      return false;
    }
    log.appendLine(`[Extension] Failed to start server: ${err.message}`);
    vscode.window.showErrorMessage(`Cursor Remote failed to start: ${err.message}`);
    return false;
  }
}

async function stopServer(log: vscode.OutputChannel) {
  tunnel?.stop();
  await server?.stop();
  serverRunning = false;
  updateStatusBar(currentPort, null);
  log.appendLine('[Extension] Server stopped.');
  vscode.window.showInformationMessage('Cursor Remote stopped.');
}

function updateStatusBar(port: number, tunnelUrl: string | null) {
  if (!serverRunning) {
    statusBarItem.text = '$(circle-slash) Cursor Remote (stopped)';
    statusBarItem.tooltip = 'Click to start';
    statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  } else if (tunnelUrl) {
    statusBarItem.text = '$(globe) Cursor Remote';
    statusBarItem.tooltip = 'Click for options — tunnel active';
    statusBarItem.backgroundColor = undefined;
  } else {
    statusBarItem.text = `$(plug) Cursor Remote :${port}`;
    statusBarItem.tooltip = `Click for options — local only`;
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.show();
}

async function showMenu(
  context: vscode.ExtensionContext,
  port: number,
  log: vscode.OutputChannel,
) {
  const tunnelUrl = tunnel?.getUrl();
  const localUrl = `http://localhost:${port}/?token=${authToken}`;
  const fullUrl = tunnelUrl ? `${tunnelUrl}/?token=${authToken}` : localUrl;

  interface MenuItem extends vscode.QuickPickItem {
    action: string;
  }

  const items: MenuItem[] = [];

  if (!serverRunning) {
    items.push(
      { label: '$(play) Start Server', description: `Port ${port}`, action: 'start' },
      { label: '$(output) View Logs', action: 'logs' },
    );
  } else {
    if (tunnelUrl) {
      items.push(
        { label: '$(link) Show QR Code', description: 'Scan with your phone', action: 'qr' },
        { label: '$(clippy) Copy Public URL', description: tunnelUrl, action: 'copy-tunnel' },
      );
    } else {
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
    );
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Cursor Remote',
    placeHolder: serverRunning ? 'Server running' : 'Server stopped',
  });

  if (!picked) return;

  switch (picked.action) {
    case 'start':
      await startServer(port, log);
      if (vscode.workspace.getConfiguration('cursorRemote').get<boolean>('autoTunnel', true)) {
        await startTunnel(port, log);
      }
      break;
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
      await startTunnel(port, log);
      break;
    case 'logs':
      log.show();
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
  tunnel?.stop();
  return server?.stop();
}
