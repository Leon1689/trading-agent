import {ibkrExecutionConfig} from './ibkr-execution.js';
import {resolvePiNative} from './pi-native-config.js';
import { requireThat } from './errors.js';

/** Resolve deployment choices once; browser/model input cannot change providers, secrets or execution mode. */
export function resolveConfig(input = {}) {
  const config = {
    computer: { workspace: null, files: {read:true,write:true}, shell: {enabled:true,write:true,timeoutMs:30000}, ...(input.computer??{}) },
    providers: { mode: 'live', predict: { enabled: false }, ...(input.providers ?? {}) },
    pi: { enabled: false, provider: '', model: '', apiKeyEnv: '', timeoutMs: 120000, maxToolCalls: 12, maxModelCalls: 8, maxTokens: 4096, maxMessages: 300, ...(input.pi ?? {}) },
    scheduler: { enabled: false, pollMs: 30000, minIntervalMs: 60000, ...(input.scheduler ?? {}) },
    limits: { requestBytes: 4 * 1024 * 1024, textFileBytes: 1024 * 1024, imageBytes: 2 * 1024 * 1024, listLimit: 200, orderPreviewTtlMs: 300000, ...(input.limits ?? {}) },
    execution: { mode: 'READ_ONLY', ...(input.execution ?? {}) },
  };
  requireThat(['READ_ONLY', 'LOCAL_PAPER', 'IBKR_PAPER'].includes(config.execution.mode), 'INVALID_CONFIG', '执行模式支持READ_ONLY、LOCAL_PAPER或IBKR_PAPER；实盘未启用。');
  for (const [section, fields] of Object.entries({ limits: Object.keys(config.limits), scheduler: ['pollMs', 'minIntervalMs'], pi: ['timeoutMs', 'maxToolCalls', 'maxModelCalls', 'maxTokens', 'maxMessages'] })) {
    for (const field of fields) requireThat(Number.isSafeInteger(config[section][field]) && config[section][field] > 0, 'INVALID_CONFIG', `${section}.${field}必须为正整数。`);
  }
  if (config.pi.enabled) {
    requireThat(typeof config.pi.provider === 'string' && config.pi.provider && typeof config.pi.model === 'string' && config.pi.model && /^[A-Z][A-Z0-9_]*$/.test(config.pi.apiKeyEnv), 'INVALID_CONFIG', 'Pi需要显式provider、model和密钥环境变量名称。');
  }
  config.execution.ibkr=ibkrExecutionConfig(config.execution.ibkr);
  if(config.execution.mode==='IBKR_PAPER')requireThat(config.execution.ibkr,'INVALID_CONFIG','IBKR_PAPER需要独立执行配置。');
  config.pi.native=resolvePiNative(config.pi.native);
  return config;
}
