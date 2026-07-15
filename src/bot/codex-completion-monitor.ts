import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { LarkChannel } from '@larksuite/channel';
import { codexCompletionResumeCard } from '../card/templates';
import type { Controls } from '../commands';
import { log } from '../core/logger';
import {
  listCodexThreadHistory,
  readCodexThreadTranscript,
  type CodexThreadHistoryEntry,
  type CodexTranscriptTurn,
} from '../session/codex-history';
import { formatRelTime } from '../session/history';
import { normalizeSessionPreview } from '../session/preview';

const DEFAULT_POLL_MS = 30_000;
const RECENT_THREAD_LIMIT = 10;
const MAX_NOTIFIED_KEYS = 500;

export interface CodexCompletionMonitorDeps {
  channel: LarkChannel;
  controls: Controls;
  profileDir: string;
  pollIntervalMs?: number;
}

interface CompletionState {
  initialized: boolean;
  notified: string[];
  observed: Record<string, ObservedThreadState>;
}

interface ObservedThreadState {
  state: 'open' | 'completed';
  updatedAtMs: number;
  completedKey?: string;
}

interface CompletedThread {
  thread: CodexThreadHistoryEntry;
  turn: CodexTranscriptTurn;
  key: string;
}

interface ThreadObservation {
  thread: CodexThreadHistoryEntry;
  turn?: CodexTranscriptTurn;
  state: ObservedThreadState;
  completed?: CompletedThread;
}

export function startCodexCompletionMonitor(
  deps: CodexCompletionMonitorDeps,
): { stop(): void } {
  if (deps.controls.profileConfig.agentKind !== 'codex') return { stop() {} };
  if (!deps.controls.profile.endsWith('notify')) return { stop() {} };
  if (!deps.controls.profileConfig.codex?.binaryPath) return { stop() {} };

  const monitor = new CodexCompletionMonitor(deps);
  void monitor.tick();
  const timer = setInterval(() => void monitor.tick(), deps.pollIntervalMs ?? DEFAULT_POLL_MS);
  return {
    stop() {
      clearInterval(timer);
    },
  };
}

export class CodexCompletionMonitor {
  private running = false;
  private stateLoaded = false;
  private state: CompletionState = { initialized: false, notified: [], observed: {} };
  private readonly statePath: string;

  constructor(private readonly deps: CodexCompletionMonitorDeps) {
    this.statePath = join(deps.profileDir, 'codex-completion-notifications.json');
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.loadState();
      await this.scan();
    } catch (err) {
      log.warn('session', 'codex-completion-monitor-failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      this.running = false;
    }
  }

  private async scan(): Promise<void> {
    const codex = this.deps.controls.profileConfig.codex;
    const binary = codex?.binaryPath;
    if (!binary) return;

    const threads = await listCodexThreadHistory({
      binary,
      limit: RECENT_THREAD_LIMIT,
      profileStateDir: this.deps.profileDir,
      ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
      ...(codex.inheritCodexHome !== undefined
        ? { inheritCodexHome: codex.inheritCodexHome }
        : {}),
    });
    const observations: ThreadObservation[] = [];
    for (const thread of threads) {
      const turn = await readLastTurn(this.deps, thread.threadId);
      const completed =
        turn && isCompletedTurn(turn)
          ? { thread, turn, key: completionKey(thread.threadId, turn) }
          : undefined;
      observations.push({
        thread,
        ...(turn ? { turn } : {}),
        state: {
          state: completed ? 'completed' : 'open',
          updatedAtMs: thread.updatedAtMs,
          ...(completed ? { completedKey: completed.key } : {}),
        },
        ...(completed ? { completed } : {}),
      });
    }

    if (!this.state.initialized) {
      for (const item of observations) {
        this.observe(item);
        if (item.completed) this.remember(item.completed.key);
      }
      this.state.initialized = true;
      await this.saveState();
      log.info('session', 'codex-completion-monitor-seeded', {
        completed: observations.filter((item) => item.completed).length,
        scanned: threads.length,
      });
      return;
    }

    if (Object.keys(this.state.observed).length === 0 && observations.length > 0) {
      for (const item of observations) this.observe(item);
      await this.saveState();
      log.info('session', 'codex-completion-monitor-observed-migrated', {
        scanned: threads.length,
      });
      return;
    }

    let changed = false;
    for (const item of observations) {
      const previous = this.state.observed[item.thread.threadId];
      this.observe(item);
      if (!previous || !item.completed) {
        changed = true;
        continue;
      }
      if (previous.state !== 'open') {
        changed = true;
        continue;
      }
      const previousKey = previous.completedKey;
      const isNewCompletion = item.completed.key !== previousKey;
      if (!isNewCompletion || this.state.notified.includes(item.completed.key)) {
        changed = true;
        continue;
      }
      const sent = await this.notify(item.completed);
      this.remember(item.completed.key);
      changed = true;
      log.info('session', 'codex-completion-monitor-notified', {
        threadId: item.completed.thread.threadId,
        sent,
      });
    }
    if (changed) await this.saveState();
  }

  private async notify(item: CompletedThread): Promise<number> {
    const target = this.deps.controls.botOwnerId;
    if (!target) {
      log.warn('session', 'codex-completion-notify-missing-owner', {
        threadId: item.thread.threadId,
      });
      return 0;
    }
    const latest = item.turn.assistant ?? item.turn.user;
    const detail = `Codex · ${item.thread.source}`;
    const card = codexCompletionResumeCard({
      preview: item.thread.name || item.thread.preview,
      relTime: formatRelTime(item.thread.updatedAtMs),
      detail,
      ...(latest ? { latestMessage: normalizeSessionPreview(latest, 240) } : {}),
      threadId: item.thread.threadId,
    });
    try {
      await this.deps.channel.send(target, { card });
      return 1;
    } catch (err) {
      log.warn('session', 'codex-completion-notify-card-failed', {
        threadId: item.thread.threadId,
        target: target.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
      try {
        await this.deps.channel.send(target, {
          markdown: formatCompletionFallback(item.thread, latest),
        });
        return 1;
      } catch (fallbackErr) {
        log.warn('session', 'codex-completion-notify-text-failed', {
          threadId: item.thread.threadId,
          target: target.slice(-6),
          message: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    }
    return 0;
  }

  private remember(key: string): void {
    if (this.state.notified.includes(key)) return;
    this.state.notified.push(key);
    this.state.notified = this.state.notified.slice(-MAX_NOTIFIED_KEYS);
  }

  private observe(item: ThreadObservation): void {
    this.state.observed[item.thread.threadId] = item.state;
  }

  private async loadState(): Promise<void> {
    if (this.stateLoaded) return;
    this.stateLoaded = true;
    try {
      const raw = JSON.parse(await readFile(this.statePath, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object') return;
      const parsed = raw as Partial<CompletionState>;
      this.state = {
        initialized: parsed.initialized === true,
        notified: Array.isArray(parsed.notified)
          ? parsed.notified.filter((item): item is string => typeof item === 'string')
          : [],
        observed: normalizeObserved(parsed.observed),
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('session', 'codex-completion-state-load-failed', {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async saveState(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(tmp, this.statePath);
  }
}

async function readLastTurn(
  deps: CodexCompletionMonitorDeps,
  threadId: string,
): Promise<CodexTranscriptTurn | undefined> {
  const codex = deps.controls.profileConfig.codex;
  const binary = codex?.binaryPath;
  if (!binary) return undefined;
  const turns = await readCodexThreadTranscript({
    binary,
    threadId,
    profileStateDir: deps.profileDir,
    maxTurns: 1,
    maxMessageChars: 4000,
    ...(codex.codexHome ? { codexHome: codex.codexHome } : {}),
    ...(codex.inheritCodexHome !== undefined
      ? { inheritCodexHome: codex.inheritCodexHome }
      : {}),
  });
  return turns.at(-1);
}

function isCompletedTurn(turn: CodexTranscriptTurn): boolean {
  if (turn.completedAtMs !== undefined) return true;
  return turn.status === 'completed' || turn.status === 'success';
}

function completionKey(threadId: string, turn: CodexTranscriptTurn): string {
  const marker = turn.completedAtMs ?? `${turn.status ?? 'completed'}:${turnFingerprint(turn)}`;
  return `${threadId}:${marker}`;
}

function turnFingerprint(turn: CodexTranscriptTurn): string {
  return createHash('sha256')
    .update(turn.assistant ?? '')
    .update('\0')
    .update(turn.user ?? '')
    .digest('hex')
    .slice(0, 16);
}

function normalizeObserved(input: unknown): Record<string, ObservedThreadState> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out: Record<string, ObservedThreadState> = {};
  for (const [threadId, value] of Object.entries(input)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const raw = value as Partial<ObservedThreadState>;
    if (raw.state !== 'open' && raw.state !== 'completed') continue;
    if (typeof raw.updatedAtMs !== 'number') continue;
    out[threadId] = {
      state: raw.state,
      updatedAtMs: raw.updatedAtMs,
      ...(typeof raw.completedKey === 'string' ? { completedKey: raw.completedKey } : {}),
    };
  }
  return out;
}

function formatCompletionFallback(
  thread: CodexThreadHistoryEntry,
  latest: string | undefined,
): string {
  const lines = [
    'Codex 任务完成',
    `${thread.name || thread.preview} · ${formatRelTime(thread.updatedAtMs)} · Codex · ${thread.source}`,
  ];
  if (latest) {
    lines.push('', '最新消息', normalizeSessionPreview(latest, 240));
  }
  lines.push('', '请打开通知卡片点击 Resume，或发送 `/resume` 选择会话。');
  return lines.join('\n');
}
