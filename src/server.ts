import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import express from 'express';
import * as vscode from 'vscode';
import * as os from 'os';
import {
  listProjects,
  listChats,
  getChat,
  getChatSince,
  getChatFileSize,
  getAiModifiedFiles,
  slugToPath,
} from './transcripts';
import { getGitStatus, getFileDiff, getGitDiffStat } from './files';
import { MessageInjector } from './injector';

function parseCookie(cookieStr: string, name: string): string | null {
  const match = cookieStr.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export interface WindowEntry {
  slug: string;
  workspace: string;
  port: number;
}

export class RemoteServer {
  private app: express.Express;
  private server: http.Server | null = null;
  private authToken: string;
  private injector: MessageInjector;
  private log: vscode.OutputChannel;
  private tunnelUrl: string | null = null;
  private boundPort: number = 0;

  /** slug -> { slug, workspace, port } — only maintained on the primary */
  private registry = new Map<string, WindowEntry>();

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

  // ── Registry ────────────────────────────────────────────────────────────

  registerWindow(slug: string, workspace: string, port: number) {
    this.registry.set(slug, { slug, workspace, port });
    this.log.appendLine(`[Registry] Registered ${slug} -> :${port} (${workspace})`);
  }

  unregisterByPort(port: number) {
    for (const [slug, entry] of this.registry) {
      if (entry.port === port) {
        this.registry.delete(slug);
        this.log.appendLine(`[Registry] Unregistered ${slug} (:${port})`);
        return;
      }
    }
  }

  getRegistry(): WindowEntry[] {
    return [...this.registry.values()];
  }

  /**
   * Tell every Cursor instance to reload.
   * If called on a secondary, delegates to the primary (which has the full registry).
   * If called on the primary, sends reload to all secondaries then reloads itself.
   */
  reloadAllWindows(primaryPort?: number) {
    if (primaryPort && this.boundPort !== primaryPort) {
      // Secondary: ask primary to coordinate the full reload
      const data = JSON.stringify({});
      const req = http.request({
        hostname: '127.0.0.1',
        port: primaryPort,
        path: '/api/_reloadAll',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      }, () => {});
      req.on('error', () => {
        // Primary unreachable — just reload self
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
      req.write(data);
      req.end();
      // Also reload self (primary will handle the others)
      setTimeout(() => {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 300);
      return;
    }

    // Primary: send reload to every registered window except self
    for (const entry of this.registry.values()) {
      if (entry.port === this.boundPort) continue;
      const data = JSON.stringify({});
      const req = http.request({
        hostname: '127.0.0.1',
        port: entry.port,
        path: '/api/_reload',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
        },
      }, () => {});
      req.on('error', () => {});
      req.write(data);
      req.end();
    }
    setTimeout(() => {
      vscode.commands.executeCommand('workbench.action.reloadWindow');
    }, 500);
  }

  private getPortForSlug(slug: string): number | null {
    return this.registry.get(slug)?.port ?? null;
  }

  // ── Proxy ───────────────────────────────────────────────────────────────

  /**
   * Proxies a request to another window's server on localhost.
   * Used by the primary gateway to forward window-specific requests.
   */
  private proxyRequest(
    targetPort: number,
    req: express.Request,
    res: express.Response,
  ): void {
    const bodyStr = JSON.stringify(req.body);
    const options: http.RequestOptions = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: req.originalUrl,
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        'X-Forwarded-By': 'cursor-remote-gateway',
      },
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.status(proxyRes.statusCode ?? 502);
      for (const [key, val] of Object.entries(proxyRes.headers)) {
        if (val) res.setHeader(key, val);
      }
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      this.log.appendLine(`[Proxy] Error forwarding to :${targetPort}: ${err.message}`);
      res.status(502).json({ error: `Proxy error: ${err.message}` });
    });

    proxyReq.write(bodyStr);
    proxyReq.end();
  }

  /**
   * If slug maps to a different window, proxy the request there.
   * Returns true if proxied (caller should not handle further).
   */
  private maybeProxy(
    slug: string | undefined,
    req: express.Request,
    res: express.Response,
  ): boolean {
    if (!slug) return false;
    const targetPort = this.getPortForSlug(slug);
    if (!targetPort || targetPort === this.boundPort) return false;
    this.log.appendLine(`[Proxy] Routing ${req.path} for slug=${slug} -> :${targetPort}`);
    this.proxyRequest(targetPort, req, res);
    return true;
  }

  // ── Composer ID resolution ──────────────────────────────────────────────

  /**
   * The transcript chat UUID IS the Cursor composer ID (they are the same).
   * We verify it exists in allComposers and pass it through directly.
   * The patched _submitChat command will call showAndFocus to activate the
   * tab before submitting, even if it wasn't previously loaded/selected.
   */
  private async resolveComposerId(transcriptId: string): Promise<string | undefined> {
    try {
      const state = await this.injector.getComposerState();
      if (!state.ok) return transcriptId;

      if (state.composers?.some(c => c.id === transcriptId)) {
        this.log.appendLine(
          `[Server] Composer ${transcriptId.slice(0, 8)}… found in allComposers — using directly`
        );
        return transcriptId;
      }

      // Not in allComposers — fall back to selected composer
      if (state.selectedComposerId) {
        this.log.appendLine(
          `[Server] Composer ${transcriptId.slice(0, 8)}… not in allComposers, ` +
          `falling back to selected: ${state.selectedComposerId}`
        );
        return state.selectedComposerId;
      }

      // Pass through anyway — showAndFocus in the patch will handle it
      return transcriptId;
    } catch {
      return transcriptId;
    }
  }

  // ── Middleware ───────────────────────────────────────────────────────────

  private setupMiddleware() {
    this.app.use(express.json());

    this.app.use((req, res, next) => {
      // Internal registration endpoints from other windows — no auth needed
      // (localhost-only, not exposed via tunnel)
      if (req.path.startsWith('/api/_') && req.headers['x-forwarded-by'] !== 'cursor-remote-gateway') {
        return next();
      }

      const publicPaths = ['/manifest.json', '/favicon.ico'];
      if (
        req.path.startsWith('/static/') ||
        publicPaths.includes(req.path)
      ) {
        return next();
      }

      // Proxied requests from gateway are trusted
      if (req.headers['x-forwarded-by'] === 'cursor-remote-gateway') {
        return next();
      }

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

  // ── Routes ──────────────────────────────────────────────────────────────

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

    // ── Internal registration (no auth) ─────────────────────────────────

    this.app.post('/api/_register', (req, res) => {
      const { slug, workspace, port } = req.body;
      if (!slug || !port) {
        res.status(400).json({ error: 'slug and port required' });
        return;
      }
      this.registerWindow(slug, workspace || '', port);
      res.json({ ok: true });
    });

    this.app.post('/api/_unregister', (req, res) => {
      const { port } = req.body;
      if (!port) {
        res.status(400).json({ error: 'port required' });
        return;
      }
      this.unregisterByPort(port);
      res.json({ ok: true });
    });

    this.app.get('/api/_registry', (_req, res) => {
      res.json(this.getRegistry());
    });

    this.app.post('/api/_reload', (_req, res) => {
      res.json({ ok: true });
      setTimeout(() => {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }, 200);
    });

    this.app.post('/api/_reloadAll', (_req, res) => {
      res.json({ ok: true });
      this.reloadAllWindows();
    });

    // ── Read-only endpoints (served from any window, no proxy needed) ───

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
        boundPort: this.boundPort,
        registry: this.getRegistry(),
        uptime: process.uptime(),
      });
    });

    this.app.get('/api/projects', (_req, res) => {
      try {
        const projects = listProjects();
        const openSlugs = new Set(this.registry.keys());
        const enriched = projects.map((p) => ({
          ...p,
          hasOpenWindow: openSlugs.has(p.slug),
        }));
        res.json(enriched);
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

    // ── Asset serving (images from project assets folders) ────────────

    this.app.get('/api/projects/:slug/assets/:filename', (req, res) => {
      const cursorProjects = path.join(os.homedir(), '.cursor', 'projects');
      const fileName = path.basename(req.params.filename);
      const filePath = path.join(cursorProjects, req.params.slug, 'assets', fileName);

      if (!fs.existsSync(filePath)) {
        res.status(404).send('Asset not found');
        return;
      }

      const ext = path.extname(fileName).toLowerCase();
      const imageMimes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
      };
      const contentType = imageMimes[ext];
      if (!contentType) {
        res.status(403).send('Only image files are served');
        return;
      }

      res.type(contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      fs.createReadStream(filePath).pipe(res);
    });

    // ── Workspace file serving (PDFs, images, etc. from project folder) ──

    this.app.get('/api/projects/:slug/files/serve', (req, res) => {
      const filePath = req.query.path as string;
      if (!filePath) {
        res.status(400).json({ error: 'path query parameter required' });
        return;
      }

      const wsPath = slugToPath(req.params.slug);

      // Resolve relative paths against the project root
      const resolved = filePath.startsWith('/')
        ? filePath
        : path.resolve(wsPath, filePath);

      // Security: only allow serving files under the project root
      const normalizedResolved = path.resolve(resolved);
      const normalizedWs = path.resolve(wsPath);
      if (!normalizedResolved.startsWith(normalizedWs + path.sep) && normalizedResolved !== normalizedWs) {
        res.status(403).json({ error: 'Path is outside project folder' });
        return;
      }

      if (!fs.existsSync(normalizedResolved)) {
        res.status(404).json({ error: 'File not found' });
        return;
      }

      const stat = fs.statSync(normalizedResolved);
      if (!stat.isFile() || stat.size > 50 * 1024 * 1024) {
        res.status(403).json({ error: 'Not a servable file' });
        return;
      }

      const ext = path.extname(normalizedResolved).toLowerCase();
      const mimes: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.html': 'text/html',
        '.txt': 'text/plain',
        '.md': 'text/markdown',
        '.json': 'application/json',
        '.csv': 'text/csv',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
      };
      const contentType = mimes[ext] || 'application/octet-stream';

      res.type(contentType);
      res.setHeader('Cache-Control', 'public, max-age=3600');
      const baseName = path.basename(normalizedResolved);
      if (!contentType.startsWith('image/') && contentType !== 'application/pdf') {
        res.setHeader('Content-Disposition', `inline; filename="${baseName}"`);
      }
      fs.createReadStream(normalizedResolved).pipe(res);
    });

    // ── Launch Cursor on a project ──────────────────────────────────────

    this.app.post('/api/projects/:slug/open', (req, res) => {
      const projectSlug = req.params.slug;
      const wsPath = slugToPath(projectSlug);

      if (!fs.existsSync(wsPath)) {
        res.status(404).json({ error: `Folder not found: ${wsPath}` });
        return;
      }

      const cli = process.platform === 'win32' ? 'cursor.cmd' : 'cursor';
      this.log.appendLine(`[Server] Launching Cursor on ${wsPath}`);

      cp.execFile(cli, [wsPath], { timeout: 10_000 }, (err) => {
        if (err) {
          this.log.appendLine(`[Server] Launch failed: ${err.message}`);
        }
      });

      res.json({ ok: true, path: wsPath });
    });

    // ── Window-specific endpoints (may proxy to correct window) ─────────

    this.app.post('/api/send', async (req, res) => {
      try {
        const { message, composerId, slug } = req.body;
        if (!message || typeof message !== 'string') {
          res.status(400).json({ error: 'message field required' });
          return;
        }
        if (this.maybeProxy(slug, req, res)) return;

        // The web UI sends the transcript chat ID as composerId, but the
        // injector needs Cursor's internal composer ID.  We resolve the
        // correct composer on the target window by matching the transcript
        // ID to live composer state, falling back to the selected composer.
        const resolvedComposerId = composerId
          ? await this.resolveComposerId(composerId)
          : undefined;

        this.log.appendLine(
          `[Server] Message from remote: ${message.slice(0, 80)}...` +
          (composerId ? ` (transcript: ${composerId})` : '') +
          (resolvedComposerId ? ` (resolved composer: ${resolvedComposerId})` : '') +
          (slug ? ` (slug: ${slug})` : '')
        );
        const result = await this.injector.send(message, resolvedComposerId);
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

    this.app.get('/api/composers', async (req, res) => {
      try {
        const slug = req.query.slug as string | undefined;
        if (this.maybeProxy(slug, req, res)) return;

        const state = await this.injector.getComposerState();
        res.json(state);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post('/api/set-text', async (req, res) => {
      try {
        const { text, composerId, slug } = req.body;
        if (!text || typeof text !== 'string') {
          res.status(400).json({ error: 'text field required' });
          return;
        }
        if (this.maybeProxy(slug, req, res)) return;

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

  getBoundPort(): number {
    return this.boundPort;
  }

  start(port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(this.app);
      this.server.listen(port, '0.0.0.0', () => {
        this.boundPort = port;
        this.log.appendLine(`[Server] Listening on http://localhost:${port}`);
        resolve(port);
      });
      this.server.on('error', reject);
    });
  }

  /**
   * Try binding to `startPort`, incrementing up to `maxRetries` times on EADDRINUSE.
   * Returns the actual port bound.
   */
  async startWithRetry(startPort: number, maxRetries = 10): Promise<number> {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const port = startPort + attempt;
      try {
        return await this.start(port);
      } catch (err: any) {
        if (err.code === 'EADDRINUSE' && attempt < maxRetries) {
          this.log.appendLine(`[Server] Port ${port} in use, trying ${port + 1}...`);
          continue;
        }
        throw err;
      }
    }
    throw new Error(`All ports ${startPort}-${startPort + maxRetries} in use`);
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
