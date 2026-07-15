import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProfileConfig, type RootConfig } from '../../../src/config/profile-schema.js';

const mocks = vi.hoisted(() => ({
  loadRootConfig: vi.fn(),
  runProfileCreate: vi.fn(),
  runProfileUse: vi.fn(),
  runServiceStart: vi.fn(),
}));

vi.mock('../../../src/config/profile-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/config/profile-store.js')>();
  return {
    ...actual,
    loadRootConfig: mocks.loadRootConfig,
  };
});

vi.mock('../../../src/cli/commands/profile.js', () => ({
  runProfileCreate: mocks.runProfileCreate,
  runProfileUse: mocks.runProfileUse,
}));

vi.mock('../../../src/cli/commands/service.js', () => ({
  runServiceStart: mocks.runServiceStart,
}));

const { runCodexDualSetup } = await import('../../../src/cli/commands/setup.js');

describe('codex dual setup command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    mocks.runProfileCreate.mockResolvedValue(undefined);
    mocks.runProfileUse.mockResolvedValue(undefined);
    mocks.runServiceStart.mockResolvedValue(undefined);
  });

  it('creates and starts the main and notify Codex profiles', async () => {
    mocks.loadRootConfig.mockResolvedValue(undefined);

    await runCodexDualSetup({
      rootDir: '/tmp/bridge-home',
      workspace: '/repo',
      skipCheckLarkCli: true,
    });

    expect(mocks.runProfileCreate).toHaveBeenNthCalledWith(1, 'codex', {
      rootDir: '/tmp/bridge-home',
      agent: 'codex',
      workspace: '/repo',
    });
    expect(mocks.runProfileCreate).toHaveBeenNthCalledWith(2, 'codex-notify', {
      rootDir: '/tmp/bridge-home',
      agent: 'codex',
      workspace: '/repo',
    });
    expect(mocks.runProfileUse).toHaveBeenCalledWith('codex', { rootDir: '/tmp/bridge-home' });
    expect(mocks.runServiceStart).toHaveBeenNthCalledWith(1, {
      profile: 'codex',
      skipCheckLarkCli: true,
    });
    expect(mocks.runServiceStart).toHaveBeenNthCalledWith(2, {
      profile: 'codex-notify',
      skipCheckLarkCli: true,
    });
  });

  it('skips QR creation for existing Codex profiles', async () => {
    mocks.loadRootConfig.mockResolvedValue(rootConfig(['codex', 'codex-notify']));

    await runCodexDualSetup({ rootDir: '/tmp/bridge-home' });

    expect(mocks.runProfileCreate).not.toHaveBeenCalled();
    expect(mocks.runProfileUse).toHaveBeenCalledWith('codex', { rootDir: '/tmp/bridge-home' });
    expect(mocks.runServiceStart).toHaveBeenCalledTimes(2);
  });

  it('can create profiles without starting background services', async () => {
    mocks.loadRootConfig.mockResolvedValue(undefined);

    await runCodexDualSetup({
      rootDir: '/tmp/bridge-home',
      noStart: true,
    });

    expect(mocks.runProfileCreate).toHaveBeenCalledTimes(2);
    expect(mocks.runServiceStart).not.toHaveBeenCalled();
  });

  it('rejects a notify profile name that would not enable the monitor', async () => {
    await expect(
      runCodexDualSetup({
        rootDir: '/tmp/bridge-home',
        notifyProfile: 'codex-alerts',
      }),
    ).rejects.toThrow(/must end with "notify"/);
  });
});

function rootConfig(names: string[]): RootConfig {
  return {
    schemaVersion: 2,
    activeProfile: names[0] ?? 'codex',
    preferences: {},
    profiles: Object.fromEntries(
      names.map((name) => [
        name,
        createDefaultProfileConfig({
          agentKind: 'codex',
          accounts: {
            app: {
              id: `cli_${name.replace(/[^A-Za-z0-9]/g, '_')}`,
              secret: '${APP_SECRET}',
              tenant: 'feishu',
            },
          },
          codex: { binaryPath: 'codex' },
        }),
      ]),
    ),
  };
}
