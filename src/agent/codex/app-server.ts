import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import type { AgentEvent, AgentRun } from '../types';

type CodexAppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface CodexAppServerRunInput {
  binary: string;
  runId: string;
  prompt: string;
  cwd: string;
  sandbox: SandboxMode;
  env: NodeJS.ProcessEnv;
  threadId?: string;
  model?: string;
  images?: readonly string[];
  stopGraceMs: number;
}

interface RunState {
  threadId?: string;
  turnId?: string;
  stopReason?: 'interrupted';
}

export function runCodexAppServer(input: CodexAppServerRunInput): AgentRun {
  const child = spawnProcess(input.binary, ['app-server', '--listen', 'stdio://'], {
    cwd: input.cwd,
    env: input.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as CodexAppServerChild;
  const state: RunState = { threadId: input.threadId };

  log.info('agent', 'spawn', {
    pid: child.pid ?? null,
    cwd: input.cwd,
    hasThread: Boolean(input.threadId),
    promptChars: input.prompt.length,
    images: input.images?.length ?? 0,
    model: input.model,
    transport: 'app-server',
  });

  const stderrChunks: Buffer[] = [];
  let runtimeError: Error | null = null;
  let stderrBuffer = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk);
    stderrBuffer += chunk.toString('utf8');
    let nl = stderrBuffer.indexOf('\n');
    while (nl !== -1) {
      const line = stderrBuffer.slice(0, nl);
      stderrBuffer = stderrBuffer.slice(nl + 1);
      if (line.trim()) log.warn('agent', 'stderr', { line });
      nl = stderrBuffer.indexOf('\n');
    }
  });
  child.on('error', (err) => {
    runtimeError = err;
  });
  child.on('exit', (code, signal) => {
    log.info('agent', 'exit', { pid: child.pid ?? null, code, signal, transport: 'app-server' });
  });
  child.stdin.on('error', (err) => {
    log.warn('agent', 'stdin-error', { message: err.message, transport: 'app-server' });
  });

  return {
    runId: input.runId,
    events: createAppServerEventStream(child, input, state, stderrChunks, () => runtimeError),
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      state.stopReason = 'interrupted';
      log.info('agent', 'stop-sigterm', {
        pid: child.pid ?? null,
        graceMs: input.stopGraceMs,
        transport: 'app-server',
      });
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            log.warn('agent', 'stop-sigkill', {
              pid: child.pid ?? null,
              graceMs: input.stopGraceMs,
              reason: 'grace-period-expired',
              transport: 'app-server',
            });
            child.kill('SIGKILL');
          }
          resolve();
        }, input.stopGraceMs);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    waitForExit(timeoutMs: number): Promise<boolean> {
      if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const onExit = (): void => {
          clearTimeout(timer);
          resolve(true);
        };
        const timer = setTimeout(() => {
          child.removeListener('exit', onExit);
          resolve(false);
        }, timeoutMs);
        child.once('exit', onExit);
      });
    },
  };
}

async function* createAppServerEventStream(
  child: CodexAppServerChild,
  input: CodexAppServerRunInput,
  state: RunState,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  const translator = new AppServerTranslator(state.threadId);
  if (!child.pid) {
    const err = getError();
    yield terminalError(err ? `failed to spawn codex app-server: ${err.message}` : 'spawn returned no pid');
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    send(child, initializeRequest());
    send(child, { method: 'initialized' });
    send(child, threadRequest(input));

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const msg = recordValue(parsed);
      if (!msg) continue;

      if (typeof msg.id === 'number') {
        const events = handleResponse(child, input, state, msg);
        yield* events;
        if (events.some((evt) => evt.type === 'error')) break;
        continue;
      }

      if (typeof msg.method === 'string') {
        const events = translator.translate(msg);
        for (const event of events) {
          if (event.type === 'system' && event.threadId) state.threadId = event.threadId;
          if (event.type === 'done' || event.type === 'error') {
            child.kill('SIGTERM');
          }
          yield event;
        }
        if (translator.terminalEmitted()) break;
      }
    }
  } finally {
    rl.close();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }

  const exitCode = await waitForExitCode(child);
  if (translator.terminalEmitted()) return;
  if (state.stopReason === 'interrupted') {
    yield { type: 'done', threadId: state.threadId, terminationReason: 'interrupted' };
    return;
  }
  const runtimeError = getError();
  if (runtimeError) {
    yield terminalError(`codex app-server runtime error: ${runtimeError.message}`);
    return;
  }
  if (exitCode !== 0 && exitCode !== null) {
    const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield terminalError(`codex app-server exited with code ${exitCode}${detail}`);
    return;
  }
  yield terminalError('codex app-server stream ended before a terminal event');
}

function handleResponse(
  child: CodexAppServerChild,
  input: CodexAppServerRunInput,
  state: RunState,
  msg: Record<string, unknown>,
): AgentEvent[] {
  if (msg.error) {
    return [terminalError(errorMessage(msg.error, 'codex app-server request failed'))];
  }
  if (msg.id !== 2) return [];

  const result = recordValue(msg.result);
  const thread = recordValue(result?.thread);
  const threadId = stringValue(thread?.id) ?? state.threadId;
  if (!threadId) return [terminalError('codex app-server did not return a thread id')];
  state.threadId = threadId;
  send(child, turnStartRequest(input, threadId));
  return [{ type: 'system', threadId }];
}

class AppServerTranslator {
  private threadId: string | undefined;
  private terminal = false;
  private readonly agentMessageDeltas = new Set<string>();
  private readonly startedItems = new Set<string>();

  constructor(threadId?: string) {
    this.threadId = threadId;
  }

  terminalEmitted(): boolean {
    return this.terminal;
  }

  translate(raw: Record<string, unknown>): AgentEvent[] {
    if (this.terminal) return [];
    const method = stringValue(raw.method);
    const params = recordValue(raw.params);
    if (!method || !params) return [];

    switch (method) {
      case 'thread/started':
        return this.threadStarted(params);
      case 'turn/started':
        return this.turnStarted(params);
      case 'item/started':
        return this.itemStarted(params);
      case 'item/agentMessage/delta':
        return this.agentMessageDelta(params);
      case 'item/completed':
        return this.itemCompleted(params);
      case 'turn/completed':
        return this.turnCompleted(params);
      case 'error':
        return this.error(params);
      default:
        return [];
    }
  }

  private threadStarted(params: Record<string, unknown>): AgentEvent[] {
    const thread = recordValue(params.thread);
    const threadId = stringValue(params.threadId) ?? stringValue(thread?.id);
    if (!threadId) return [];
    if (threadId === this.threadId) return [];
    this.threadId = threadId;
    return [{ type: 'system', threadId }];
  }

  private turnStarted(params: Record<string, unknown>): AgentEvent[] {
    const threadId = stringValue(params.threadId);
    if (threadId) this.threadId = threadId;
    return [];
  }

  private itemStarted(params: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(params.item);
    if (!item) return [];
    const id = stringValue(item.id);
    if (id) this.startedItems.add(id);
    if (item.type === 'commandExecution' && id) {
      return [
        {
          type: 'tool_use',
          id,
          name: 'command_execution',
          input: { command: stringValue(item.command) ?? '' },
        },
      ];
    }
    if (item.type === 'mcpToolCall' && id) {
      return [
        {
          type: 'tool_use',
          id,
          name: `${stringValue(item.server) ?? 'mcp'}.${stringValue(item.tool) ?? 'tool'}`,
          input: item.arguments,
        },
      ];
    }
    return [];
  }

  private agentMessageDelta(params: Record<string, unknown>): AgentEvent[] {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta);
    if (!delta) return [];
    if (itemId) this.agentMessageDeltas.add(itemId);
    return [{ type: 'text', delta }];
  }

  private itemCompleted(params: Record<string, unknown>): AgentEvent[] {
    const item = recordValue(params.item);
    if (!item) return [];
    const id = stringValue(item.id);
    if (id) this.startedItems.delete(id);
    if (item.type === 'agentMessage') {
      if (id && this.agentMessageDeltas.has(id)) return [];
      const text = stringValue(item.text);
      return text ? [{ type: 'text', delta: text }] : [];
    }
    if (item.type === 'commandExecution' && id) {
      const exitCode = numberValue(item.exitCode);
      return [
        {
          type: 'tool_result',
          id,
          output: stringValue(item.aggregatedOutput) ?? '',
          isError: exitCode !== undefined && exitCode !== 0,
        },
      ];
    }
    if (item.type === 'mcpToolCall' && id) {
      return [
        {
          type: 'tool_result',
          id,
          output: JSON.stringify(recordValue(item.result) ?? recordValue(item.error) ?? null),
          isError: Boolean(item.error),
        },
      ];
    }
    return [];
  }

  private turnCompleted(params: Record<string, unknown>): AgentEvent[] {
    this.terminal = true;
    const turn = recordValue(params.turn);
    const status = stringValue(turn?.status);
    if (status === 'failed') {
      return [
        terminalError(errorMessage(recordValue(turn?.error), 'codex app-server turn failed')),
      ];
    }
    return [{ type: 'done', threadId: this.threadId, terminationReason: 'normal' }];
  }

  private error(params: Record<string, unknown>): AgentEvent[] {
    this.terminal = true;
    return [terminalError(errorMessage(params.error, 'codex app-server error'))];
  }
}

function initializeRequest() {
  return {
    method: 'initialize',
    id: 1,
    params: {
      clientInfo: {
        name: 'lark-channel-bridge',
        title: 'Lark Channel Bridge',
        version: '0.5.8',
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  };
}

function threadRequest(input: CodexAppServerRunInput) {
  const base = {
    cwd: input.cwd,
    runtimeWorkspaceRoots: [input.cwd],
    approvalPolicy: 'never',
    sandbox: input.sandbox,
    model: input.model ?? null,
    config: shellEnvironmentConfig(),
  };
  if (input.threadId) {
    return {
      method: 'thread/resume',
      id: 2,
      params: {
        threadId: input.threadId,
        ...base,
      },
    };
  }
  return {
    method: 'thread/start',
    id: 2,
    params: {
      ...base,
      threadSource: 'lark-channel-bridge',
      historyMode: 'legacy',
    },
  };
}

function turnStartRequest(input: CodexAppServerRunInput, threadId: string) {
  return {
    method: 'turn/start',
    id: 3,
    params: {
      threadId,
      input: [
        { type: 'text', text: input.prompt, text_elements: [] },
        ...(input.images ?? []).map((path) => ({ type: 'localImage', path, detail: 'auto' })),
      ],
      cwd: input.cwd,
      runtimeWorkspaceRoots: [input.cwd],
      approvalPolicy: 'never',
      sandboxPolicy: sandboxPolicy(input.sandbox, input.cwd),
      model: input.model ?? null,
      responsesapiClientMetadata: {
        source: 'lark-channel-bridge',
      },
    },
  };
}

function shellEnvironmentConfig(): Record<string, unknown> {
  return {
    shell_environment_policy: {
      inherit: 'all',
    },
  };
}

function sandboxPolicy(mode: SandboxMode, cwd: string): Record<string, unknown> {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' };
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [cwd],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      };
    case 'read-only':
      return { type: 'readOnly', networkAccess: false };
  }
}

function send(child: CodexAppServerChild, msg: unknown): void {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

function terminalError(message: string): AgentEvent {
  return { type: 'error', message, terminationReason: 'failed' };
}

async function waitForExitCode(child: CodexAppServerChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function errorMessage(input: unknown, fallback: string): string {
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message;
  const raw = recordValue(input);
  return stringValue(raw?.message) ?? stringValue(raw?.error) ?? fallback;
}
