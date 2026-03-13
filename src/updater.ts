import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { removePatch, isPatchApplied } from './patcher';

const REPO = 'puntorigen/cursor-remote';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const VSIX_PATTERN = /^cursor-remote-.*\.vsix$/;

function getCurrentVersion(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pkg = require('../package.json');
  return pkg.version as string;
}

interface GitHubAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubAsset[];
}

function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function httpGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const get = (targetUrl: string, redirects = 0) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      https.get(targetUrl, {
        headers: {
          'User-Agent': 'cursor-remote-extension',
          'Accept': 'application/vnd.github.v3+json',
        },
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} from ${targetUrl}`));
          res.resume();
          return;
        }
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
          catch (e) { reject(e); }
        });
        res.on('error', reject);
      }).on('error', reject);
    };
    get(url);
  });
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = (targetUrl: string, redirects = 0) => {
      if (redirects > 5) { reject(new Error('Too many redirects')); return; }
      https.get(targetUrl, {
        headers: { 'User-Agent': 'cursor-remote-extension' },
      }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location, redirects + 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', (err) => { fs.unlinkSync(dest); reject(err); });
      }).on('error', reject);
    };
    get(url);
  });
}

async function fetchLatestRelease(log: vscode.OutputChannel): Promise<{ version: string; vsixUrl: string } | null> {
  log.appendLine('[Updater] Checking GitHub for updates...');
  try {
    const release = await httpGetJson<GitHubRelease>(API_URL);
    const version = release.tag_name.replace(/^v/, '');
    const asset = release.assets.find(a => VSIX_PATTERN.test(a.name));
    if (!asset) {
      log.appendLine('[Updater] No .vsix asset found in latest release');
      return null;
    }
    log.appendLine(`[Updater] Latest release: v${version}, asset: ${asset.name}`);
    return { version, vsixUrl: asset.browser_download_url };
  } catch (err: any) {
    log.appendLine(`[Updater] Failed to check for updates: ${err.message}`);
    return null;
  }
}

/**
 * Checks GitHub for a newer version. If found, shows a notification with
 * "Update Now" and "Skip This Version" buttons.
 * Called from activate() after a short delay.
 */
export async function checkForUpdate(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  reloadAll?: () => void,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('cursorRemote');
  if (!config.get<boolean>('autoCheckUpdates', true)) {
    log.appendLine('[Updater] Auto-check disabled by setting');
    return;
  }

  const latest = await fetchLatestRelease(log);
  if (!latest) return;

  const current = getCurrentVersion();
  if (compareVersions(latest.version, current) <= 0) {
    log.appendLine(`[Updater] Up to date (current: ${current}, latest: ${latest.version})`);
    return;
  }

  const skipped = context.globalState.get<string>('skippedVersion');
  if (skipped === latest.version) {
    log.appendLine(`[Updater] v${latest.version} was skipped by user`);
    return;
  }

  log.appendLine(`[Updater] Update available: ${current} → ${latest.version}`);

  const action = await vscode.window.showInformationMessage(
    `Cursor Remote v${latest.version} is available (current: v${current})`,
    'Update Now',
    'Skip This Version',
  );

  if (action === 'Update Now') {
    await performUpdate(context, log, latest.version, latest.vsixUrl, reloadAll);
  } else if (action === 'Skip This Version') {
    await context.globalState.update('skippedVersion', latest.version);
    log.appendLine(`[Updater] User skipped v${latest.version}`);
  }
}

/**
 * Downloads the latest .vsix, removes the current patch cleanly,
 * installs the new version, and prompts to reload.
 * Can be called from the notification or the menu command.
 */
export async function performUpdate(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
  version?: string,
  vsixUrl?: string,
  reloadAll?: () => void,
): Promise<void> {
  if (!version || !vsixUrl) {
    const latest = await fetchLatestRelease(log);
    if (!latest) {
      vscode.window.showInformationMessage('Cursor Remote: already on the latest version.');
      return;
    }
    const current = getCurrentVersion();
    if (compareVersions(latest.version, current) <= 0) {
      vscode.window.showInformationMessage(
        `Cursor Remote is up to date (v${current}).`,
      );
      return;
    }
    version = latest.version;
    vsixUrl = latest.vsixUrl;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Cursor Remote: Updating...', cancellable: false },
    async (progress) => {
      progress.report({ message: `Downloading v${version}...` });
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-remote-'));
      const vsixPath = path.join(tmpDir, `cursor-remote-${version}.vsix`);

      try {
        await downloadFile(vsixUrl!, vsixPath);
        log.appendLine(`[Updater] Downloaded to ${vsixPath}`);
      } catch (err: any) {
        log.appendLine(`[Updater] Download failed: ${err.message}`);
        vscode.window.showErrorMessage(`Failed to download update: ${err.message}`);
        return;
      }

      if (isPatchApplied()) {
        progress.report({ message: 'Removing current patch...' });
        log.appendLine('[Updater] Removing patch before install...');
        await removePatch(log);
        await context.globalState.update('patchReloadPending', undefined);
      }

      progress.report({ message: 'Installing...' });
      try {
        await new Promise<void>((resolve, reject) => {
          // On Windows, use `code --install-extension` via cmd.exe since
          // cursor.cmd is a batch file that cp.execFile can't run directly.
          // Also try the VS Code API first as it's more reliable.
          const args = ['--install-extension', vsixPath];
          if (process.platform === 'win32') {
            const cmdLine = `"cursor" --install-extension "${vsixPath}"`;
            cp.exec(cmdLine, { timeout: 60_000 }, (err, stdout, stderr) => {
              if (err) {
                log.appendLine(`[Updater] Install stderr: ${stderr}`);
                reject(err);
              } else {
                log.appendLine(`[Updater] Install stdout: ${stdout.trim()}`);
                resolve();
              }
            });
          } else {
            cp.execFile('cursor', args, { timeout: 30_000 }, (err, stdout, stderr) => {
              if (err) {
                log.appendLine(`[Updater] Install stderr: ${stderr}`);
                reject(err);
              } else {
                log.appendLine(`[Updater] Install stdout: ${stdout.trim()}`);
                resolve();
              }
            });
          }
        });
      } catch (err: any) {
        log.appendLine(`[Updater] Install via CLI failed: ${err.message}`);
        // Fallback: use the VS Code commands API to install the VSIX
        try {
          log.appendLine('[Updater] Trying VS Code API fallback...');
          await vscode.commands.executeCommand(
            'workbench.extensions.installExtension',
            vscode.Uri.file(vsixPath),
          );
          log.appendLine('[Updater] Installed via VS Code API');
        } catch (err2: any) {
          log.appendLine(`[Updater] API fallback failed: ${err2.message}`);
          vscode.window.showErrorMessage(`Failed to install update: ${err.message}`);
          return;
        }
      }

      await context.globalState.update('skippedVersion', undefined);
      log.appendLine(`[Updater] v${version} installed successfully`);

      try { fs.unlinkSync(vsixPath); fs.rmdirSync(tmpDir); } catch { /* ignore */ }

      const action = await vscode.window.showInformationMessage(
        `Cursor Remote updated to v${version}. Reload all windows to activate.`,
        'Reload All Windows',
      );
      if (action === 'Reload All Windows') {
        if (reloadAll) {
          reloadAll();
        } else {
          vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
      }
    },
  );
}
