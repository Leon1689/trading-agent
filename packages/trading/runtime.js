/** Shared construction for separately hosted Harness Host/Agent processes. No account configuration is browser-controlled. */
import { existsSync, readFileSync } from 'node:fs';
import { TradingService } from './service.js';
import { resolveConfig } from './config.js';
import { TradingError } from './errors.js';
import { createPiRunner } from './pi-runtime.js';

export function loadConfig(path) {
  if (!existsSync(path)) return resolveConfig();
  try { return resolveConfig(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { throw new TradingError('INVALID_CONFIG', 'trading-workbench/config.json无效；服务未启动。', 500); }
}
export async function createService(ctx) {
  const config = loadConfig(ctx.dshHomePath('data', 'trading-workbench', 'config.json'));
  const { Ledger } = await import('@local/options-ledger-dashboard/core');
  const ledger = new Ledger(ctx.dshHomePath('data', 'options-ledger', 'ledger.sqlite'));
  try {
    const service = new TradingService({ path: ctx.dshHomePath('data', 'trading-workbench', 'workbench.sqlite'), config, ledger, runner: config.pi.enabled ? createPiRunner(config.pi) : null });
    return { service, ledger };
  } catch (error) { ledger.close(); throw error; }
}
