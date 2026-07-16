import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LarkChannel } from '@larksuite/channel';
import { CodexCompletionMonitor } from '../../../src/bot/codex-completion-monitor.js';
import type { Controls } from '../../../src/commands/index.js';
import type {
  CodexThreadHistoryEntry,
  CodexTranscriptTurn,
} from '../../../src/session/codex-history.js';
import {
  listCodexThreadHistory,
  readCodexThreadTranscript,
} from '../../../src/session/codex-history.js';

vi.mock('../../../src/session/codex-history.js', () => ({
  listCodexThreadHistory: vi.fn(),
  readCodexThreadTranscript: vi.fn(),
}));

const listHistoryMock = vi.mocked(listCodexThreadHistory);
const readTranscriptMock = vi.mocked(readCodexThreadTranscript);

describe('Codex completion monitor', () => {
  let profileDir: string;

  beforeEach(async () => {
    profileDir = await mkdtemp(join(tmpdir(), 'codex-completion-monitor-'));
    listHistoryMock.mockReset();
    readTranscriptMock.mockReset();
  });

  afterEach(async () => {
    await rm(profileDir, { recursive: true, force: true });
  });

  it('does not notify for already-completed threads or completed-to-completed timestamp changes', async () => {
    const sends: unknown[] = [];
    let completedAtMs = 1_784_111_699_000;
    listHistoryMock.mockResolvedValue([thread('thread-fork', completedAtMs)]);
    readTranscriptMock.mockImplementation(async () => [
      turn({ status: 'completed', completedAtMs, assistant: `done ${completedAtMs}` }),
    ]);

    const monitor = new CodexCompletionMonitor({
      channel: channel(sends),
      controls: controls(),
      profileDir,
    });
    await monitor.tick();
    expect(sends).toHaveLength(0);

    completedAtMs += 86_000;
    await monitor.tick();
    expect(sends).toHaveLength(0);
  });

  it('notifies once when an observed open thread completes', async () => {
    const sends: unknown[] = [];
    let currentTurn = turn({ status: 'in_progress', assistant: 'working' });
    listHistoryMock.mockResolvedValue([thread('thread-active', 1_784_111_000_000)]);
    readTranscriptMock.mockImplementation(async () => [currentTurn]);

    const monitor = new CodexCompletionMonitor({
      channel: channel(sends),
      controls: controls(),
      profileDir,
    });
    await monitor.tick();
    expect(sends).toHaveLength(0);

    currentTurn = turn({
      status: 'completed',
      completedAtMs: 1_784_111_111_000,
      assistant: 'checking files\n\nfinal answer',
      finalAssistant: 'final answer',
    });
    await monitor.tick();
    expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0])).toContain('final answer');
    expect(JSON.stringify(sends[0])).toContain('thread-active:1784111111000');
    expect(JSON.stringify(sends[0])).not.toContain('checking files');

    currentTurn = turn({
      status: 'completed',
      completedAtMs: 1_784_111_222_000,
      assistant: 'checking files again\n\nfinal answer edited timestamp',
      finalAssistant: 'final answer edited timestamp',
    });
    await monitor.tick();
    expect(sends).toHaveLength(1);
  });
});

function controls(): Controls {
  return {
    profile: 'codex-notify',
    botOwnerId: 'owner-open-id',
    profileConfig: {
      agentKind: 'codex',
      codex: {
        binaryPath: '/usr/local/bin/codex',
      },
    },
  } as Controls;
}

function channel(sends: unknown[]): LarkChannel {
  return {
    async send(target: string, content: unknown) {
      sends.push({ target, content });
    },
  } as unknown as LarkChannel;
}

function thread(threadId: string, updatedAtMs: number): CodexThreadHistoryEntry {
  return {
    threadId,
    cwd: '/tmp/project',
    name: 'Task',
    preview: 'Task preview',
    createdAtMs: updatedAtMs - 1000,
    updatedAtMs,
    source: 'codex',
  };
}

function turn(input: Partial<CodexTranscriptTurn>): CodexTranscriptTurn {
  return {
    user: '',
    assistant: '',
    ...input,
  } as CodexTranscriptTurn;
}
