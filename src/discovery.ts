import * as vscode from 'vscode';

export interface DiscoveredCommands {
  chatOpen: string[];
  chatNew: string[];
  chatFocus: string[];
  chatToggle: string[];
  composer: string[];
  submit: string[];
  type: string[];
  all: string[];
}

const COMMAND_PATTERNS = [
  'chat',
  'composer',
  'aichat',
  'cursor',
  'copilot',
  'aiChat',
  'agent',
  'inline',
];

function matchAny(cmd: string, ...keywords: string[]): boolean {
  const lower = cmd.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

export async function discoverChatCommands(
  log: vscode.OutputChannel
): Promise<DiscoveredCommands> {
  const allCommands = await vscode.commands.getCommands(true);

  const matched = allCommands.filter((cmd) =>
    COMMAND_PATTERNS.some((p) => cmd.toLowerCase().includes(p))
  );

  const result: DiscoveredCommands = {
    chatOpen: matched.filter((c) => matchAny(c, 'open')),
    chatNew: matched.filter((c) => matchAny(c, 'new', 'start', 'create')),
    chatFocus: matched.filter((c) => matchAny(c, 'focus', 'focusInput')),
    chatToggle: matched.filter((c) => matchAny(c, 'toggle', 'show')),
    composer: matched.filter((c) => matchAny(c, 'composer')),
    submit: matched.filter(
      (c) => matchAny(c, 'submit', 'send', 'accept') && !matchAny(c, 'cancel', 'reject', 'undo')
    ),
    type: allCommands.filter((c) => c === 'type' || c === 'default:type'),
    all: matched,
  };

  log.appendLine('[Discovery] ===== Chat-related commands =====');
  const sections: [string, string[]][] = [
    ['FOCUS', result.chatFocus],
    ['TOGGLE/SHOW', result.chatToggle],
    ['OPEN', result.chatOpen],
    ['NEW', result.chatNew],
    ['SUBMIT', result.submit],
    ['COMPOSER', result.composer],
    ['TYPE', result.type],
  ];
  for (const [label, cmds] of sections) {
    log.appendLine(`[Discovery] ${label} (${cmds.length}):`);
    for (const cmd of cmds.sort()) log.appendLine(`  * ${cmd}`);
  }
  log.appendLine(`[Discovery] ALL matched (${matched.length}):`);
  for (const cmd of matched.sort()) log.appendLine(`  - ${cmd}`);

  return result;
}
