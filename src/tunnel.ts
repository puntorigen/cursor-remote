import { ChildProcess, spawn } from 'child_process';
import * as vscode from 'vscode';
import { findCloudflared, promptAndInstall } from './installer';

const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const STARTUP_TIMEOUT_MS = 20000;
const RESTART_DELAY_MS = 3000;
const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 60000;

export class TunnelManager {
  private process: ChildProcess | null = null;
  private url: string | null = null;
  private port: number = 0;
  private binaryPath: string | null = null;
  private restartTimestamps: number[] = [];
  private intentionallyStopped = false;
  private onUrlChange: ((url: string | null) => void) | null = null;

  constructor(private log: vscode.OutputChannel) {}

  setOnUrlChange(cb: (url: string | null) => void) {
    this.onUrlChange = cb;
  }

  async ensureInstalled(): Promise<string | null> {
    const existing = await findCloudflared();
    if (existing) {
      this.binaryPath = existing;
      this.log.appendLine(`[Tunnel] Found cloudflared at ${existing}`);
      return existing;
    }

    this.log.appendLine('[Tunnel] cloudflared not found, prompting install...');
    const result = await promptAndInstall(this.log);

    if (result.installed && result.binaryPath) {
      this.binaryPath = result.binaryPath;
      this.log.appendLine(`[Tunnel] Installed via ${result.method}: ${result.binaryPath}`);
      return result.binaryPath;
    }

    return null;
  }

  async start(port: number): Promise<string | null> {
    this.port = port;
    this.intentionallyStopped = false;

    if (!this.binaryPath) {
      const binary = await this.ensureInstalled();
      if (!binary) return null;
    }

    return this.spawnTunnel();
  }

  private async spawnTunnel(): Promise<string | null> {
    if (!this.binaryPath) return null;

    return new Promise((resolve) => {
      this.log.appendLine(`[Tunnel] Starting ${this.binaryPath}...`);

      try {
        this.process = spawn(this.binaryPath!, ['tunnel', '--url', `http://localhost:${this.port}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err: any) {
        this.log.appendLine(`[Tunnel] Failed to spawn: ${err.message}`);
        resolve(null);
        return;
      }

      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.log.appendLine('[Tunnel] Timeout waiting for tunnel URL');
          resolve(null);
        }
      }, STARTUP_TIMEOUT_MS);

      const handleOutput = (data: Buffer) => {
        const text = data.toString();
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) this.log.appendLine(`[Tunnel] ${trimmed}`);
        }

        const urlMatch = text.match(TUNNEL_URL_RE);
        if (urlMatch && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          this.url = urlMatch[0];
          this.log.appendLine(`[Tunnel] Public URL: ${this.url}`);
          this.onUrlChange?.(this.url);
          resolve(this.url);
        }
      };

      this.process.stdout?.on('data', handleOutput);
      this.process.stderr?.on('data', handleOutput);

      this.process.on('error', (err) => {
        this.log.appendLine(`[Tunnel] Process error: ${err.message}`);
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve(null);
        }
      });

      this.process.on('close', (code) => {
        this.log.appendLine(`[Tunnel] Process exited with code ${code}`);
        const previousUrl = this.url;
        this.url = null;
        this.process = null;

        if (previousUrl) {
          this.onUrlChange?.(null);
        }

        if (!this.intentionallyStopped && this.port > 0) {
          this.maybeRestart();
        }
      });
    });
  }

  private async maybeRestart() {
    const now = Date.now();
    this.restartTimestamps = this.restartTimestamps.filter(
      (t) => now - t < RESTART_WINDOW_MS
    );

    if (this.restartTimestamps.length >= MAX_RESTARTS) {
      this.log.appendLine(
        `[Tunnel] Too many restarts (${MAX_RESTARTS} in ${RESTART_WINDOW_MS / 1000}s), giving up`
      );
      vscode.window
        .showErrorMessage(
          'Cursor Remote: Tunnel keeps crashing. Check the Output panel for details.',
          'Retry',
          'View Logs'
        )
        .then((action) => {
          if (action === 'Retry') {
            this.restartTimestamps = [];
            this.start(this.port);
          } else if (action === 'View Logs') {
            this.log.show();
          }
        });
      return;
    }

    this.restartTimestamps.push(now);
    const attempt = this.restartTimestamps.length;
    this.log.appendLine(
      `[Tunnel] Restarting in ${RESTART_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RESTARTS})...`
    );

    await new Promise((r) => setTimeout(r, RESTART_DELAY_MS));

    if (this.intentionallyStopped) return;

    const newUrl = await this.spawnTunnel();
    if (newUrl) {
      this.log.appendLine(`[Tunnel] Reconnected: ${newUrl}`);
      vscode.window.showInformationMessage(
        'Cursor Remote: Tunnel reconnected',
        'Copy URL'
      ).then((action) => {
        if (action === 'Copy URL') {
          vscode.env.clipboard.writeText(newUrl);
        }
      });
    }
  }

  getUrl(): string | null {
    return this.url;
  }

  stop() {
    this.intentionallyStopped = true;
    if (this.process) {
      this.log.appendLine('[Tunnel] Stopping cloudflared...');
      this.process.kill();
      this.process = null;
      this.url = null;
    }
  }

  isRunning(): boolean {
    return this.process !== null;
  }
}
