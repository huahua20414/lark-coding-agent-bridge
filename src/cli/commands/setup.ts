import { resolveAppPaths } from '../../config/app-paths';
import { paths } from '../../config/paths';
import { loadRootConfig } from '../../config/profile-store';
import { runProfileCreate, runProfileUse } from './profile';
import { runServiceStart } from './service';

export interface CodexDualSetupOptions {
  rootDir?: string;
  mainProfile?: string;
  notifyProfile?: string;
  workspace?: string;
  noStart?: boolean;
  skipCheckLarkCli?: boolean;
}

export async function runCodexDualSetup(opts: CodexDualSetupOptions = {}): Promise<void> {
  const rootDir = opts.rootDir ?? paths.rootDir;
  const mainProfile = opts.mainProfile ?? 'codex';
  const notifyProfile = opts.notifyProfile ?? `${mainProfile}-notify`;
  if (mainProfile === notifyProfile) {
    throw new Error('main profile and notify profile must be different');
  }
  if (!notifyProfile.endsWith('notify')) {
    throw new Error('notify profile name must end with "notify" so completion monitoring is enabled');
  }

  console.log(`将配置 Codex 双机器人: ${mainProfile} + ${notifyProfile}`);
  await ensureCodexProfile(mainProfile, {
    rootDir,
    workspace: opts.workspace,
    label: '主聊天机器人',
  });
  await ensureCodexProfile(notifyProfile, {
    rootDir,
    workspace: opts.workspace,
    label: '任务完成通知机器人',
  });
  await runProfileUse(mainProfile, { rootDir });

  if (opts.noStart) {
    console.log('已创建双机器人 profile。按需启动:');
    console.log(`  lark-channel-bridge start --profile ${mainProfile}`);
    console.log(`  lark-channel-bridge start --profile ${notifyProfile}`);
    return;
  }

  console.log(`启动主聊天机器人: ${mainProfile}`);
  await runServiceStart({
    profile: mainProfile,
    skipCheckLarkCli: opts.skipCheckLarkCli,
  });
  console.log(`启动任务完成通知机器人: ${notifyProfile}`);
  await runServiceStart({
    profile: notifyProfile,
    skipCheckLarkCli: opts.skipCheckLarkCli,
  });
  console.log('Codex 双机器人已就绪。');
}

async function ensureCodexProfile(
  name: string,
  opts: { rootDir: string; workspace?: string; label: string },
): Promise<void> {
  const existing = await readExistingProfile(opts.rootDir, name);
  if (existing) {
    if (existing.agentKind !== 'codex') {
      throw new Error(`profile ${name} already exists with agentKind ${existing.agentKind}; expected codex`);
    }
    console.log(`✓ ${opts.label} profile 已存在: ${name}`);
    return;
  }
  console.log(`创建 ${opts.label} profile: ${name}`);
  console.log('终端会显示二维码,请用飞书 App 扫码完成应用创建。');
  await runProfileCreate(name, {
    rootDir: opts.rootDir,
    agent: 'codex',
    ...(opts.workspace ? { workspace: opts.workspace } : {}),
  });
}

async function readExistingProfile(rootDir: string, name: string) {
  const root = await loadRootConfig(resolveAppPaths({ rootDir }).configFile).catch((err) => {
    if (err instanceof Error && err.message.startsWith('root config not found:')) return undefined;
    throw err;
  });
  return root?.profiles[name];
}
