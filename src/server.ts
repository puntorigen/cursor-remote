import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import express from 'express';
import * as vscode from 'vscode';
import {
  listProjects,
  listChats,
  getChat,
  getChatSince,
  getChatFileSize,
  getAiModifiedFiles,
} from './transcripts';
import { getGitStatus, getFileDiff, getGitDiffStat } from './files';
import { MessageInjector } from './injector';

function parseCookie(cookieStr: string, name: string): string | null {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export class RemoteServer {
  private app: express.Express;
  private server: http.Server | null = null;
  private authToken: string;
  private injector: MessageInjector;
  private log: vscode.OutputChannel;
  private tunnelUrl: string | null = null;

  constructor(
    injector: MessageInjector,
    authToken: string,
    log: vscode.OutputChannel
  ) {
    this.injector = injector;
    this.authToken = authToken;
    this.log = log;
    this.app = express();
    this.setupMiddleware();
    this.setupRoutes();
  }

  private setupMiddleware() {
    this.app.use(express.json());

    this.app.use((req, res, next) => {
      // Public paths that never need auth (assets loaded by the authenticated page)
      const publicPaths = ['/manifest.json', '/favicon.ico'];
      if (
        req.path.startsWith('/static/') ||
        publicPaths.includes(req.path)
      ) {
        return next();
      }

      // For the root page, accept token from query string and set a cookie
      if (req.path === '/') {
        const tokenFromQuery = req.query.token as string;
        if (tokenFromQuery === this.authToken) {
          res.setHeader(
            'Set-Cookie',
            `cr_token=${this.authToken}; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}; Path=/`
          );
          return next();
        }
        const cookieToken = parseCookie(req.headers.cookie || '', 'cr_token');
        if (cookieToken === this.authToken) {
          return next();
        }
      }

      // For API paths, check Authorization header, query param, or cookie
      const authHeader = req.headers.authorization;
      const tokenFromQuery = req.query.token as string;
      const cookieToken = parseCookie(req.headers.cookie || '', 'cr_token');
      const token =
        authHeader?.replace('Bearer ', '') ||
        tokenFromQuery ||
        cookieToken;

      if (token !== this.authToken) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      next();
    });
  }

  private setupRoutes() {
    this.app.get('/', (_req, res) => {
      const webviewPath = path.join(__dirname, '..', 'webview', 'index.html');
      if (fs.existsSync(webviewPath)) {
        let html = fs.readFileSync(webviewPath, 'utf-8');
        html = html.replace('__AUTH_TOKEN__', this.authToken);
        res.type('html').send(html);
      } else {
        res.status(404).send('Webview not found');
      }
    });

    this.app.get('/static/:file', (req, res) => {
      const webviewDir = path.join(__dirname, '..', 'webview');
      const fileName = path.basename(req.params.file);
      const filePath = path.join(webviewDir, fileName);

      this.log.appendLine(`[Server] Static request: ${req.params.file} -> ${filePath} (exists: ${fs.existsSync(filePath)})`);

      if (!fs.existsSync(filePath)) {
        res.status(404).send(`Not found: ${fileName}`);
        return;
      }

      const ext = path.extname(fileName).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.css': 'text/css',
        '.js': 'application/javascript',
        '.html': 'text/html',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      const content = fs.readFileSync(filePath);
      res.type(contentType).send(content);
    });

    this.app.get('/api/status', (_req, res) => {
      const wsFolder = vscode.workspace.workspaceFolders?.[0];
      const wsPath = wsFolder?.uri.fsPath || null;
      const wsName = wsFolder?.name || null;
      res.json({
        version: '0.1.0',
        workspace: wsPath,
        workspaceName: wsName,
        injectionMethod: this.injector.getMethod(),
        patchAvailable: this.injector.isPatchAvailable(),
        tunnelUrl: this.tunnelUrl,
        uptime: process.uptime(),
      });
    });

    this.app.get('/api/projects', (_req, res) => {
      try {
        res.json(listProjects());
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/projects/:slug/chats', (req, res) => {
      try {
        res.json(listChats(req.params.slug));
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/projects/:slug/chats/:id', (req, res) => {
      try {
        const since = parseInt(req.query.since as string);
        if (!isNaN(since) && since > 0) {
          res.json({
            messages: getChatSince(req.params.slug, req.params.id, since),
            fromIndex: since,
          });
        } else {
          res.json({ messages: getChat(req.params.slug, req.params.id), fromIndex: 0 });
        }
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/projects/:slug/chats/:id/poll', (req, res) => {
      try {
        const lastModified = getChatFileSize(req.params.slug, req.params.id);
        res.json({ lastModified });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/projects/:slug/chats/:id/files', (req, res) => {
      try {
        res.json(getAiModifiedFiles(req.params.slug, req.params.id));
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/projects/:slug/files', async (req, res) => {
      try {
        const changes = await getGitStatus(req.params.slug);
        const stat = await getGitDiffStat(req.params.slug);
        res.json({ changes, stat });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/projects/:slug/files/diff', async (req, res) => {
      try {
        const filePath = req.query.path as string;
        const staged = req.query.staged === 'true';
        if (!filePath) {
          res.status(400).json({ error: 'path query parameter required' });
          return;
        }
        const diff = await getFileDiff(req.params.slug, filePath, staged);
        res.json(diff);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/send', async (req, res) => {
      try {
        const { message, composerId } = req.body;
        if (!message || typeof message !== 'string') {
          res.status(400).json({ error: 'message field required' });
          return;
        }
        this.log.appendLine(
          `[Server] Received message from remote: ${message.slice(0, 80)}...` +
          (composerId ? ` (composer: ${composerId})` : '')
        );
        const result = await this.injector.send(message, composerId);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/diagnostics', async (_req, res) => {
      try {
        this.log.appendLine('[Server] Running safe diagnostics (read-only)...');
        const diag = await this.injector.diagnose();
        this.log.appendLine(`[Server] Platform: ${diag.platform}`);
        this.log.appendLine(`[Server] Patch: ${diag.patchApplied}`);
        this.log.appendLine(`[Server] Commands: ${diag.patchedCommandsAvailable}`);
        this.log.appendLine(`[Server] Selected: ${diag.selectedComposerId}`);
        this.log.appendLine(`[Server] Open: ${diag.openComposerCount}`);
        this.log.appendLine(`[Server] ${diag.recommendation}`);
        res.json(diag);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/api/composers', async (_req, res) => {
      try {
        const state = await this.injector.getComposerState();
        res.json(state);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/set-text', async (req, res) => {
      try {
        const { text, composerId } = req.body;
        if (!text || typeof text !== 'string') {
          res.status(400).json({ error: 'text field required' });
          return;
        }
        const result = await this.injector.setText(text, composerId);
        res.json(result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.get('/manifest.json', (_req, res) => {
      res.json({
        name: 'Cursor Remote',
        short_name: 'CursorRemote',
        start_url: `/?token=${this.authToken}`,
        display: 'standalone',
        background_color: '#0f0f0f',
        theme_color: '#3b82f6',
        icons: [],
      });
    });
  }

  setTunnelUrl(url: string) {
    this.tunnelUrl = url;
  }

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.app);
      this.server.listen(port, '0.0.0.0', () => {
        this.log.appendLine(`[Server] Listening on http://localhost:${port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }
}
