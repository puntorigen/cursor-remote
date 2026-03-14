import * as vscode from 'vscode';
import { isPatchApplied } from './patcher';

export type InjectionMethod =
  | 'patched-submit'
  | 'patched-set-text'
  | 'clipboard'
  | 'none';

export interface InjectionResult {
  success: boolean;
  method: InjectionMethod;
  details: string;
  composerId?: string;
  error?: string;
}

export interface ComposerInfo {
  id: string;
  name: string;
  status: string;
  lastUpdated: number;
}

export interface ComposerState {
  ok: boolean;
  selectedComposerId?: string;
  openComposerIds?: string[];
  composers?: ComposerInfo[];
  error?: string;
}

export interface DiagnosticResult {
  platform: string;
  patchApplied: boolean;
  patchedCommandsAvailable: boolean;
  selectedComposerId: string | null;
  openComposerCount: number;
  recommendation: string;
}

export interface ModeInfo {
  id: string;
  name: string;
  icon: string;
}

export interface ModelInfo {
  name: string;
  displayName: string;
  defaultOn: boolean;
}

export interface ModesAndModelsResult {
  ok: boolean;
  modes?: ModeInfo[];
  models?: ModelInfo[];
  currentMode?: string;
  currentModel?: string;
  error?: string;
}

export class MessageInjector {
  private lastMethod: InjectionMethod = 'none';
  private patchAvailable = false;

  constructor(private log: vscode.OutputChannel) {}

  async initialize() {
    this.log.appendLine(`[Injector] Platform: ${process.platform}/${process.arch}`);
    this.patchAvailable = isPatchApplied();
    this.log.appendLine(`[Injector] Patch available: ${this.patchAvailable}`);

    if (this.patchAvailable) {
      await this.verifyPatchedCommands();
    }
  }

  private async verifyPatchedCommands() {
    try {
      const state = await vscode.commands.executeCommand<ComposerState>(
        'cursorRemote._getState',
      );
      if (state?.ok) {
        this.log.appendLine(
          `[Injector] Patched commands working — selected: ${state.selectedComposerId}, `
          + `open: ${state.openComposerIds?.length ?? 0}, total: ${state.composers?.length ?? 0}`
        );
      } else {
        this.log.appendLine(`[Injector] _getState returned error: ${state?.error}`);
        this.patchAvailable = false;
      }
    } catch (err: any) {
      this.log.appendLine(`[Injector] Patched commands not responding: ${err.message}`);
      this.patchAvailable = false;
    }
  }

  isPatchAvailable(): boolean {
    return this.patchAvailable;
  }

  async refreshPatchAvailability(): Promise<boolean> {
    this.patchAvailable = isPatchApplied();
    this.log.appendLine(`[Injector] Patch availability refreshed: ${this.patchAvailable}`);
    if (this.patchAvailable) {
      await this.verifyPatchedCommands();
    }
    return this.patchAvailable;
  }

  getMethod(): InjectionMethod {
    return this.lastMethod;
  }

  async getComposerState(): Promise<ComposerState> {
    if (!this.patchAvailable) {
      return { ok: false, error: 'Patch not applied' };
    }
    try {
      const result = await vscode.commands.executeCommand<ComposerState>(
        'cursorRemote._getState',
      );
      return result ?? { ok: false, error: 'No response from _getState' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async diagnose(): Promise<DiagnosticResult> {
    const state = await this.getComposerState();

    let recommendation: string;
    if (this.patchAvailable && state.ok) {
      recommendation = 'Full support: patched commands available, can submit to any open composer';
    } else if (this.patchAvailable) {
      recommendation = 'Patch applied but commands not responding — try reloading Cursor';
    } else {
      recommendation = 'Patch not applied — run "Cursor Remote: Apply Patch" to enable message injection';
    }

    return {
      platform: `${process.platform}/${process.arch}`,
      patchApplied: this.patchAvailable,
      patchedCommandsAvailable: this.patchAvailable && (state.ok ?? false),
      selectedComposerId: state.selectedComposerId ?? null,
      openComposerCount: state.openComposerIds?.length ?? 0,
      recommendation,
    };
  }

  async getModesAndModels(): Promise<ModesAndModelsResult> {
    if (!this.patchAvailable) {
      return { ok: false, error: 'Patch not applied' };
    }
    try {
      const result = await vscode.commands.executeCommand<ModesAndModelsResult>(
        'cursorRemote._getModesAndModels',
      );
      return result ?? { ok: false, error: 'No response from _getModesAndModels' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async send(
    message: string,
    composerId?: string,
    options?: { mode?: string; modelOverride?: string },
  ): Promise<InjectionResult> {
    this.log.appendLine(
      `[Injector] Sending (${message.length} chars)` +
      (composerId ? ` to ${composerId}` : ' to active composer') +
      (options?.mode ? ` mode=${options.mode}` : '') +
      (options?.modelOverride ? ` model=${options.modelOverride}` : '')
    );

    if (!this.patchAvailable) {
      this.log.appendLine('[Injector] Patch not available — clipboard fallback');
      return this.strategyClipboard(message);
    }

    if (!composerId) {
      const state = await this.getComposerState();
      composerId = state.selectedComposerId ?? undefined;
      if (!composerId) {
        return {
          success: false,
          method: 'none',
          details: 'No active composer found. Open a chat first.',
          error: 'No active composer',
        };
      }
      this.log.appendLine(`[Injector] Using active composer: ${composerId}`);
    }

    return this.strategyPatchedSubmit(message, composerId, options);
  }

  /**
   * Set text in a composer without submitting — for preview/review workflows
   * where the user reviews on their desktop before pressing Enter.
   */
  async setText(text: string, composerId?: string): Promise<InjectionResult> {
    if (!this.patchAvailable) {
      return this.strategyClipboard(text);
    }

    if (!composerId) {
      const state = await this.getComposerState();
      composerId = state.selectedComposerId ?? undefined;
      if (!composerId) {
        return {
          success: false,
          method: 'none',
          details: 'No active composer found.',
          error: 'No active composer',
        };
      }
    }

    try {
      const result = await vscode.commands.executeCommand<{ ok: boolean; error?: string }>(
        'cursorRemote._setComposerText',
        { composerId, text },
      );

      if (result?.ok) {
        this.lastMethod = 'patched-set-text';
        return {
          success: true,
          method: 'patched-set-text',
          details: `Text set in composer ${composerId} — review and press Enter to submit`,
          composerId,
        };
      }

      return {
        success: false,
        method: 'patched-set-text',
        details: result?.error ?? 'Unknown error from _setComposerText',
        error: result?.error,
      };
    } catch (err: any) {
      return {
        success: false,
        method: 'patched-set-text',
        details: err.message,
        error: err.message,
      };
    }
  }

  async prompt(text: string, placeholder?: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    if (!this.patchAvailable) {
      return { ok: false, error: 'Patch not applied' };
    }
    try {
      const r = await vscode.commands.executeCommand<{ ok: boolean; result?: string; error?: string }>(
        'cursorRemote._prompt',
        { prompt: text, placeholder: placeholder || '' },
      );
      return r ?? { ok: false, error: 'No response from _prompt' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async query(text: string, model?: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    if (!this.patchAvailable) {
      return { ok: false, error: 'Patch not applied' };
    }
    try {
      const r = await vscode.commands.executeCommand<{ ok: boolean; result?: string; error?: string }>(
        'cursorRemote._query',
        { prompt: text, model: model || '' },
      );
      return r ?? { ok: false, error: 'No response from _query' };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  async queryJson<T = unknown>(
    prompt: string,
    schema: Record<string, unknown>,
    options?: { model?: string; retries?: number },
  ): Promise<{ ok: boolean; data?: T; raw?: string; error?: string }> {
    const maxAttempts = Math.min(options?.retries ?? 1, 3) + 1;
    const schemaStr = JSON.stringify(schema, null, 2);
    const wrappedPrompt = [
      prompt,
      '',
      'Respond ONLY with valid JSON matching this exact schema (no markdown fences, no extra text):',
      schemaStr,
    ].join('\n');

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const retryHint = attempt > 1
        ? `\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY the raw JSON object, nothing else.`
        : '';

      const r = await this.query(wrappedPrompt + retryHint, options?.model);
      if (!r.ok) return { ok: false, error: r.error };

      const raw = (r.result || '').trim();

      // Strip markdown fences if the model wrapped it anyway
      const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

      try {
        const data = JSON.parse(cleaned) as T;
        return { ok: true, data, raw: cleaned };
      } catch (parseErr: any) {
        if (attempt === maxAttempts) {
          return {
            ok: false,
            raw,
            error: `JSON parse failed after ${maxAttempts} attempt(s): ${parseErr.message}`,
          };
        }
        this.log.appendLine(
          `[Injector] queryJson attempt ${attempt}/${maxAttempts} failed to parse — retrying`,
        );
      }
    }

    return { ok: false, error: 'Unexpected: all attempts exhausted' };
  }

  private async strategyPatchedSubmit(
    message: string,
    composerId: string,
    options?: { mode?: string; modelOverride?: string },
  ): Promise<InjectionResult> {
    try {
      this.log.appendLine(`[Injector] Submitting via cursorRemote._submitChat`);

      const params: Record<string, string> = { composerId, text: message };
      if (options?.mode) params.mode = options.mode;
      if (options?.modelOverride) params.modelOverride = options.modelOverride;

      const result = await vscode.commands.executeCommand<{ ok: boolean; composerId?: string; error?: string }>(
        'cursorRemote._submitChat',
        params,
      );

      if (result?.ok) {
        this.lastMethod = 'patched-submit';
        this.log.appendLine(`[Injector] Submitted to ${composerId}`);
        return {
          success: true,
          method: 'patched-submit',
          details: `Message submitted to composer ${composerId}`,
          composerId,
        };
      }

      const errMsg = result?.error ?? 'Unknown error';
      this.log.appendLine(`[Injector] _submitChat error: ${errMsg}`);
      return {
        success: false,
        method: 'patched-submit',
        details: errMsg,
        error: errMsg,
        composerId,
      };
    } catch (err: any) {
      this.log.appendLine(`[Injector] _submitChat exception: ${err.message}`);
      return {
        success: false,
        method: 'patched-submit',
        details: err.message,
        error: err.message,
        composerId,
      };
    }
  }

  private async strategyClipboard(message: string): Promise<InjectionResult> {
    try {
      await vscode.env.clipboard.writeText(message);
      this.lastMethod = 'clipboard';
      return {
        success: true,
        method: 'clipboard',
        details: 'Patch not applied — message copied to clipboard. Paste into chat with Cmd/Ctrl+V.',
      };
    } catch (err: any) {
      return {
        success: false,
        method: 'none',
        details: err.message,
        error: err.message,
      };
    }
  }
}
