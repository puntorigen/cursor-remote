import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallInfo[];
  timestamp?: number;
}

export interface ToolCallInfo {
  tool: string;
  filePath?: string;
  operation?: 'edit' | 'create' | 'delete' | 'read' | 'other';
}

export interface ChatSummary {
  id: string;
  title: string;
  firstMessage: string;
  messageCount: number;
  lastModified: number;
}

export interface ProjectInfo {
  slug: string;
  path: string;
  name: string;
  lastModified: number;
  chatCount: number;
  isOrphan: boolean;
}

const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');

function getStateDbPath(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'linux':
      return path.join(os.homedir(), '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return '';
  }
}

/**
 * Batch-read chat titles from Cursor's internal state.vscdb for a list of composer IDs.
 * First checks the global cursorDiskKV table, then falls back to per-workspace
 * composer.composerData (ItemTable) which stores allComposers with names.
 * Returns a Map<composerId, title>.
 */
function getChatTitles(composerIds: string[], projectSlug?: string): Map<string, string> {
  const titles = new Map<string, string>();
  if (composerIds.length === 0) return titles;

  const dbPath = getStateDbPath();
  if (!dbPath || !fs.existsSync(dbPath)) return titles;

  // Step 1: global cursorDiskKV (fast per-composer lookup)
  try {
    const placeholders = composerIds.map((id) => `'composerData:${id}'`).join(',');
    const query = `SELECT key, value FROM cursorDiskKV WHERE key IN (${placeholders});`;
    const raw = execSync(`sqlite3 -json "${dbPath}" "${query}"`, {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const rows: { key: string; value: string }[] = JSON.parse(raw || '[]');
    for (const row of rows) {
      try {
        const composerId = row.key.replace('composerData:', '');
        const data = JSON.parse(row.value);
        if (data.name) {
          titles.set(composerId, data.name);
        }
      } catch {}
    }
  } catch {}

  // Step 2: if any IDs still missing, check workspace-level composer.composerData
  const missing = composerIds.filter((id) => !titles.has(id));
  if (missing.length > 0) {
    const wsDb = projectSlug ? findWorkspaceDb(projectSlug) : undefined;
    if (wsDb) {
      const wsTitles = getWorkspaceComposerTitles(wsDb, missing);
      for (const [id, name] of wsTitles) {
        titles.set(id, name);
      }
    }
  }

  return titles;
}

function getWorkspaceStorageDir(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
    case 'linux':
      return path.join(os.homedir(), '.config', 'Cursor', 'User', 'workspaceStorage');
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Cursor', 'User', 'workspaceStorage');
    default:
      return '';
  }
}

let _wsDbCache: Map<string, string> | undefined;

/**
 * Finds the workspace-level state.vscdb for a given project slug by reading
 * workspace.json files in each workspaceStorage folder. Results are cached.
 */
function findWorkspaceDb(projectSlug: string): string | undefined {
  if (!_wsDbCache) {
    _wsDbCache = new Map();
    const storageDir = getWorkspaceStorageDir();
    if (!storageDir || !fs.existsSync(storageDir)) return undefined;

    for (const entry of fs.readdirSync(storageDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const wsJsonPath = path.join(storageDir, entry.name, 'workspace.json');
      const dbFile = path.join(storageDir, entry.name, 'state.vscdb');
      if (!fs.existsSync(wsJsonPath) || !fs.existsSync(dbFile)) continue;

      try {
        const wsJson = JSON.parse(fs.readFileSync(wsJsonPath, 'utf-8'));
        const folder: string = wsJson.folder || '';
        // folder is like "file:///Users/pabloschaffner/Documents/code/okidoki"
        // Convert to slug format: Users-pabloschaffner-Documents-code-okidoki
        const fsPath = folder.replace(/^file:\/\//, '').replace(/\/$/, '');
        if (fsPath) {
          const slug = fsPath.replace(/^\//, '').replace(/\//g, '-');
          _wsDbCache.set(slug, dbFile);
        }
      } catch {}
    }
  }

  return _wsDbCache.get(projectSlug);
}

/**
 * Reads composer titles from a workspace-level state.vscdb.
 * The data is stored in ItemTable under key 'composer.composerData' as a
 * JSON object with an allComposers array.
 */
function getWorkspaceComposerTitles(dbPath: string, composerIds: string[]): Map<string, string> {
  const titles = new Map<string, string>();
  const idSet = new Set(composerIds);

  try {
    const raw = execSync(
      `sqlite3 "${dbPath}" "SELECT value FROM ItemTable WHERE key = 'composer.composerData';"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (!raw.trim()) return titles;

    const data = JSON.parse(raw);
    const allComposers: { composerId: string; name?: string }[] = data.allComposers || [];
    for (const c of allComposers) {
      if (c.name && idSet.has(c.composerId)) {
        titles.set(c.composerId, c.name);
      }
    }
  } catch {}

  return titles;
}

const TOOL_PATTERNS: Record<string, 'edit' | 'create' | 'delete' | 'read'> = {
  StrReplace: 'edit',
  Write: 'create',
  Delete: 'delete',
  EditNotebook: 'edit',
  Read: 'read',
};

export function slugToPath(slug: string): string {
  return '/' + slug.replace(/-/g, '/');
}

export function pathToSlug(fsPath: string): string {
  return fsPath.replace(/^\//, '').replace(/\//g, '-');
}

export function listProjects(): ProjectInfo[] {
  if (!fs.existsSync(CURSOR_PROJECTS_DIR)) return [];

  return fs
    .readdirSync(CURSOR_PROJECTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const wsPath = slugToPath(d.name);
      const transcriptsDir = path.join(CURSOR_PROJECTS_DIR, d.name, 'agent-transcripts');
      let lastModified = 0;
      let chatCount = 0;

      if (fs.existsSync(transcriptsDir)) {
        for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const jsonlFile = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
          if (fs.existsSync(jsonlFile)) {
            chatCount++;
            const mtime = fs.statSync(jsonlFile).mtimeMs;
            if (mtime > lastModified) lastModified = mtime;
          }
        }
      }

      if (lastModified === 0) {
        try {
          lastModified = fs.statSync(path.join(CURSOR_PROJECTS_DIR, d.name)).mtimeMs;
        } catch {}
      }

      const isOrphan = /^\d+$/.test(d.name);

      return {
        slug: d.name,
        path: wsPath,
        name: isOrphan ? `Untitled chat (${d.name})` : path.basename(wsPath),
        lastModified,
        chatCount,
        isOrphan,
      };
    })
    .sort((a, b) => b.lastModified - a.lastModified);
}

export function listChats(projectSlug: string): ChatSummary[] {
  const transcriptsDir = path.join(
    CURSOR_PROJECTS_DIR,
    projectSlug,
    'agent-transcripts'
  );
  if (!fs.existsSync(transcriptsDir)) return [];

  const chatIds: string[] = [];
  const chatMeta: { id: string; firstMessage: string; messageCount: number; lastModified: number }[] = [];

  for (const entry of fs.readdirSync(transcriptsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const jsonlFile = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
    if (!fs.existsSync(jsonlFile)) continue;

    const stat = fs.statSync(jsonlFile);
    const lines = fs
      .readFileSync(jsonlFile, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());

    let firstMessage = '(empty)';
    if (lines.length > 0) {
      try {
        const first = JSON.parse(lines[0]);
        const text = extractText(first);
        firstMessage = text.slice(0, 120);
      } catch {}
    }

    chatIds.push(entry.name);
    chatMeta.push({
      id: entry.name,
      firstMessage,
      messageCount: lines.length,
      lastModified: stat.mtimeMs,
    });
  }

  const titles = getChatTitles(chatIds, projectSlug);

  return chatMeta
    .map((m) => ({
      ...m,
      title: titles.get(m.id) || '',
    }))
    .sort((a, b) => b.lastModified - a.lastModified);
}

export function getChat(projectSlug: string, chatId: string): TranscriptMessage[] {
  const jsonlFile = path.join(
    CURSOR_PROJECTS_DIR,
    projectSlug,
    'agent-transcripts',
    chatId,
    `${chatId}.jsonl`
  );
  if (!fs.existsSync(jsonlFile)) return [];

  const lines = fs
    .readFileSync(jsonlFile, 'utf-8')
    .split('\n')
    .filter((l) => l.trim());

  const raw = lines.map((line, idx) => {
    try {
      const parsed = JSON.parse(line);
      const text = extractText(parsed);
      const toolCalls = extractToolCalls(text);
      return {
        role: (parsed.role || 'assistant') as 'user' | 'assistant',
        content: text,
        toolCalls,
        timestamp: idx,
      };
    } catch {
      return { role: 'assistant' as const, content: line, timestamp: idx };
    }
  });

  return deduplicateReplayedMessages(raw);
}

export function getChatSince(
  projectSlug: string,
  chatId: string,
  sinceIndex: number
): TranscriptMessage[] {
  const all = getChat(projectSlug, chatId);
  return all.slice(sinceIndex);
}

export function getChatFileSize(projectSlug: string, chatId: string): number {
  const jsonlFile = path.join(
    CURSOR_PROJECTS_DIR,
    projectSlug,
    'agent-transcripts',
    chatId,
    `${chatId}.jsonl`
  );
  if (!fs.existsSync(jsonlFile)) return 0;
  return fs.statSync(jsonlFile).mtimeMs;
}

export function getAiModifiedFiles(
  projectSlug: string,
  chatId: string
): { path: string; operations: string[] }[] {
  const messages = getChat(projectSlug, chatId);
  const fileMap = new Map<string, Set<string>>();

  for (const msg of messages) {
    if (!msg.toolCalls) continue;
    for (const tc of msg.toolCalls) {
      if (tc.filePath && tc.operation && tc.operation !== 'read') {
        if (!fileMap.has(tc.filePath)) {
          fileMap.set(tc.filePath, new Set());
        }
        fileMap.get(tc.filePath)!.add(tc.operation);
      }
    }
  }

  return Array.from(fileMap.entries()).map(([p, ops]) => ({
    path: p,
    operations: Array.from(ops),
  }));
}

/**
 * When a conversation is continued across sessions, Cursor replays earlier user
 * messages (without their assistant replies) as a block of consecutive user lines.
 * This removes those duplicated user lines so the chat renders cleanly.
 */
function deduplicateReplayedMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  const seenUserContent = new Set<string>();
  const result: TranscriptMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === 'user') {
      const key = msg.content.trim();
      const prevIsUser = i > 0 && messages[i - 1].role === 'user';
      const nextIsUser = i + 1 < messages.length && messages[i + 1].role === 'user';
      const inUserRun = prevIsUser || nextIsUser;

      if (inUserRun && seenUserContent.has(key)) {
        continue;
      }
      seenUserContent.add(key);
    }

    result.push(msg);
  }

  return result;
}

function extractText(parsed: any): string {
  if (typeof parsed.message?.content === 'string') return parsed.message.content;
  if (Array.isArray(parsed.message?.content)) {
    return parsed.message.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');
  }
  return JSON.stringify(parsed);
}

function extractToolCalls(text: string): ToolCallInfo[] {
  const calls: ToolCallInfo[] = [];

  for (const [toolName, operation] of Object.entries(TOOL_PATTERNS)) {
    // Match tool invocations and extract the file path parameter
    const invokeTag = `invoke name="${toolName}"`;
    const pathParam = 'parameter name="path"';
    let searchFrom = 0;

    while (true) {
      const invokeIdx = text.indexOf(invokeTag, searchFrom);
      if (invokeIdx === -1) break;

      const pathIdx = text.indexOf(pathParam, invokeIdx);
      if (pathIdx === -1) break;

      const valueStart = text.indexOf('>', pathIdx) + 1;
      const valueEnd = text.indexOf('<', valueStart);

      if (valueStart > 0 && valueEnd > valueStart) {
        const filePath = text.slice(valueStart, valueEnd).trim();
        if (filePath) {
          calls.push({ tool: toolName, filePath, operation });
        }
      }

      searchFrom = invokeIdx + invokeTag.length;
    }
  }

  return calls;
}