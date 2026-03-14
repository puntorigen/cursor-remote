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

  /**
   * Send a message to Cursor's chat using patched internal commands.
   *
   * If composerId is provided, submits to that specific conversation.
   * Otherwise, submits to the currently selected/focused composer.
   */
  async send(message: string, composerId?: string): Promise<InjectionResult> {
    this.log.appendLine(
      `[Injector] Sending (${message.length} chars)` +
      (composerId ? ` to ${composerId}` : ' to active composer')
    );

    if (!this.patchAvailable) {
      this.log.appendLine('[Injector] Patch not available — clipboard fallback');
      return this.strategyClipboard(message);
    }

    // Resolve composerId if not provided
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

    return this.strategyPatchedSubmit(message, composerId);
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

  private async strategyPatchedSubmit(
    message: string,
    composerId: string,
  ): Promise<InjectionResult> {
    try {
      this.log.appendLine(`[Injector] Submitting via cursorRemote._submitChat`);

      const result = await vscode.commands.executeCommand<{ ok: boolean; composerId?: string; error?: string }>(
        'cursorRemote._submitChat',
        { composerId, text: message },
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
