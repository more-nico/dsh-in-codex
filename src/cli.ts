import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDaemon } from './daemon.js';
import { runMcp } from './mcp.js';
import { hookMain } from './hooks.js';
import { install, uninstall, projectCommand } from './install.js';
import { dataRoot, socketPath, errorText } from './config.js';
import { request, compatibleDaemon, stopDaemon, withLifecycleLock } from './client.js';
import { BUILD } from './build.js';
import { DshProcess, bridgeArgs, assertDshVersion } from './dsh.js';
import { describeConfigError, pluginScope } from './plugin-scope.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DSH_PROFILE } from '../scripts/profile.mjs';

function option(name: string): string | undefined {
  const args = process.argv.slice(2);
  const inline = args.find(argument => argument.startsWith(`${name}=`));
  if (inline) {
    const value = inline.slice(name.length + 1);
    if (!value) throw new Error(`${name} requires a path`);
    return value;
  }
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a path`);
  return value;
}

async function main() {
  const command = process.argv[2] || 'help';
  const codexHome = option('--codex-home');
  const project = option('--project');
  if (command === 'mcp') return runMcp();
  if (command === 'daemon') return runDaemon();
  if (command === 'hook') return hookMain();
  if (command === 'install' || command === 'uninstall') {
    if (codexHome) process.env.CODEX_HOME = codexHome;
    console.log(JSON.stringify(await (command === 'install' ? install(codexHome, { project }) : uninstall(codexHome)), null, 2)); return;
  }
  if (command === 'project') {
    const action = process.argv[3];
    if (action !== 'enable' && action !== 'disable' && action !== 'status') throw new Error('Usage: dsh-in-codex project enable|disable|status [--project PATH] [--codex-home PATH]');
    console.log(JSON.stringify(await projectCommand(action, project, codexHome), null, 2)); return;
  }
  if (command === 'doctor') {
    let dshVersion: string | undefined, dshError: string | undefined, bridge: any, daemon: any;
    const temporary = await mkdtemp(join(tmpdir(), 'dsh-in-codex-doctor-'));
    let runtime: DshProcess | undefined;
    try {
      const executable = process.env.DSH_IN_CODEX_DSH_PATH || 'dsh';
      dshVersion = (await promisify(execFile)(executable, ['--version'], { timeout: 10_000 })).stdout.trim();
      assertDshVersion(dshVersion);
      runtime = new DshProcess(executable, await bridgeArgs(temporary), process.cwd(), { DSH_IN_CODEX_SESSION: JSON.stringify({ probe: true }) });
      runtime.on('fault', () => {});
      const state = await runtime.command('get_state');
      if (state.bridgeVersion !== 1) throw new Error('DSH bridge capability handshake failed');
      bridge = { version: state.bridgeVersion, capabilities: state.capabilities, profile: DSH_PROFILE,
        probe_model: state.model ? { provider: state.model.provider, id: state.model.id, thinking: state.thinkingLevel } : null };
    } catch (error) { dshError = errorText(error); }
    finally { await runtime?.close(); await rm(temporary, { recursive: true, force: true }); }
    try { daemon = await request('ping', undefined, {}, 500); } catch { daemon = 'not running (starts on first use)'; }
    let scope: any;
    try { scope = await pluginScope(project || process.cwd(), codexHome); }
    catch (error) { scope = { error: describeConfigError(error) }; }
    const report = { build: BUILD, daemonCompatible: typeof daemon === 'object' ? compatibleDaemon(daemon) : undefined, node: process.version, platform: process.platform, supportedPlatform: process.platform === 'darwin', dshVersion, dshError, bridge, dataRoot: dataRoot(), socket: socketPath(), daemon, pluginScope: scope,
      requirements: ['DSH 0.2.1-rc.2 / compatible 0.2.x with native bridge capabilities', `Configured DSH ${DSH_PROFILE} profile and credentials`, 'Codex per-call thread metadata and trusted plugin hooks'],
      testedBaseline: { codex: '26.1013.31256', dsh: '0.2.1-rc.2' } };
    console.log(JSON.stringify(report, null, 2)); if (dshError) process.exitCode = 1; return;
  }
  if (command === 'daemon-stop') { await withLifecycleLock(() => stopDaemon()); console.log('Daemon stopped; active runs were interrupted.'); return; }
  console.log(`dsh-in-codex ${BUILD.version}\n\nCommands:\n  install [--codex-home PATH] [--project PATH]  Install panel; DSH tasks require project opt-in\n  uninstall [--codex-home PATH]                  Remove the installed plugin; preserve transcripts\n  project enable|disable|status [--project PATH] [--codex-home PATH]\n                                                 Manage one project's DSH access\n  doctor [--project PATH] [--codex-home PATH]    Check runtime prerequisites and read-only project scope\n  daemon-stop                                    Stop the local daemon and interrupt active work\n  mcp | hook | daemon                            Internal plugin entry points\n`);
}
main().catch(error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
