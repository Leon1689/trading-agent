/** Optional official Pi extension. The standalone application uses customTools directly. */
import { readFileSync, lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computerPolicy, createComputerTools, COMPUTER_SCOPES } from '../../packages/trading/computer-tools.js';
import { TradingService } from '../../packages/trading/service.js';
import { catalog, validateInput } from '../../packages/trading/catalog.js';
import { priceOption, impliedVolatility, optionScenario, analyzeWheel, portfolioRisk, backtestPortfolio, rankOptions } from '../../packages/trading/quant.js';
import { TRADING_SYSTEM_POLICY } from '../../packages/trading/pi-session-runtime.js';

const calculators = { 'quant.price': priceOption, 'quant.iv': impliedVolatility, 'quant.scenario': optionScenario, 'wheel.analyze': analyzeWheel, 'portfolio.risk': portfolioRisk, 'portfolio.backtest': backtestPortfolio, 'options.rank': rankOptions };
const permittedScopes = ['compute', 'market', 'predict', 'portfolio', 'files', 'broker'];
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value });
const failure = error => { const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code) ? error.code : 'TOOL_FAILED'; return { content: [{ type: 'text', text: `Trading tool failed (${code}). No successful state change is established.` }], details: { code }, isError: true }; };

/** Register with Pi's ExtensionAPI; config is loaded only from an explicitly supplied absolute path. */
export default function trading(pi) {
  const configFile = process.env.PI_TRADING_CONFIG;
  let service, allowedScopes = ['compute'], computerScopes=[];
  let computer={workspace:process.cwd(),files:{read:true,write:true},shell:{enabled:true,write:true,timeoutMs:30000},protectedPaths:[]};
  if (configFile !== undefined) {
    if (!isAbsolute(configFile) || !lstatSync(configFile).isFile() || lstatSync(configFile).isSymbolicLink()) throw new Error('PI_TRADING_CONFIG must identify an explicit regular configuration file');
    const config = JSON.parse(readFileSync(configFile, 'utf8'));
    if (typeof config.dataDir !== 'string' || !isAbsolute(config.dataDir)) throw new Error('Extension config requires an absolute dataDir');
    computerScopes=config.extension?.allowedComputerScopes??[];
    if(!Array.isArray(computerScopes)||computerScopes.some(scope=>!COMPUTER_SCOPES.includes(scope)))throw new Error('Invalid allowedComputerScopes');
    computer=computerPolicy(config.computer,{workspace:join(dirname(config.dataDir),basename(config.dataDir)+'-workspace'),protectedPaths:[config.dataDir],sourceRoot:resolve(dirname(fileURLToPath(import.meta.url)),'../..')});
    allowedScopes = config.extension?.allowedScopes ?? ['compute'];
    if (!Array.isArray(allowedScopes) || allowedScopes.some(scope => !permittedScopes.includes(scope))) throw new Error('Invalid extension allowedScopes; ledger access requires the standalone application');
    if (config.execution?.mode && config.execution.mode !== 'READ_ONLY') throw new Error('The optional Pi extension supports READ_ONLY execution only');
    mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
    service = new TradingService({ path: join(config.dataDir, 'extension.sqlite'), config: { ...config, execution: { mode: 'READ_ONLY' }, pi: { ...config.pi, enabled: false }, scheduler: { ...config.scheduler, enabled: false } } });
  }
  // Without explicit config, the four tools are registered but computer scopes are ungranted; calculations remain usable without database/network initialization.
  const descriptors = catalog.filter(item => item.model && item.kind !== 'human' && (item.requiredScopes??[item.scope]).every(scope=>allowedScopes.includes(scope)) && (service || calculators[item.operation]));
  const names = descriptors.map(item => `trading_${item.operation.replaceAll('.', '_')}`);
  for (const item of descriptors) {
    pi.registerTool({ name: `trading_${item.operation.replaceAll('.', '_')}`, label: item.title, description: item.description, parameters: item.inputSchema, executionMode: 'sequential', execute: async (_id, args, signal) => {
      try {
        signal?.throwIfAborted();
        validateInput(args, item.inputSchema);
        return result(service ? await service.execute(item.operation, args, { actor: 'model', allowedScopes, signal }) : { ...calculators[item.operation](args), inputAuthority: 'USER_SUPPLIED_SCENARIO', orderSubmissionEnabled: false });
      } catch (error) { return failure(error); }
    } });
  }
  for(const tool of createComputerTools(computer,{scopes:computerScopes})){pi.registerTool(tool);names.push(tool.name);}
  // Add trading tools without replacing the user's native Pi tool selection.
  pi.on('input', (_event, ctx) => {
    const privateScopes = ['broker', 'files', 'portfolio', 'ledger',...COMPUTER_SCOPES];
    const grants=[...allowedScopes,...computerScopes];
    const historyScopes = [...new Set(ctx.sessionManager.getBranch().filter(entry => entry.type === 'custom' && entry.customType === 'trading.scope.v1').flatMap(entry => entry.data?.privateScopes ?? []))];
    const missing = historyScopes.filter(scope => !grants.includes(scope));
    if (missing.length) {
      ctx.ui.notify(`This native session contains private context requiring: ${missing.join(', ')}. Restore the explicit config scopes or start a clean session.`, 'error');
      return { action: 'handled' };
    }
    pi.appendEntry('trading.scope.v1', { privateScopes: [...new Set([...historyScopes, ...grants.filter(scope => privateScopes.includes(scope))])] });
    return { action: 'continue' };
  });
  pi.on('before_agent_start', event => ({ systemPrompt: `${event.systemPrompt}\n\n${TRADING_SYSTEM_POLICY}\nAllowed trading scopes: ${allowedScopes.join(', ')}. Computer scopes: ${computerScopes.join(', ')}.` }));
  pi.on('session_shutdown', async () => { service?.close(); });
}
