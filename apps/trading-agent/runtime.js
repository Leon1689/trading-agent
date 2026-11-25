/** Standalone Pi application construction. No Harness, Cordis or DSH_HOME dependency. */
import { mkdirSync, readFileSync, existsSync, chmodSync, realpathSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';
import { Ledger } from '../../packages/ledger/ledger.js';
import { TradingService } from '../../packages/trading/service.js';
import { resolveConfig } from '../../packages/trading/config.js';
import { createPiSessionRunner } from '../../packages/trading/pi-session-runtime.js';
import { computerPolicy } from '../../packages/trading/computer-tools.js';
import { fileURLToPath } from 'node:url';
import { TradingError } from '../../packages/trading/errors.js';

export const FRAMEWORK = Object.freeze({ framework: 'pi-coding-agent', version: '1.6.0', applicationVersion: '3.5.0', standalone: true, sessionFormat: 'PI_JSONL_TREE', harnessRequired: false });
export function loadApplicationConfig(home, overrides = {}) {
  let input = {};
  const path = join(home, 'config.json');
  if (existsSync(path)) {
    try { input = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { throw new TradingError('INVALID_CONFIG', 'trading agent配置JSON无效。', 500); }
  }
  return resolveConfig({ ...input, ...overrides, pi: { ...input.pi, ...overrides.pi }, execution: { ...input.execution, ...overrides.execution } });
}
export async function createStandaloneRuntime({ home, config: overrides, providers, runner, now } = {}) {
  if (!home) throw new TradingError('HOME_REQUIRED', '独立应用需要明确数据目录。');
  home = resolve(home); mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
  home=realpathSync(home);
  const config = loadApplicationConfig(home, overrides);
  const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
  const computer=computerPolicy(config.computer,{workspace:home===sourceRoot||home.startsWith(sourceRoot+'/')?sourceRoot+'-workspace':join(dirname(home),basename(home)+'-workspace'),protectedPaths:[home],sourceRoot});
  const ledger = new Ledger(join(home, 'ledger.sqlite'));
  try {
    const pi = runner ?? createPiSessionRunner(config.pi, { sessionDir: join(home, 'sessions'), computer, cwd:computer.workspace });
    const service = new TradingService({ path: join(home, 'workbench.sqlite'), config, ledger, providers, runner: pi, now });
    return { home, config, computer, ledger, service, runner: pi, framework: FRAMEWORK, close: async () => { try { await pi.close?.(); } finally { try { service.close(); } finally { ledger.close(); } } } };
  } catch (error) { ledger.close(); throw error; }
}
