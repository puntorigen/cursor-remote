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
import * as vscode from 'vscode';

const SENTINEL = '/* __CURSOR_REMOTE_PATCHED__ */';

const WORKBENCH_RELATIVE = 'out/vs/workbench/workbench.desktop.main.js';

/**
 * Uses vscode.env.appRoot (the running Cursor's own resources/app dir)
 * so the path is always correct regardless of install location.
 * Falls back to platform-specific defaults if appRoot is empty.
 */
function getWorkbenchPath(): string {
  const appRoot = vscode.env.appRoot;
  if (appRoot) {
    return path.join(appRoot, WORKBENCH_RELATIVE);
  }
  if (process.platform === 'darwin') {
    return path.join(
      '/Applications/Cursor.app/Contents/Resources/app',
      WORKBENCH_RELATIVE,
    );
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    return path.join(localAppData, 'Programs', 'Cursor', 'resources', 'app', WORKBENCH_RELATIVE);
  }
  return path.join('/opt/Cursor/resources/app', WORKBENCH_RELATIVE);
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
  /** Minified name of createDecorator (e.g. "Ti") */
  createDecorator: string;
  /** Minified name of CommandsRegistry singleton (e.g. "Ss") */
  commandsRegistry: string;
  /** Minified DI token for composerDataService (e.g. "Oa") */
  composerDataService: string;
  /** Minified DI token for composerChatService (e.g. "AM") */
  composerChatService: string;
  /** Minified DI token for composerEventService (e.g. "BA") */
  composerEventService: string;
  /** Minified DI token for composerViewsService (e.g. "rw") */
  composerViewsService: string;
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

  // Wait-for-handle logic inlined directly in each command to avoid
  // any arrow-function-in-comma-expression parsing issues.
  // showAndFocus activates the tab; poll getHandleIfLoaded up to 2s.
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

    `${CR}.registerCommand("cursorRemote._submitChat",async(n,e)=>{`,
      `try{`,
        `var t=e.composerId,i=e.text;`,
        `if(!t||!i)return{ok:false,error:"composerId and text required"};`,
        `var ds=n.get(${DS}),cs=n.get(${CS}),vs=n.get(${VS}),es=n.get(${ES});`,
        waitBlock('ds', 'vs', 't', 'h'),
        `if(!h)return{ok:false,error:"composer not found after showAndFocus: "+t};`,
        `ds.updateComposerData(h,{text:i,richText:i});`,
        `es.fireShouldForceText({composerId:t});`,
        `await cs.submitChatMaybeAbortCurrent(t,i,{});`,
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
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, content, 0, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    try {
      fs.renameSync(tmpPath, targetPath);
    } catch {
      // Rename fails on Windows when the target is in use; fall back to
      // copying content and removing the temp file.
      fs.copyFileSync(tmpPath, targetPath);
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
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
  if (!fs.existsSync(wbPath)) return false;
  const content = fs.readFileSync(wbPath, 'utf-8');
  return content.includes(SENTINEL);
}

export async function applyPatch(log: vscode.OutputChannel): Promise<PatchStatus> {
  const wbPath = getWorkbenchPath();
  log.appendLine(`[Patcher] Target: ${wbPath}`);

  if (!fs.existsSync(wbPath)) {
    return { patched: false, alreadyPatched: false, error: `Workbench file not found: ${wbPath}` };
  }

  const content = fs.readFileSync(wbPath, 'utf-8');

  if (content.includes(SENTINEL)) {
    log.appendLine('[Patcher] Already patched — ensuring checksum is up to date');
    ensureChecksum(Buffer.from(content, 'utf-8'), log);
    return { patched: true, alreadyPatched: true };
  }

  // Discover minified variable names from stable string literals
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
    + `ViewsService=${vars.composerViewsService}`,
  );

  // Find injection point using stable command ID strings
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

  // Build the patched content
  const insertAt = injection.offset;
  const patchCode = ',' + buildPatchCode(vars);
  const patchedContent = content.slice(0, insertAt) + patchCode + content.slice(insertAt);

  // Validate the generated patch code in isolation before touching disk
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

  // Create backup (only on first patch — don't overwrite an older backup)
  const backupPath = getBackupPath();
  if (!fs.existsSync(backupPath)) {
    log.appendLine(`[Patcher] Creating backup: ${backupPath}`);
    fs.copyFileSync(wbPath, backupPath);
  }

  // Write the standalone restore script next to the backup
  writeRestoreScript(log);

  // Atomic write: temp file → fsync → rename
  log.appendLine(`[Patcher] Atomic write (${patchCode.length} bytes injected)`);
  try {
    atomicWriteFileSync(wbPath, patchedContent);
  } catch (err: any) {
    return {
      patched: false,
      alreadyPatched: false,
      error: `Failed to write patched file: ${err.message}. Original is intact.`,
    };
  }

  // Update product.json checksum so Cursor's integrity check passes
  ensureChecksum(Buffer.from(patchedContent, 'utf-8'), log);

  log.appendLine('[Patcher] Patch applied successfully');
  return { patched: true, alreadyPatched: false, backupPath };
}

export async function removePatch(log: vscode.OutputChannel): Promise<boolean> {
  const wbPath = getWorkbenchPath();
  const backupPath = getBackupPath();

  if (fs.existsSync(backupPath)) {
    log.appendLine(`[Patcher] Restoring backup: ${backupPath}`);
    fs.copyFileSync(backupPath, wbPath);
    fs.unlinkSync(backupPath);

    // Restore the original checksum in product.json
    ensureChecksum(fs.readFileSync(wbPath), log);

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
