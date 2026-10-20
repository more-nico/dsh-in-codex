import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const home = mkdtempSync(join(tmpdir(), 'dsh-test-home-'));
process.env.DSH_HOME = home;
process.on('exit', () => rmSync(home, { recursive: true, force: true }));
