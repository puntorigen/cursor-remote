import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { exec, execFile } from 'child_process';

const DOWNLOAD_URLS: Record<string, Record<string, string>> = {
  darwin: {
    arm64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
    x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  },
  linux: {
    arm64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
    x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
    arm: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm',
  },
  win32: {
    x64: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
    ia32: 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-386.exe',
  },
};

function getInstallDir(): string {
  return path.join(os.homedir(), '.cursor-remote', 'bin');
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
}

export function getManagedBinaryPath(): string {
  return path.join(getInstallDir(), getBinaryName());
}

export async function findCloudflared(): Promise<string | null> {
  const managed = getManagedBinaryPath();
  if (fs.existsSync(managed)) {
    return managed;
  }

  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where cloudflared' : 'which cloudflared';
    exec(cmd, (err, stdout) => {
      if (!err && stdout.trim()) {
        resolve(stdout.trim().split('\n')[0]);
      } else {
        resolve(null);
      }
    });
  });
}

export async function verifyBinary(binaryPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(binaryPath, ['--version'], (err, stdout) => {
      resolve(!err && stdout.includes('cloudflared'));
    });
  });
}

function getDownloadUrl(): string | null {
  const platform = process.platform;
  const arch = os.arch();
  return DOWNLOAD_URLS[platform]?.[arch] ?? null;
}

function hasHomebrew(): Promise<boolean> {
  return new Promise((resolve) => {
    exec('which brew', (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

export interface InstallResult {
  installed: boolean;
  binaryPath: string | null;
  method: 'download' | 'homebrew' | 'skipped' | 'already_installed';
}

export async function promptAndInstall(log: vscode.OutputChannel): Promise<InstallResult> {
  const existing = await findCloudflared();
  if (existing) {
    return { installed: true, binaryPath: existing, method: 'already_installed' };
  }

  const downloadUrl = getDownloadUrl();
  const hasBrew = process.platform === 'darwin' && await hasHomebrew();

  const options: string[] = [];
  if (downloadUrl) options.push('Install Automatically');
  if (hasBrew) options.push('Install with Homebrew');
  options.push('Skip (local only)');

  const choice = await vscode.window.showWarningMessage(
    'Cursor Remote needs cloudflared to create a public tunnel to your session. ' +
    'Without it, you can only connect from the same network.',
    { modal: true, detail: getInstallDetail() },
    ...options
  );

  if (!choice || choice === 'Skip (local only)') {
    return { installed: false, binaryPath: null, method: 'skipped' };
  }

  if (choice === 'Install Automatically') {
    return downloadAndInstall(log);
  }

  if (choice === 'Install with Homebrew') {
    return installWithHomebrew(log);
  }

  return { installed: false, binaryPath: null, method: 'skipped' };
}

function getInstallDetail(): string {
  const lines = [
    'cloudflared creates a free, secure HTTPS tunnel from Cloudflare\'s network to your local Cursor Remote server.',
    '',
    'No account needed — it uses Cloudflare Quick Tunnels (completely free).',
    '',
    '"Install Automatically" downloads the official binary from GitHub (~30MB) into ~/.cursor-remote/bin/.',
  ];
  if (process.platform === 'darwin') {
    lines.push('"Install with Homebrew" runs `brew install cloudflared` in a terminal.');
  }
  return lines.join('\n');
}

async function downloadAndInstall(log: vscode.OutputChannel): Promise<InstallResult> {
  const url = getDownloadUrl();
  if (!url) {
    vscode.window.showErrorMessage(
      `No cloudflared binary available for ${process.platform}/${os.arch()}`
    );
    return { installed: false, binaryPath: null, method: 'download' };
  }

  const installDir = getInstallDir();
  const binaryPath = getManagedBinaryPath();
  const isTarball = url.endsWith('.tgz');

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Cursor Remote',
      cancellable: true,
    },
    async (progress, cancellation) => {
      try {
        progress.report({ message: 'Downloading cloudflared...' });
        log.appendLine(`[Installer] Downloading from ${url}`);

        fs.mkdirSync(installDir, { recursive: true });

        if (isTarball) {
          const tgzPath = path.join(installDir, 'cloudflared.tgz');

          await runCommand(`curl -fSL -o "${tgzPath}" "${url}"`, log, cancellation);
          if (cancellation.isCancellationRequested) {
            cleanup(tgzPath);
            return { installed: false, binaryPath: null, method: 'download' as const };
          }

          progress.report({ message: 'Extracting...' });
          await runCommand(`tar -xzf "${tgzPath}" -C "${installDir}"`, log, cancellation);
          cleanup(tgzPath);
        } else {
          await runCommand(`curl -fSL -o "${binaryPath}" "${url}"`, log, cancellation);
        }

        if (cancellation.isCancellationRequested) {
          cleanup(binaryPath);
          return { installed: false, binaryPath: null, method: 'download' as const };
        }

        if (process.platform !== 'win32') {
          fs.chmodSync(binaryPath, 0o755);
        }

        progress.report({ message: 'Verifying...' });
        const valid = await verifyBinary(binaryPath);
        if (!valid) {
          log.appendLine('[Installer] Downloaded binary failed verification');
          cleanup(binaryPath);
          vscode.window.showErrorMessage(
            'Downloaded cloudflared binary appears invalid. Try installing manually with: brew install cloudflared'
          );
          return { installed: false, binaryPath: null, method: 'download' as const };
        }

        log.appendLine(`[Installer] cloudflared installed at ${binaryPath}`);
        vscode.window.showInformationMessage('cloudflared installed successfully!');
        return { installed: true, binaryPath, method: 'download' as const };
      } catch (err: any) {
        log.appendLine(`[Installer] Download failed: ${err.message}`);
        cleanup(binaryPath);
        vscode.window.showErrorMessage(
          `Failed to download cloudflared: ${err.message}`
        );
        return { installed: false, binaryPath: null, method: 'download' as const };
      }
    }
  );
}

async function installWithHomebrew(log: vscode.OutputChannel): Promise<InstallResult> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Cursor Remote',
      cancellable: false,
    },
    async (progress) => {
      try {
        progress.report({ message: 'Installing cloudflared via Homebrew...' });
        log.appendLine('[Installer] Running: brew install cloudflared');

        await runCommand('brew install cloudflared', log);

        progress.report({ message: 'Verifying...' });
        const binaryPath = await findCloudflared();
        if (binaryPath) {
          log.appendLine(`[Installer] Homebrew install complete: ${binaryPath}`);
          vscode.window.showInformationMessage('cloudflared installed via Homebrew!');
          return { installed: true, binaryPath, method: 'homebrew' as const };
        }

        log.appendLine('[Installer] Homebrew install completed but binary not found in PATH');
        vscode.window.showErrorMessage(
          'Homebrew installed cloudflared but it wasn\'t found in PATH. Try restarting Cursor.'
        );
        return { installed: false, binaryPath: null, method: 'homebrew' as const };
      } catch (err: any) {
        log.appendLine(`[Installer] Homebrew install failed: ${err.message}`);
        vscode.window.showErrorMessage(
          `Homebrew install failed: ${err.message}. Try running "brew install cloudflared" manually.`
        );
        return { installed: false, binaryPath: null, method: 'homebrew' as const };
      }
    }
  );
}

function runCommand(
  cmd: string,
  log: vscode.OutputChannel,
  cancellation?: vscode.CancellationToken
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = exec(cmd, { maxBuffer: 50 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        log.appendLine(`[Installer] Command failed: ${cmd}`);
        log.appendLine(`[Installer] stderr: ${stderr}`);
        reject(err);
      } else {
        resolve(stdout);
      }
    });

    cancellation?.onCancellationRequested(() => {
      proc.kill();
      reject(new Error('Cancelled by user'));
    });
  });
}

function cleanup(filePath: string) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {}
}
