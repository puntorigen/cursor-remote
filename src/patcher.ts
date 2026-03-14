/**
 * Patches Cursor's bundled workbench JS to expose internal composer services
 * as registered VS Code commands that our extension can call.
 *
 * Injected commands:
 *   cursorRemote._submitChat(composerId, text)
 *     — Calls composerChatService.submitChatMaybeAbortCurrent to send a message
 *       to an existing chat conversation.
 *
 *   cursorRemote._setComposerText(composerId, text)
 *     — Sets the text in a composer's input box (without submitting).
 *       Uses updateComposerData + fireShouldForceText.
 *
 *   cursorRemote._getState()
 *     — Returns { selectedComposerId, composerIds } for the current window.
 *
 *   cursorRemote._prompt({ prompt, placeholder? })
 *     — One-shot LLM query using the default model via aiService.getSimplePrompt.
 *
 *   cursorRemote._query({ prompt, model? })
 *     — Model-selectable LLM query via aiClient().getPassthroughPrompt.
 *
 * Dynamic discovery:
 *   Minified variable names (DI tokens, CommandsRegistry) are discovered at
 *   patch time by matching stable string literals that survive minification.
 *   This makes the patcher resilient to Cursor updates that re-minify variables.
 *
 * Safety:
 *   - Backup created before any modification
 *   - Patched content is syntax-validated before writing
 *   - Writes use atomic temp-file-then-rename to prevent truncation
 *   - A standalone restore script is shipped for recovery when Cursor is broken
 *   - Idempotent: sentinel check prevents double-patching
 *   - Auto-reload loop protection via globalState
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as crypto from 'crypto';
import * as os from 'os';
import * as cp from 'child_process';
import * as vscode from 'vscode';

const SENTINEL = '/* __CURSOR_REMOTE_PATCHED__ */';

const WORKBENCH_RELATIVE = path.join('out', 'vs', 'workbench', 'workbench.desktop.main.js');

let _resolvedWorkbenchPath: string | undefined;

/**
 * Locates the workbench JS file by trying multiple strategies:
 *   1. vscode.env.appRoot (the running Cursor's own resources/app dir)
 *   2. Derive from process.execPath (Cursor.exe → resources/app)
 *   3. Platform-specific default paths
 *
 * Caches the result after the first successful resolution.
 */
/**
 * Electron intercepts `fs` calls for paths inside `.asar` archives,
 * transparently reading from the archive. But we need the *real* disk
 * file for patching. `original-fs` bypasses the ASAR interception.
 * If unavailable (non-Electron context), fall back to regular fs.
 */
let realFs: typeof fs;
try {
  realFs = require('original-fs');
} catch {
  realFs = fs;
}

function getWorkbenchPath(): string {
  if (_resolvedWorkbenchPath) return _resolvedWorkbenchPath;

  const candidates: string[] = [];

  // Strategy 1: vscode.env.appRoot
  const appRoot = vscode.env.appRoot;
  if (appRoot) {
    candidates.push(path.join(appRoot, WORKBENCH_RELATIVE));
    // appRoot may point to resources/app (ASAR virtual) — also try
    // the parent if it ends with resources/app
    const stripped = appRoot.replace(/[/\\]resources[/\\]app[/\\]?$/i, '');
    if (stripped !== appRoot) {
      candidates.push(path.join(stripped, 'resources', 'app', WORKBENCH_RELATIVE));
    }
    // On Windows, Cursor may use ASAR packaging: the real file could
    // be served virtually from app.asar. Check the ASAR path too.
    const asarRoot = appRoot.replace(/[/\\]resources[/\\]app[/\\]?$/i, '');
    if (asarRoot !== appRoot) {
      candidates.push(path.join(asarRoot, 'resources', 'app.asar.unpacked', WORKBENCH_RELATIVE));
    }
  }

  // Strategy 2: derive from process.execPath (e.g. C:\...\Cursor.exe)
  if (process.execPath) {
    const execDir = path.dirname(process.execPath);
    candidates.push(path.join(execDir, 'resources', 'app', WORKBENCH_RELATIVE));
    candidates.push(path.join(execDir, 'resources', 'app.asar.unpacked', WORKBENCH_RELATIVE));
  }

  // Strategy 3: platform defaults
  if (process.platform === 'darwin') {
    candidates.push(
      path.join('/Applications', 'Cursor.app', 'Contents', 'Resources', 'app', WORKBENCH_RELATIVE),
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    for (const base of [
      path.join(localAppData, 'Programs', 'Cursor'),
      path.join(localAppData, 'cursor'),
      path.join('C:', 'Program Files', 'Cursor'),
    ]) {
      candidates.push(path.join(base, 'resources', 'app', WORKBENCH_RELATIVE));
      candidates.push(path.join(base, 'resources', 'app.asar.unpacked', WORKBENCH_RELATIVE));
    }
  } else {
    candidates.push(
      path.join('/opt', 'Cursor', 'resources', 'app', WORKBENCH_RELATIVE),
      path.join('/usr', 'lib', 'cursor', 'resources', 'app', WORKBENCH_RELATIVE),
      path.join('/usr', 'share', 'cursor', 'resources', 'app', WORKBENCH_RELATIVE),
    );
  }

  // Deduplicate and find the first existing file
  // Use original-fs to see through ASAR interception on Windows
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const normalized = path.resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      if (realFs.existsSync(normalized) && realFs.statSync(normalized).isFile()) {
        _resolvedWorkbenchPath = normalized;
        return normalized;
      }
    } catch { /* ignore */ }
  }

  // Last resort: try reading through Electron's ASAR-aware fs
  // If appRoot is inside an ASAR, Electron's fs can read it transparently.
  // We'll read from the ASAR path and extract to a writable location.
  if (appRoot) {
    const asarPath = path.join(appRoot, WORKBENCH_RELATIVE);
    try {
      if (fs.existsSync(asarPath)) {
        // File exists inside ASAR — extract to a real path we can patch
        const extractedPath = extractFromAsar(asarPath, appRoot);
        if (extractedPath) {
          _resolvedWorkbenchPath = extractedPath;
          return extractedPath;
        }
      }
    } catch { /* ignore */ }
  }

  // None found — return the best guess for error messages
  return candidates[0] || path.join('resources', 'app', WORKBENCH_RELATIVE);
}

/**
 * When Cursor uses ASAR packaging, the workbench file lives inside
 * app.asar and is only accessible through Electron's fs interception.
 * To patch it, we extract the entire app.asar to app/ on disk.
 *
 * Returns the path to the extracted workbench file, or null on failure.
 */
function extractFromAsar(virtualPath: string, appRoot: string): string | null {
  try {
    const asar = require('@electron/asar');
    const resourcesDir = appRoot.replace(/[/\\]resources[/\\]app[/\\]?$/i, path.sep + 'resources');
    const asarFile = path.join(resourcesDir, 'app.asar');
    const extractDir = path.join(resourcesDir, 'app');

    if (!realFs.existsSync(asarFile)) return null;
    if (!realFs.existsSync(extractDir)) {
      asar.extractAll(asarFile, extractDir);
    }

    const extracted = path.join(extractDir, WORKBENCH_RELATIVE);
    if (realFs.existsSync(extracted)) return extracted;
  } catch { /* @electron/asar not available or extraction failed */ }

  // Fallback: just read the content through Electron's ASAR-aware fs
  // and write it to a temporary location we can patch
  try {
    const content = fs.readFileSync(virtualPath, 'utf-8');
    // Determine a writable location alongside the ASAR
    const resourcesDir = appRoot.replace(/[/\\]resources[/\\]app[/\\]?$/i, path.sep + 'resources');
    const targetDir = path.join(resourcesDir, 'app', 'out', 'vs', 'workbench');
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, 'workbench.desktop.main.js');
    realFs.writeFileSync(targetPath, content, 'utf-8');
    return targetPath;
  } catch { /* extraction failed */ }

  return null;
}

export function getBackupPath(): string {
  return getWorkbenchPath() + '.cursor-remote-backup';
}

function getAppRoot(): string {
  const wbPath = getWorkbenchPath();
  // workbench lives at <appRoot>/out/vs/workbench/workbench.desktop.main.js
  return path.resolve(path.dirname(wbPath), '..', '..', '..');
}

function getProductJsonPath(): string {
  return path.join(getAppRoot(), 'product.json');
}

// ─── Integrity checksum ─────────────────────────────────────────────────────

const CHECKSUM_KEY = 'vs/workbench/workbench.desktop.main.js';

/**
 * Computes the same checksum that Cursor/VS Code's IntegrityServiceImpl uses:
 * SHA-256, base64-encoded, with trailing '=' padding stripped.
 */
function computeChecksum(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('base64').replace(/=+$/, '');
}

/**
 * Ensures product.json's checksum matches the given workbench content.
 * Only writes if the checksum is actually stale.
 */
function ensureChecksum(wbContent: Buffer, log: vscode.OutputChannel): void {
  try {
    const productPath = getProductJsonPath();
    if (!fs.existsSync(productPath)) return;
    const product = JSON.parse(fs.readFileSync(productPath, 'utf-8'));
    if (!product.checksums?.[CHECKSUM_KEY]) return;

    const actual = computeChecksum(wbContent);
    if (product.checksums[CHECKSUM_KEY] === actual) {
      log.appendLine('[Patcher] product.json checksum already correct');
    } else {
      updateProductChecksum(actual, log);
    }
    suppressIntegrityNotification(log);
  } catch (err: any) {
    log.appendLine(`[Patcher] Warning: checksum ensure failed: ${err.message}`);
  }
}

/**
 * Updates the workbench checksum in product.json so Cursor's integrity
 * checker sees the file as valid. Reads the current product.json, replaces
 * just the workbench entry, and writes it back atomically.
 */
function updateProductChecksum(newChecksum: string, log: vscode.OutputChannel): void {
  const productPath = getProductJsonPath();
  if (!fs.existsSync(productPath)) {
    log.appendLine(`[Patcher] product.json not found at ${productPath} — skipping checksum update`);
    return;
  }

  const raw = fs.readFileSync(productPath, 'utf-8');
  const product = JSON.parse(raw);

  if (!product.checksums || typeof product.checksums !== 'object') {
    log.appendLine('[Patcher] product.json has no checksums field — skipping');
    return;
  }

  const oldChecksum = product.checksums[CHECKSUM_KEY];
  product.checksums[CHECKSUM_KEY] = newChecksum;

  atomicWriteFileSync(productPath, JSON.stringify(product, null, '\t'));
  log.appendLine(
    `[Patcher] Updated product.json checksum: ${oldChecksum?.slice(0, 12)}... → ${newChecksum.slice(0, 12)}...`,
  );
}

// ─── Integrity notification suppression ─────────────────────────────────────

/**
 * Cursor's IntegrityServiceImpl caches checksums at boot, so even after we
 * update product.json the in-memory values are stale and the "corrupt
 * installation" notification fires. The service checks a storage key
 * `integrityService` with `{dontShowPrompt: true, commit}` before showing
 * the banner.  We write that key directly into the globalStorage SQLite DB
 * so the notification is suppressed for the current commit.
 */
function suppressIntegrityNotification(log: vscode.OutputChannel): void {
  try {
    const productPath = getProductJsonPath();
    if (!fs.existsSync(productPath)) return;
    const product = JSON.parse(fs.readFileSync(productPath, 'utf-8'));
    const commit = product.commit;
    if (!commit) return;

    const dbPath = getGlobalStorageDbPath();
    if (!dbPath || !fs.existsSync(dbPath)) {
      log.appendLine('[Patcher] globalStorage DB not found — cannot suppress integrity notification');
      return;
    }

    const value = JSON.stringify({ dontShowPrompt: true, commit });

    // Use better-sqlite3 if bundled, otherwise fall back to spawning sqlite3 CLI
    try {
      const { execFileSync } = require('child_process');
      execFileSync('sqlite3', [
        dbPath,
        `INSERT OR REPLACE INTO ItemTable (key, value) VALUES ('integrityService', '${value.replace(/'/g, "''")}');`,
      ], { timeout: 5_000 });
      log.appendLine(`[Patcher] Suppressed integrity notification for commit ${commit.slice(0, 12)}...`);
    } catch {
      log.appendLine('[Patcher] sqlite3 CLI not available — integrity notification may appear once');
    }
  } catch (err: any) {
    log.appendLine(`[Patcher] Warning: could not suppress integrity notification: ${err.message}`);
  }
}

function getGlobalStorageDbPath(): string | null {
  let base: string;
  if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor');
  } else if (process.platform === 'win32') {
    base = path.join(process.env.APPDATA || '', 'Cursor');
  } else {
    base = path.join(os.homedir(), '.config', 'Cursor');
  }
  const dbPath = path.join(base, 'User', 'globalStorage', 'state.vscdb');
  return fs.existsSync(dbPath) ? dbPath : null;
}

// ─── Dynamic variable discovery ─────────────────────────────────────────────

interface DiscoveredVars {
  createDecorator: string;
  commandsRegistry: string;
  composerDataService: string;
  composerChatService: string;
  composerEventService: string;
  composerViewsService: string;
  composerModesService: string;
  modelConfigService: string;
  aiService: string;
}

/**
 * Extracts minified variable names from the workbench JS using stable string
 * literals that survive minification. Each service is registered via
 * `createDecorator("serviceName")` where the string is stable.
 */
function discoverVariables(content: string): { vars?: DiscoveredVars; errors: string[] } {
  const errors: string[] = [];

  const servicePatterns: Record<string, string> = {
    composerDataService:  'composerDataService',
    composerChatService:  'composerChatService',
    composerEventService: 'composerEventService',
    composerViewsService: 'composerViewsService',
    composerModesService: 'composerModesService',
    modelConfigService:   'modelConfigService',
    aiService:            'aiService',
  };

  let createDecoratorName: string | undefined;
  const tokens: Record<string, string> = {};

  for (const [key, serviceId] of Object.entries(servicePatterns)) {
    // Match: VarName=FuncName("serviceId")
    // The func name is the minified createDecorator, the var is the DI token
    const re = new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*)=([A-Za-z_$][A-Za-z0-9_$]*)\\("${serviceId}"\\)`);
    const m = content.match(re);
    if (!m) {
      errors.push(`Could not find DI token for "${serviceId}"`);
      continue;
    }
    tokens[key] = m[1];
    if (!createDecoratorName) {
      createDecoratorName = m[2];
    }
  }

  if (!createDecoratorName) {
    errors.push('Could not determine createDecorator function name');
  }

  // Discover CommandsRegistry: look for the singleton that calls
  // .registerCommand("composer.acceptPlan" — a stable Cursor command ID.
  // Fall back to other known stable command IDs if needed.
  let commandsRegistryName: string | undefined;
  const anchorCommands = [
    'composer.acceptPlan',
    'workbench.action.chat.open',
    'composer.splitEditorWithNewComposer',
  ];

  for (const cmd of anchorCommands) {
    const escaped = cmd.replace(/\./g, '\\.');
    const re = new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*)\\.registerCommand\\("${escaped}"`);
    const m = content.match(re);
    if (m) {
      commandsRegistryName = m[1];
      break;
    }
  }

  if (!commandsRegistryName) {
    errors.push('Could not find CommandsRegistry variable (tried: ' + anchorCommands.join(', ') + ')');
  }

  if (errors.length > 0) {
    return { errors };
  }

  return {
    vars: {
      createDecorator: createDecoratorName!,
      commandsRegistry: commandsRegistryName!,
      composerDataService: tokens.composerDataService,
      composerChatService: tokens.composerChatService,
      composerEventService: tokens.composerEventService,
      composerViewsService: tokens.composerViewsService,
      composerModesService: tokens.composerModesService,
      modelConfigService: tokens.modelConfigService,
      aiService: tokens.aiService,
    },
    errors: [],
  };
}

// ─── Dynamic anchor discovery ───────────────────────────────────────────────

/**
 * Locates a stable injection point in the workbench JS. Searches for known
 * Cursor command registration strings and finds the end of that statement.
 * Tries multiple candidates for resilience across versions.
 *
 * Returns the character offset to insert after, or null if none found.
 */
function findInjectionPoint(content: string, commandsRegistry: string): { offset: number; anchor: string } | null {
  const anchorCommands = [
    'composer.acceptPlan',
    'workbench.action.chat.open',
    'composer.splitEditorWithNewComposer',
  ];

  for (const cmd of anchorCommands) {
    const searchStr = `${commandsRegistry}.registerCommand("${cmd}"`;
    const idx = content.indexOf(searchStr);
    if (idx === -1) continue;

    // Walk forward to find the matching close of this registerCommand(...) call
    const openIdx = content.indexOf('(', idx + commandsRegistry.length);
    if (openIdx === -1) continue;

    let depth = 0;
    let i = openIdx;
    for (; i < content.length; i++) {
      if (content[i] === '(') depth++;
      else if (content[i] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }

    if (depth !== 0) continue;

    return { offset: i + 1, anchor: cmd };
  }

  return null;
}

// ─── Patch code generation ──────────────────────────────────────────────────

function buildPatchCode(v: DiscoveredVars): string {
  const CR = v.commandsRegistry;
  const DS = v.composerDataService;
  const CS = v.composerChatService;
  const ES = v.composerEventService;
  const VS = v.composerViewsService;
  const MS = v.composerModesService;
  const MC = v.modelConfigService;
  const AI = v.aiService;

  const waitBlock = (dsVar: string, vsVar: string, idVar: string, hVar: string) => [
    `await ${vsVar}.showAndFocus(${idVar});`,
    `var ${hVar}=${dsVar}.getHandleIfLoaded(${idVar});`,
    `if(!${hVar}){for(var _w=0;_w<40;_w++){`,
      `await new Promise(function(r){setTimeout(r,50)});`,
      `${hVar}=${dsVar}.getHandleIfLoaded(${idVar});`,
      `if(${hVar})break;`,
    `}}`,
  ].join('');

  return [
    SENTINEL,

    // _submitChat: accepts optional mode + modelOverride
    `${CR}.registerCommand("cursorRemote._submitChat",async(n,e)=>{`,
      `try{`,
        `var t=e.composerId,i=e.text;`,
        `if(!t||!i)return{ok:false,error:"composerId and text required"};`,
        `var ds=n.get(${DS}),cs=n.get(${CS}),vs=n.get(${VS}),es=n.get(${ES}),ms=n.get(${MS}),mc=n.get(${MC});`,
        waitBlock('ds', 'vs', 't', 'h'),
        `if(!h)return{ok:false,error:"composer not found after showAndFocus: "+t};`,
        // Set mode if requested
        `if(e.mode){try{ms.setComposerUnifiedMode(h,e.mode)}catch(me){return{ok:false,error:"setMode failed: "+String(me)}}}`,
        // Set model on the composer if requested
        `if(e.modelOverride){try{mc.setModelConfigForComposer(h,{modelName:e.modelOverride})}catch(me){}}`,
        `ds.updateComposerData(h,{text:i,richText:i});`,
        `es.fireShouldForceText({composerId:t});`,
        `var opts={};`,
        `if(e.modelOverride)opts.modelOverride=e.modelOverride;`,
        `await cs.submitChatMaybeAbortCurrent(t,i,opts);`,
        `return{ok:true,composerId:t};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,

    `,`,

    `${CR}.registerCommand("cursorRemote._setComposerText",async(n,e)=>{`,
      `try{`,
        `var t=e.composerId,i=e.text;`,
        `if(!t||typeof i!=="string")return{ok:false,error:"composerId and text required"};`,
        `var ds=n.get(${DS}),es=n.get(${ES}),vs=n.get(${VS});`,
        waitBlock('ds', 'vs', 't', 'h'),
        `if(!h)return{ok:false,error:"composer not found after showAndFocus: "+t};`,
        `ds.updateComposerData(h,{text:i,richText:i});`,
        `es.fireShouldForceText({composerId:t});`,
        `return{ok:true,composerId:t};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,

    `,`,

    `${CR}.registerCommand("cursorRemote._getState",async(n)=>{`,
      `try{`,
        `var ds=n.get(${DS});`,
        `var sel=ds.selectedComposerId;`,
        `var ids=ds.allComposersData.selectedComposerIds||[];`,
        `var all=(ds.allComposersData.allComposers||[]).map(function(c){return{`,
          `id:c.composerId,`,
          `name:c.name||"",`,
          `status:c.status||"unknown",`,
          `lastUpdated:c.lastUpdatedAt||0`,
        `}});`,
        `return{ok:true,selectedComposerId:sel,openComposerIds:ids,composers:all};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,

    `,`,

    // _getModesAndModels: returns available modes and models
    `${CR}.registerCommand("cursorRemote._getModesAndModels",async(n)=>{`,
      `try{`,
        `var ms=n.get(${MS}),mc=n.get(${MC}),ds=n.get(${DS});`,
        // Get all modes
        `var modes=[];try{var am=ms.getAllModes();if(am&&am.length){modes=am.map(function(m){return{id:m.id,name:m.name,icon:m.icon||""}})}}catch(me){}`,
        // Get available models
        `var models=[];try{var dm=mc.getAvailableDefaultModels();if(dm&&dm.length){models=dm.map(function(m){return{name:m.name,displayName:m.displayName||m.name,defaultOn:!!m.defaultOn}})}}catch(me){}`,
        // Get current composer's mode and model
        `var sel=ds.selectedComposerId;`,
        `var currentMode="agent";var currentModel="default";`,
        `if(sel){try{currentMode=ms.getComposerUnifiedMode(sel)||"agent"}catch(me){}}`,
        `if(sel){try{var cfg=mc.getModelConfig("composer");currentModel=cfg.modelName||"default"}catch(me){}}`,
        `return{ok:true,modes:modes,models:models,currentMode:currentMode,currentModel:currentModel};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,

    `,`,

    // _prompt: simple one-shot query using the default model
    `${CR}.registerCommand("cursorRemote._prompt",async(n,e)=>{`,
      `try{`,
        `if(!e||!e.prompt)return{ok:false,error:"prompt is required"};`,
        `var ai=n.get(${AI});`,
        `var r=await ai.getSimplePrompt(e.prompt,e.placeholder||"");`,
        `return{ok:true,result:r.result||""};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,

    `,`,

    // _query: model-selectable query via getPassthroughPrompt
    `${CR}.registerCommand("cursorRemote._query",async(n,e)=>{`,
      `try{`,
        `if(!e||!e.prompt)return{ok:false,error:"prompt is required"};`,
        `var ai=n.get(${AI});`,
        `var client=ai.aiClient();`,
        `var r=await client.getPassthroughPrompt({query:e.prompt,modelName:e.model||""});`,
        `return{ok:true,result:r.result||r.response||""};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,
  ].join('');
}

// ─── Syntax validation ──────────────────────────────────────────────────────

/**
 * Validates that the injected patch code is parseable JS by compiling it
 * as a standalone comma-separated expression list. This catches syntax
 * errors in the generated code (missing braces, bad tokens, etc.) without
 * trying to parse a window of the 50MB workbench file — which would fail
 * because any fixed window lands mid-expression.
 */
function validatePatchSyntax(patchCode: string): string | null {
  try {
    // patchCode already starts with ',' so we use `0` as a leading expression
    new vm.Script(`(async function(){0${patchCode}})`, { filename: 'patch-validation.js' });
    return null;
  } catch (err: any) {
    return err.message || String(err);
  }
}

// ─── Elevated write (Windows) ────────────────────────────────────────────────

/**
 * When Cursor is installed in C:\Program Files (or another protected dir),
 * normal writes fail with EPERM. We write the patched content to a temp dir,
 * then use PowerShell Start-Process -Verb RunAs to run a helper script that
 * copies the files into place. The UAC elevation prompt fires once on the
 * desktop; this is standard Windows behaviour for system-installed apps.
 *
 * For headless/remote scenarios where UAC can't be approved interactively,
 * we also try a direct `icacls` grant on the workbench dir first.
 */
async function elevatedPatchWrite(
  wbPath: string,
  backupPath: string,
  patchedContent: string,
  log: vscode.OutputChannel,
): Promise<{ ok: boolean; error?: string }> {
  const tmpDir = path.join(os.tmpdir(), 'cursor-remote-patch');
  try { realFs.mkdirSync(tmpDir, { recursive: true }); } catch { /* ignore */ }

  const tmpPatched = path.join(tmpDir, 'workbench.desktop.main.js');
  const tmpScript  = path.join(tmpDir, 'apply-patch.bat');

  // Write patched content to temp
  realFs.writeFileSync(tmpPatched, patchedContent, 'utf-8');
  log.appendLine(`[Patcher] Wrote patched file to temp: ${tmpPatched}`);

  // Build a batch script that does the backup + copy
  const bat = [
    '@echo off',
    `if not exist "${backupPath}" (`,
    `  copy /Y "${wbPath}" "${backupPath}"`,
    `  if errorlevel 1 (`,
    `    echo BACKUP_FAILED`,
    `    exit /b 1`,
    `  )`,
    `)`,
    `copy /Y "${tmpPatched}" "${wbPath}"`,
    `if errorlevel 1 (`,
    `  echo COPY_FAILED`,
    `  exit /b 1`,
    `)`,
    `echo PATCH_OK`,
  ].join('\r\n');
  realFs.writeFileSync(tmpScript, bat, 'utf-8');

  // Strategy 1: try icacls to grant write access to the workbench directory
  const wbDir = path.dirname(wbPath);
  try {
    log.appendLine(`[Patcher] Trying icacls grant on ${wbDir}...`);
    cp.execSync(
      `icacls "${wbDir}" /grant "%USERNAME%":F /T /Q`,
      { timeout: 10_000, windowsHide: true },
    );
    // If icacls worked, try the direct write again
    if (!realFs.existsSync(backupPath)) {
      realFs.copyFileSync(wbPath, backupPath);
    }
    atomicWriteFileSync(wbPath, patchedContent);
    log.appendLine('[Patcher] Direct write succeeded after icacls grant');
    cleanupTemp(tmpDir);
    return { ok: true };
  } catch (e: any) {
    log.appendLine(`[Patcher] icacls approach failed: ${e.message}`);
  }

  // Strategy 2: PowerShell elevation with -Verb RunAs
  // This shows a UAC prompt on the desktop
  return new Promise((resolve) => {
    log.appendLine('[Patcher] Spawning elevated cmd via PowerShell...');

    const psCmd = `Start-Process -FilePath cmd.exe -ArgumentList '/c "${tmpScript}"' -Verb RunAs -Wait -WindowStyle Hidden`;
    const child = cp.exec(
      `powershell -NoProfile -Command "${psCmd}"`,
      { timeout: 30_000, windowsHide: true },
      (err, _stdout, stderr) => {
        if (err) {
          log.appendLine(`[Patcher] Elevated write failed: ${err.message}`);
          if (stderr) log.appendLine(`[Patcher] stderr: ${stderr}`);
          cleanupTemp(tmpDir);
          resolve({
            ok: false,
            error: `Elevated write failed: ${err.message}. `
              + 'Cursor is installed in a protected directory (C:\\Program Files). '
              + 'Try running Cursor as Administrator once, or re-install Cursor '
              + 'in your user profile (LOCALAPPDATA\\Programs\\Cursor).',
          });
          return;
        }

        // Verify the patch actually landed
        try {
          const verifyContent = realFs.readFileSync(wbPath, 'utf-8');
          if (verifyContent.includes(SENTINEL)) {
            log.appendLine('[Patcher] Elevated patch verified successfully');
            cleanupTemp(tmpDir);
            resolve({ ok: true });
          } else {
            log.appendLine('[Patcher] Elevated write completed but sentinel not found');
            cleanupTemp(tmpDir);
            resolve({ ok: false, error: 'Elevated write completed but patch not detected in file' });
          }
        } catch (readErr: any) {
          log.appendLine(`[Patcher] Post-elevation verify failed: ${readErr.message}`);
          cleanupTemp(tmpDir);
          resolve({ ok: false, error: `Post-elevation verification failed: ${readErr.message}` });
        }
      },
    );
    child.unref();
  });
}

function cleanupTemp(tmpDir: string): void {
  try { realFs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Atomic file write ──────────────────────────────────────────────────────

/**
 * Writes `content` to `targetPath` safely.
 *
 * On POSIX: atomic temp-file + rename approach.
 * On Windows: rename-over often fails with EPERM because the file is
 * memory-mapped by the running Cursor process; we fall back to a direct
 * truncate-and-write via writeFileSync, which Windows allows even on
 * mapped files.
 */
function atomicWriteFileSync(targetPath: string, content: string): void {
  const dir = path.dirname(targetPath);
  const tmpName = `.cursor-remote-patch-${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  try {
    const fd = realFs.openSync(tmpPath, 'w');
    try {
      realFs.writeSync(fd, content, 0, 'utf-8');
      realFs.fsyncSync(fd);
    } finally {
      realFs.closeSync(fd);
    }
    try {
      realFs.renameSync(tmpPath, targetPath);
    } catch {
      realFs.copyFileSync(tmpPath, targetPath);
      try { realFs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (err) {
    try { realFs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
}

// ─── Restore script generation ──────────────────────────────────────────────

/**
 * Writes a standalone shell script next to the backup that can restore
 * Cursor even when the app won't launch. The script is self-contained
 * and doesn't depend on Node or the extension.
 */
function writeRestoreScript(log: vscode.OutputChannel): void {
  const wbPath = getWorkbenchPath();
  const backupPath = getBackupPath();
  const scriptDir = path.dirname(wbPath);

  if (process.platform === 'win32') {
    const batPath = path.join(scriptDir, 'cursor-remote-restore.bat');
    if (fs.existsSync(batPath)) return;
    const bat = [
      '@echo off',
      'echo Cursor Remote — Restore original workbench',
      'echo.',
      `set "BACKUP=${backupPath}"`,
      `set "TARGET=${wbPath}"`,
      'if not exist "%BACKUP%" (',
      '  echo ERROR: Backup not found at %BACKUP%',
      '  echo You may need to reinstall Cursor.',
      '  pause',
      '  exit /b 1',
      ')',
      'copy /Y "%BACKUP%" "%TARGET%"',
      'if %errorlevel% neq 0 (',
      '  echo ERROR: Failed to copy. Try running as Administrator.',
      '  pause',
      '  exit /b 1',
      ')',
      'del "%BACKUP%"',
      'echo.',
      'echo Restored successfully. Please restart Cursor.',
      'pause',
    ].join('\r\n');
    fs.writeFileSync(batPath, bat, 'utf-8');
    log.appendLine(`[Patcher] Restore script: ${batPath}`);
    return;
  }

  // macOS / Linux
  const shPath = path.join(scriptDir, 'cursor-remote-restore.sh');
  if (fs.existsSync(shPath)) return;
  const sh = [
    '#!/bin/bash',
    '# Cursor Remote — Restore original workbench',
    '# Run this if Cursor won\'t launch after patching.',
    '',
    `BACKUP="${backupPath}"`,
    `TARGET="${wbPath}"`,
    '',
    'if [ ! -f "$BACKUP" ]; then',
    '  echo "ERROR: Backup not found at $BACKUP"',
    '  echo "You may need to reinstall Cursor."',
    '  exit 1',
    'fi',
    '',
    'cp "$BACKUP" "$TARGET"',
    'if [ $? -ne 0 ]; then',
    '  echo "ERROR: Copy failed. Try: sudo $0"',
    '  exit 1',
    'fi',
    '',
    'rm "$BACKUP"',
    'echo "Restored successfully. Please restart Cursor."',
  ].join('\n');
  fs.writeFileSync(shPath, sh, { mode: 0o755 });
  log.appendLine(`[Patcher] Restore script: ${shPath}`);
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface PatchStatus {
  patched: boolean;
  alreadyPatched: boolean;
  backupPath?: string;
  error?: string;
}

export function isPatchApplied(): boolean {
  const wbPath = getWorkbenchPath();
  try {
    if (!realFs.existsSync(wbPath)) return false;
    const content = realFs.readFileSync(wbPath, 'utf-8');
    return content.includes(SENTINEL);
  } catch {
    return false;
  }
}

/**
 * Returns comprehensive diagnostic info about the patcher state —
 * all candidate paths, what exists, appRoot, execPath, etc.
 * Used by the /api/debug/patcher endpoint for remote troubleshooting.
 */
export function getPatcherDebugInfo(): Record<string, unknown> {
  const appRoot = vscode.env.appRoot;
  const execPath = process.execPath;
  const execDir = path.dirname(execPath);
  const localAppData = process.env.LOCALAPPDATA || '';

  const candidates: Array<{ path: string; existsReal: boolean; existsAsar: boolean; strategy: string }> = [];
  const addCandidate = (p: string, strategy: string) => {
    const normalized = path.resolve(p);
    let existsReal = false;
    let existsAsar = false;
    try { existsReal = realFs.existsSync(normalized); } catch { /* ignore */ }
    try { existsAsar = fs.existsSync(normalized); } catch { /* ignore */ }
    candidates.push({ path: normalized, existsReal, existsAsar, strategy });
  };

  if (appRoot) {
    addCandidate(path.join(appRoot, WORKBENCH_RELATIVE), 'appRoot direct');
    const stripped = appRoot.replace(/[/\\]resources[/\\]app[/\\]?$/i, '');
    if (stripped !== appRoot) {
      addCandidate(path.join(stripped, 'resources', 'app', WORKBENCH_RELATIVE), 'appRoot stripped');
    }
  }
  addCandidate(path.join(execDir, 'resources', 'app', WORKBENCH_RELATIVE), 'execDir/resources/app');

  if (process.platform === 'win32') {
    addCandidate(path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', WORKBENCH_RELATIVE), 'LOCALAPPDATA/Programs/Cursor');
    addCandidate(path.join(localAppData, 'cursor', 'resources', 'app', WORKBENCH_RELATIVE), 'LOCALAPPDATA/cursor');
    addCandidate(path.join('C:', 'Program Files', 'Cursor', 'resources', 'app', WORKBENCH_RELATIVE), 'C:/Program Files/Cursor');
  }

  // Explore actual dir structure around key paths
  const dirListings: Record<string, string[] | string> = {};
  const dirsToProbe = [
    appRoot,
    path.join(execDir, 'resources'),
    path.join(execDir, 'resources', 'app'),
    path.join(execDir, 'resources', 'app', 'out'),
    path.join(execDir, 'resources', 'app', 'out', 'vs'),
    path.join(execDir, 'resources', 'app', 'out', 'vs', 'workbench'),
  ];
  if (process.platform === 'win32') {
    dirsToProbe.push(
      path.join(localAppData, 'Programs', 'Cursor'),
      path.join(localAppData, 'Programs', 'Cursor', 'resources'),
      path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app'),
      path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', 'out'),
      path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', 'out', 'vs'),
      path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', 'out', 'vs', 'workbench'),
    );
  }
  for (const d of dirsToProbe) {
    if (!d) continue;
    try {
      // Try realFs first (bypasses ASAR), then fs (ASAR-aware)
      if (realFs.existsSync(d) && realFs.statSync(d).isDirectory()) {
        dirListings[d] = realFs.readdirSync(d).slice(0, 30);
      } else if (fs.existsSync(d) && fs.statSync(d).isDirectory()) {
        dirListings[d + ' (via asar)'] = fs.readdirSync(d).slice(0, 30);
      } else {
        dirListings[d] = '(does not exist)';
      }
    } catch (e: any) {
      dirListings[d] = `(error: ${e.message})`;
    }
  }

  const asarPaths: Record<string, { existsReal: boolean; existsAsar: boolean; isFile?: boolean }> = {};
  const asarCandidates = [
    path.join(execDir, 'resources', 'app.asar'),
    path.join(execDir, 'resources', 'app.asar.unpacked'),
  ];
  if (process.platform === 'win32') {
    asarCandidates.push(
      path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app.asar'),
      path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app.asar.unpacked'),
    );
  }
  for (const a of asarCandidates) {
    let existsReal = false;
    let existsAsar = false;
    let isFile: boolean | undefined;
    try { existsReal = realFs.existsSync(a); if (existsReal) isFile = realFs.statSync(a).isFile(); } catch { /* ignore */ }
    try { existsAsar = fs.existsSync(a); } catch { /* ignore */ }
    asarPaths[a] = { existsReal, existsAsar, isFile };
  }

  return {
    platform: process.platform,
    arch: process.arch,
    appRoot,
    execPath,
    execDir,
    localAppData,
    usingOriginalFs: realFs !== fs,
    resolvedWorkbenchPath: _resolvedWorkbenchPath || '(not resolved yet)',
    candidates,
    dirListings,
    asarPaths,
    patchApplied: isPatchApplied(),
  };
}

export async function applyPatch(log: vscode.OutputChannel): Promise<PatchStatus> {
  log.appendLine(`[Patcher] appRoot: ${vscode.env.appRoot || '(empty)'}`);
  log.appendLine(`[Patcher] execPath: ${process.execPath}`);
  log.appendLine(`[Patcher] platform: ${process.platform}/${process.arch}`);
  log.appendLine(`[Patcher] using original-fs: ${realFs !== fs}`);

  const wbPath = getWorkbenchPath();
  log.appendLine(`[Patcher] Target: ${wbPath}`);

  let fileExists = false;
  try { fileExists = realFs.existsSync(wbPath); } catch { /* ignore */ }

  if (!fileExists) {
    const execDir = path.dirname(process.execPath);
    const resourcesDir = path.join(execDir, 'resources');
    log.appendLine(`[Patcher] resources dir exists (realFs): ${realFs.existsSync(resourcesDir)}`);
    log.appendLine(`[Patcher] resources dir exists (fs/asar): ${fs.existsSync(resourcesDir)}`);
    if (realFs.existsSync(resourcesDir)) {
      try {
        const entries = realFs.readdirSync(resourcesDir);
        log.appendLine(`[Patcher] resources contents (realFs): ${entries.join(', ')}`);
      } catch {}
    }
    if (fs.existsSync(resourcesDir)) {
      try {
        const entries = fs.readdirSync(resourcesDir);
        log.appendLine(`[Patcher] resources contents (fs/asar): ${entries.join(', ')}`);
      } catch {}
    }
    // On Windows check if the ASAR-aware fs can see it (inside app.asar)
    const appRoot = vscode.env.appRoot;
    if (appRoot) {
      const asarWb = path.join(appRoot, WORKBENCH_RELATIVE);
      const asarVisible = fs.existsSync(asarWb);
      log.appendLine(`[Patcher] ASAR-aware fs sees workbench at appRoot: ${asarVisible}`);
      if (asarVisible) {
        log.appendLine('[Patcher] Attempting ASAR extraction...');
        try {
          const extracted = extractFromAsar(asarWb, appRoot);
          if (extracted && realFs.existsSync(extracted)) {
            log.appendLine(`[Patcher] Extracted to: ${extracted}`);
            _resolvedWorkbenchPath = extracted;
            return applyPatch(log);
          }
        } catch (e: any) {
          log.appendLine(`[Patcher] ASAR extraction failed: ${e.message}`);
        }
      }
    }
    return { patched: false, alreadyPatched: false, error: `Workbench file not found: ${wbPath}` };
  }

  const content = realFs.readFileSync(wbPath, 'utf-8');

  if (content.includes(SENTINEL)) {
    log.appendLine('[Patcher] Already patched — ensuring checksum is up to date');
    ensureChecksum(Buffer.from(content, 'utf-8'), log);
    return { patched: true, alreadyPatched: true };
  }

  log.appendLine('[Patcher] Discovering minified variable names...');
  const { vars, errors } = discoverVariables(content);
  if (!vars) {
    const detail = errors.join('; ');
    log.appendLine(`[Patcher] Discovery failed: ${detail}`);
    return {
      patched: false,
      alreadyPatched: false,
      error: `Could not discover required variables in workbench JS: ${detail}`,
    };
  }

  log.appendLine(
    `[Patcher] Discovered: CommandsRegistry=${vars.commandsRegistry}, `
    + `createDecorator=${vars.createDecorator}, `
    + `DataService=${vars.composerDataService}, `
    + `ChatService=${vars.composerChatService}, `
    + `EventService=${vars.composerEventService}, `
    + `ViewsService=${vars.composerViewsService}, `
    + `ModesService=${vars.composerModesService}, `
    + `ModelConfigService=${vars.modelConfigService}, `
    + `AiService=${vars.aiService}`,
  );

  log.appendLine('[Patcher] Locating injection point...');
  const injection = findInjectionPoint(content, vars.commandsRegistry);
  if (!injection) {
    return {
      patched: false,
      alreadyPatched: false,
      error: 'Could not find a suitable injection point in workbench JS. '
           + 'None of the expected Cursor commands were found.',
    };
  }

  log.appendLine(`[Patcher] Injection anchor: "${injection.anchor}" at offset ${injection.offset}`);

  const insertAt = injection.offset;
  const patchCode = ',' + buildPatchCode(vars);
  const patchedContent = content.slice(0, insertAt) + patchCode + content.slice(insertAt);

  log.appendLine('[Patcher] Validating patch code syntax...');
  const syntaxError = validatePatchSyntax(patchCode);
  if (syntaxError) {
    return {
      patched: false,
      alreadyPatched: false,
      error: `Patch produces invalid JS — aborting to protect Cursor. `
           + `Syntax error: ${syntaxError}`,
    };
  }
  log.appendLine('[Patcher] Syntax OK');

  const backupPath = getBackupPath();

  // Try direct write first; if it fails with EPERM (e.g. C:\Program Files),
  // fall back to writing via elevated PowerShell on Windows.
  let needsElevation = false;
  try {
    if (!realFs.existsSync(backupPath)) {
      log.appendLine(`[Patcher] Creating backup: ${backupPath}`);
      realFs.copyFileSync(wbPath, backupPath);
    }

    writeRestoreScript(log);

    log.appendLine(`[Patcher] Atomic write (${patchCode.length} bytes injected)`);
    atomicWriteFileSync(wbPath, patchedContent);
  } catch (err: any) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EACCES')) {
      needsElevation = true;
      log.appendLine(`[Patcher] Direct write failed (${err.code}) — will try elevated write`);
    } else {
      return {
        patched: false,
        alreadyPatched: false,
        error: `Failed to write patched file: ${err.message}. Original is intact.`,
      };
    }
  }

  if (needsElevation) {
    log.appendLine('[Patcher] Attempting elevated write via PowerShell...');
    const elevateResult = await elevatedPatchWrite(wbPath, backupPath, patchedContent, log);
    if (!elevateResult.ok) {
      return {
        patched: false,
        alreadyPatched: false,
        error: elevateResult.error!,
      };
    }
  }

  try {
    ensureChecksum(Buffer.from(patchedContent, 'utf-8'), log);
  } catch (checksumErr: any) {
    log.appendLine(`[Patcher] Warning: checksum update failed (${checksumErr.code || checksumErr.message}) — may see integrity warning once`);
  }

  log.appendLine('[Patcher] Patch applied successfully');
  return { patched: true, alreadyPatched: false, backupPath };
}

export async function removePatch(log: vscode.OutputChannel): Promise<boolean> {
  const wbPath = getWorkbenchPath();
  const backupPath = getBackupPath();

  if (realFs.existsSync(backupPath)) {
    log.appendLine(`[Patcher] Restoring backup: ${backupPath}`);
    realFs.copyFileSync(backupPath, wbPath);
    realFs.unlinkSync(backupPath);

    ensureChecksum(realFs.readFileSync(wbPath), log);
    return true;
  }

  log.appendLine('[Patcher] No backup found — cannot unpatch automatically');
  return false;
}

/**
 * Called from extension activate. Silently patches if needed, then auto-reloads
 * exactly once using globalState to prevent a reload loop.
 *
 * Flow:
 *   1. Already patched → return true (fast path, every normal startup)
 *   2. Not patched, globalState says we just triggered a reload → something
 *      went wrong, don't loop. Show one warning and fall back.
 *   3. Not patched, first time → patch, set flag, auto-reload.
 */
export async function ensurePatch(
  context: vscode.ExtensionContext,
  log: vscode.OutputChannel,
): Promise<boolean> {
  if (isPatchApplied()) {
    context.globalState.update('patchReloadPending', undefined);
    log.appendLine('[Patcher] Patch verified — commands available');
    return true;
  }

  const reloadPending = context.globalState.get<boolean>('patchReloadPending');
  if (reloadPending) {
    context.globalState.update('patchReloadPending', undefined);
    log.appendLine(
      '[Patcher] Previous auto-reload did not result in a patched file. '
      + 'Run "Cursor Remote: Apply Patch" manually.',
    );
    vscode.window.showWarningMessage(
      'Cursor Remote: auto-patch did not take effect. '
      + 'Run "Cursor Remote: Apply Patch" from the command palette, or check the logs.',
    );
    return false;
  }

  log.appendLine('[Patcher] First activation — applying patch silently...');
  const result = await applyPatch(log);

  if (result.error) {
    log.appendLine(`[Patcher] Patch failed: ${result.error}`);
    vscode.window.showErrorMessage(`Cursor Remote: auto-patch failed — ${result.error}`);
    return false;
  }

  if (result.alreadyPatched) {
    return true;
  }

  log.appendLine('[Patcher] Patch applied — auto-reloading Cursor...');
  await context.globalState.update('patchReloadPending', true);
  vscode.commands.executeCommand('workbench.action.reloadWindow');
  return false;
}
