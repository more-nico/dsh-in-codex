import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runDaemon } from './daemon.js';
import { runMcp } from './mcp.js';
import { hookMain } from './hooks.js';
import { install, uninstall } from './install.js';
import { dataRoot, socketPath, errorText } from './config.js';
import { request, compatibleDaemon, stopDaemon, withLifecycleLock } from './client.js';
import { BUILD } from './build.js';
import { DshProcess, bridgeArgs, assertDshVersion } from './dsh.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DSH_PROFILE } from '../scripts/profile.mjs';

async function main() {
  const command = process.argv[2] || 'help';
  const homeIndex = process.argv.indexOf('--codex-home');
  const codexHome = homeIndex >= 0 ? process.argv[homeIndex + 1] : undefined;
  if (homeIndex >= 0 && !codexHome) throw new Error('--codex-home requires a path');
  if (command === 'mcp') return runMcp();
  if (command === 'daemon') return runDaemon();
  if (command === 'hook') return hookMain();
  if (command === 'install' || command === 'uninstall') {
    if (codexHome) process.env.CODEX_HOME = codexHome;
    console.log(JSON.stringify(await (command === 'install' ? install(codexHome) : uninstall(codexHome)), null, 2)); return;
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
      bridge = { version: state.bridgeVersion, capabilities: state.capabilities, selected: state.model, profile: DSH_PROFILE };
    } catch (error) { dshError = errorText(error); }
    finally { await runtime?.close(); await rm(temporary, { recursive: true, force: true }); }
    try { daemon = await request('ping', undefined, {}, 500); } catch { daemon = 'not running (starts on first use)'; }
    const report = { build: BUILD, daemonCompatible: typeof daemon === 'object' ? compatibleDaemon(daemon) : undefined, node: process.version, platform: process.platform, supportedPlatform: process.platform === 'darwin', dshVersion, dshError, bridge, dataRoot: dataRoot(), socket: socketPath(), daemon,
      requirements: ['DSH 0.2.1-rc.2 / compatible 0.2.x with native bridge capabilities', `Configured DSH ${DSH_PROFILE} profile and credentials`, 'Codex per-call thread metadata and trusted plugin hooks'],
      testedBaseline: { codex: '26.1013.31256', dsh: '0.2.1-rc.2' } };
    console.log(JSON.stringify(report, null, 2)); if (dshError) process.exitCode = 1; return;
  }
  if (command === 'daemon-stop') { await withLifecycleLock(() => stopDaemon()); console.log('Daemon stopped; active runs were interrupted.'); return; }
  console.log(`dsh-in-codex ${BUILD.version}\n\nCommands:\n  install [--codex-home PATH]  Install a local plugin and marketplace entry\n  uninstall [--codex-home PATH] Remove the installed plugin; preserve transcripts\n  doctor                       Check runtime prerequisites\n  daemon-stop                  Stop the local daemon and interrupt active work\n  mcp | hook | daemon          Internal plugin entry points\n`);
}
main().catch(error => { process.stderr.write(errorText(error) + '\n'); process.exitCode = 1; });
