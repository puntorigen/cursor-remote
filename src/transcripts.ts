import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
}

const CURSOR_PROJECTS_DIR = path.join(os.homedir(), '.cursor', 'projects');

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

      return {
        slug: d.name,
        path: wsPath,
        name: path.basename(wsPath),
        lastModified,
        chatCount,
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

  const results: ChatSummary[] = [];

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

    results.push({
      id: entry.name,
      firstMessage,
      messageCount: lines.length,
      lastModified: stat.mtimeMs,
    });
  }

  return results.sort((a, b) => b.lastModified - a.lastModified);
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

  return lines.map((line, idx) => {
    try {
      const parsed = JSON.parse(line);
      const text = extractText(parsed);
      const toolCalls = extractToolCalls(text);
      return {
        role: parsed.role || 'assistant',
        content: text,
        toolCalls,
        timestamp: idx,
      };
    } catch {
      return { role: 'assistant' as const, content: line, timestamp: idx };
    }
  });
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