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
 * Safety:
 *   - Backup created before any modification
 *   - Patched content is syntax-validated before writing
 *   - Writes use atomic temp-file-then-rename to prevent truncation
 *   - A standalone restore script is shipped for recovery when Cursor is broken
 *   - Idempotent: sentinel check prevents double-patching
 *   - Auto-reload loop protection via globalState
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

const SENTINEL = '/* __CURSOR_REMOTE_PATCHED__ */';

const WORKBENCH_RELATIVE = 'out/vs/workbench/workbench.desktop.main.js';

function getWorkbenchPath(): string {
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

const ANCHOR = 'await i.showAndFocus(a)}),It(Xbb)';

/**
 * Builds the JS to inject. Uses the DI tokens in scope at the anchor:
 *   ag = composerService, Oa = composerDataService,
 *   DA = composerEventService, rw = composerViewsService,
 *   AM = composerChatService
 */
function buildPatchCode(): string {
  return [
    SENTINEL,

    `Ss.registerCommand("cursorRemote._submitChat",async(n,e)=>{`,
      `try{`,
        `const t=e.composerId,i=e.text;`,
        `if(!t||!i)return{ok:false,error:"composerId and text required"};`,
        `const ds=n.get(Oa),cs=n.get(AM),vs=n.get(rw),es=n.get(DA);`,
        `const h=ds.getHandleIfLoaded(t);`,
        `if(!h)return{ok:false,error:"composer not found: "+t};`,
        `ds.updateComposerData(h,{text:i,richText:i});`,
        `es.fireShouldForceText({composerId:t});`,
        `await vs.showAndFocus(t);`,
        `await cs.submitChatMaybeAbortCurrent(t,i,{});`,
        `return{ok:true,composerId:t};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,

    `,`,

    `Ss.registerCommand("cursorRemote._setComposerText",async(n,e)=>{`,
      `try{`,
        `const t=e.composerId,i=e.text;`,
        `if(!t||typeof i!=="string")return{ok:false,error:"composerId and text required"};`,
        `const ds=n.get(Oa),es=n.get(DA),vs=n.get(rw);`,
        `const h=ds.getHandleIfLoaded(t);`,
        `if(!h)return{ok:false,error:"composer not found: "+t};`,
        `ds.updateComposerData(h,{text:i,richText:i});`,
        `es.fireShouldForceText({composerId:t});`,
        `await vs.showAndFocus(t);`,
        `return{ok:true,composerId:t};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,

    `,`,

    `Ss.registerCommand("cursorRemote._getState",async(n)=>{`,
      `try{`,
        `const ds=n.get(Oa);`,
        `const sel=ds.selectedComposerId;`,
        `const ids=ds.allComposersData.selectedComposerIds||[];`,
        `const all=(ds.allComposersData.allComposers||[]).map(c=>({`,
          `id:c.composerId,`,
          `name:c.name||"",`,
          `status:c.status||"unknown",`,
          `lastUpdated:c.lastUpdatedAt||0`,
        `}));`,
        `return{ok:true,selectedComposerId:sel,openComposerIds:ids,composers:all};`,
      `}catch(x){`,
        `return{ok:false,error:String(x)};`,
      `}`,
    `})`,
  ].join('');
}

// ─── Syntax validation ──────────────────────────────────────────────────────

/**
 * Validates that `code` is parseable JS by compiling it in a V8 Script.
 * This catches syntax errors (missing braces, bad tokens, etc.) without
 * executing anything. Returns null on success, error message on failure.
 *
 * We only validate a ~64KB window around the injection point rather than
 * the full 50MB file, since Script compilation of the whole thing would
 * be slow and may hit memory limits.
 */
function validateSyntax(fullContent: string, injectionOffset: number): string | null {
  const WINDOW = 32_768;
  const start = Math.max(0, injectionOffset - WINDOW);
  const end = Math.min(fullContent.length, injectionOffset + WINDOW);
  const snippet = fullContent.slice(start, end);

  try {
    // Wrap in a function body so top-level `await` and `return` are valid
    new vm.Script(`(async function(){${snippet}})`, { filename: 'patch-validation.js' });
    return null;
  } catch (err: any) {
    return err.message || String(err);
  }
}

// ─── Atomic file write ──────────────────────────────────────────────────────

/**
 * Writes `content` to `targetPath` atomically:
 *   1. Write to a temp file in the same directory
 *   2. fsync the temp file
 *   3. Rename temp → target (atomic on POSIX, near-atomic on NTFS)
 *
 * If anything fails, the temp file is cleaned up and the original is untouched.
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
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    // Clean up temp file on failure
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
    log.appendLine('[Patcher] Already patched — nothing to do');
    return { patched: true, alreadyPatched: true };
  }

  const anchorIdx = content.indexOf(ANCHOR);
  if (anchorIdx === -1) {
    return {
      patched: false,
      alreadyPatched: false,
      error: 'Anchor string not found in workbench JS — Cursor version may have changed. '
           + 'Try updating the extension or re-running the patcher.',
    };
  }

  // Build the patched content
  const insertAt = anchorIdx + ANCHOR.length;
  const patchCode = ',' + buildPatchCode();
  const patchedContent = content.slice(0, insertAt) + patchCode + content.slice(insertAt);

  // Validate syntax around the injection point before touching disk
  log.appendLine('[Patcher] Validating patched JS syntax...');
  const syntaxError = validateSyntax(patchedContent, insertAt);
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
    // Atomic write failed — original file is untouched
    return {
      patched: false,
      alreadyPatched: false,
      error: `Failed to write patched file: ${err.message}. Original is intact.`,
    };
  }

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
