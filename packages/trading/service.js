import { analyzeOptionStrategy } from './option-strategy.js';
import { InvestmentAssistant } from './investment-assistant.js';
import { AssistantJobs } from './assistant-jobs.js';
import { OrderMonitor } from './order-monitor.js';
import { Reconciliation } from './reconciliation.js';
/** Application operations shared by the authenticated Host, Pi tools and Harness tools. */
import { randomUUID, createHash } from 'node:crypto';
import { TradingStore } from './storage.js';
import { createProviders } from './providers.js';
import { resolveConfig } from './config.js';
import { catalog, validateInput } from './catalog.js';
import { TradingError, requireThat, errorBody } from './errors.js';
import { importFile, inspectEvents } from './files.js';
import { TradeFlow } from './trade-flow.js';
import { PaperExecution } from './paper.js';
import { ConditionalPaper } from './conditional-paper.js';
import { WorkspaceFeatures } from './workspace-features.js';
import { technicalIndicators, classifyNews, planRebalance, comparePredictionMarkets } from './research-features.js';
import { priceOption, impliedVolatility, optionScenario, analyzeWheel, portfolioRisk, backtestPortfolio, rankOptions } from './quant.js';

const defaultScopes = ['market', 'compute', 'predict'];
const allScopes = ['market', 'compute', 'predict', 'portfolio', 'files', 'ledger', 'broker', 'localRead', 'localWrite', 'shell', 'resources', 'trade'];
const computations = { 'options.strategy': analyzeOptionStrategy, 'quant.price': priceOption, 'quant.iv': impliedVolatility, 'quant.scenario': optionScenario, 'wheel.analyze': analyzeWheel, 'portfolio.risk': portfolioRisk, 'portfolio.backtest': backtestPortfolio, 'options.rank': rankOptions, 'research.technicals': technicalIndicators, 'research.events': classifyNews, 'portfolio.rebalancePlan': planRebalance, 'predict.compare': comparePredictionMarkets };
const safeChat = ({ piMessages, events, ...chat }) => chat;
const fileSummary = ({ content, dataBase64, parsed, ...file }) => file;
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bindNativeUser = (messages, nativeSession) => {
  if (!nativeSession?.promptAppended || !nativeSession.promptUserEntryId) return messages;
  const index = messages.findLastIndex(message => message.role === 'user');
  return messages.map((message, i) => i === index ? { ...message, nativeUserEntryId: nativeSession.promptUserEntryId } : message);
};

export class TradingService {
  constructor({ path, config = {}, ledger = null, providers, runner = null, gateway, store, now = () => Date.now() }) {
    this.config = resolveConfig(config); this.ledger = ledger;
    this.providers = providers ?? createProviders(this.config.providers);
    this.store = store ?? new TradingStore(path); this.runner = runner; this.now = now;
    this.trades=new TradeFlow(this.store,this.config,{gateway,now});
    this.assistant=new InvestmentAssistant(this);this.assistantJobs=new AssistantJobs(this);
    this.orderMonitor=new OrderMonitor(this);this.reconciliation=new Reconciliation(this);
    this.paper = new PaperExecution(this.store, this.config, now); this.activeChats = new Set(); this.activeAlerts = new Set(); this.closing = false; this.conditions = new ConditionalPaper(this.store, this.paper, now); this.workspace = new WorkspaceFeatures(this);
  }
  capabilities() {
    return { native: this.runner?.native??null, computer: this.runner?.computer??null, providers: this.providers.capabilities(), brokerAccess: this.config.execution.mode==='IBKR_PAPER'?'PAPER_HUMAN_CONFIRM':'READ_ONLY', reconciliation:{savedReports:true,automaticLedgerPosting:false},orderMonitoring:{enabled:this.config.orderMonitoring.enabled,perOrderOptIn:true,intervalMs:this.config.orderMonitoring.intervalMs},conversationalTrading:{intent:true,humanConfirmation:true,brokerPaper:this.config.execution.mode==='IBKR_PAPER',connectionValidated:false,live:false}, execution: this.config.execution.mode, chat: { enabled: this.config.pi.enabled && !!this.runner, images: this.config.pi.enabled && this.runner?.supportsImages === true }, notifications: { local: true, background: this.config.scheduler.enabled, externalDelivery: false }, files: ['text/csv', 'application/json', 'application/x-ndjson', 'text/plain', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp'], liveTrading: false, publicSharing: false, nativeMobileApp: false, installableWebApp: true, localSharing: true, conditionalPreviews: true, personalAssistant: {investmentPlans:true,holdingsBriefs:true,optionStrategies:true,predictionDepth:true,conditionMonitoring:true,automaticBrokerSubmission:false} };
  }
  bootstrap() { return { catalog, capabilities: this.capabilities(), settings: this.settings(), limits: { textFileBytes: this.config.limits.textFileBytes, imageBytes: this.config.limits.imageBytes, requestBytes: this.config.limits.requestBytes, requestTimeoutMs: this.config.pi.timeoutMs + 10000 } }; }
  settings() { return this.store.get('settings', 'display') ?? { id: 'display', revision: 0, language: 'zh', timezone: 'Asia/Shanghai' }; }
  /** A caller cannot promote itself: HTTP and tool adapters bind actor/scopes outside user args. */
  async execute(operation, args = {}, { actor = 'human', allowedScopes = defaultScopes, signal, traceId = randomUUID(), chatId, sourceMessage } = {}) {
    const descriptor = catalog.find(o => o.operation === operation);
    requireThat(!this.closing, 'CLOSING', '服务正在关闭，请稍后重试。', 503);
    try {
    requireThat(descriptor, 'UNKNOWN_OPERATION', '操作不存在。', 404);
    if (actor === 'model') {
      requireThat(descriptor.model && descriptor.kind !== 'human', 'HUMAN_REQUIRED', '该操作只能由用户在界面执行。', 403);
      requireThat((descriptor.requiredScopes??[descriptor.scope]).every(scope=>allowedScopes.includes(scope)), 'SCOPE_DENIED', '本轮未允许访问该数据范围。', 403, { scope: descriptor.scope });
    }
    try { validateInput(args, descriptor.inputSchema); } catch (error) { throw new TradingError('INVALID_INPUT', error.message); }
    signal?.throwIfAborted();
      const data = await this.dispatch(operation, args, { actor, allowedScopes, signal, traceId, chatId, sourceMessage });
      this.store.append({ traceId, operation, actor, status: 'OK', inputHash: sha(args), resultHash: sha(data) });
      return data;
    } catch (error) {
      const code = error.code ?? 'OPERATION_FAILED'; this.store.append({ traceId, operation, actor, status: 'ERROR', code, inputHash: sha(args) });
      if (error instanceof TradingError) throw error;
      if (error.name === 'ProviderError' || error.name === 'QuantError' || error.name === 'PiRuntimeError') throw new TradingError(code, error.message, error.status ?? 400);
      if (error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
      throw new TradingError('OPERATION_FAILED', '操作未完成；输入、数据或服务配置需要核对。', 500);
    }
  }
  async dispatch(operation, args, context) {
    const { actor, signal } = context;
    if(operation==='jobs.configure')return this.assistantJobs.configure(args);
    if(operation==='jobs.list')return this.assistantJobs.list();
    if(operation==='jobs.run')return this.assistantJobs.run(args.id,signal,true);
    if(operation==='holdings.reports')return this.store.list('holdingsReport');
    if(operation==='holdings.report')return this.store.require('holdingsReport',args.id);
    if(/^(plan|holdings)\./.test(operation)||['research.opportunities','predict.board'].includes(operation))return this.assistant.execute(operation,args,context);
    if(operation.startsWith('reconcile.')) {
      switch(operation) {
        case 'reconcile.create': return this.reconciliation.create(args);
        case 'reconcile.get': return this.reconciliation.get(args.id);
        case 'reconcile.list': return this.reconciliation.list();
        case 'reconcile.review': return this.reconciliation.review(args);
      }
    }
    if(operation.startsWith('trade.')){
      switch(operation){
        case 'trade.intent': return this.trades.upsert(args,context);
        case 'trade.get': return this.trades.get(args.id);
        case 'trade.list': return this.trades.list(context.chatId?{chatId:context.chatId}:args);
        case 'trade.search': this.trades.enabled(); return this.trades.gateway.search(args.symbol,signal);
        case 'trade.optionContracts': this.trades.enabled(); return this.trades.gateway.options(args,signal);
        case 'trade.prepare': return this.trades.prepare(args,signal);
        case 'trade.review': return this.trades.review(args);
        case 'trade.confirm': return this.trades.confirm(args,signal);
        case 'trade.watch': return this.orderMonitor.watch(args);
        case 'trade.monitorStatus': return this.orderMonitor.status(args);
        case 'trade.refresh': return this.trades.refresh(args,signal);
        case 'trade.discard': return this.trades.discard(args);
      }
    }
    if (operation.startsWith('market.') || operation.startsWith('broker.') || ['predict.markets', 'predict.detail', 'predict.orderbook'].includes(operation)) {
      const result = await this.providers.request(operation, args, { signal }); signal?.throwIfAborted();
      if (operation === 'broker.snapshot') {
        const snapshot = this.store.put('snapshot', randomUUID(), { ...result, immutable: true, accountId: args.accountId, inputAuthority: result.mode === 'synthetic' ? 'SYNTHETIC_FIXTURE' : 'BROKER_REPORTED', strategyLedgerUpdated: false, quality: { complete: false, reason: result.mode === 'synthetic' ? '仅合成输入，非实际账户证据。' : '账户、持仓、挂单来自独立读取；未建立原子快照或完整历史。' } }, 0);
        return snapshot;
      }
      return result;
    }
    if (computations[operation]) {
      const result = computations[operation](args);
      return { ...result, inputAuthority: 'USER_SUPPLIED_SCENARIO', orderSubmissionEnabled: false, calculationId: randomUUID(), calculationVersion: '3.0.0', inputHash: sha(args) };
    }
    if (['chat.search','chat.trash','chat.restore','chat.fork','chat.native','chat.exportNative'].includes(operation) || /^(share|briefs|profile)\./.test(operation)) return this.workspace.execute(operation,args,context);
    switch (operation) {
      case 'conditions.create': return this.conditions.create(args);
      case 'conditions.list': return this.conditions.list(args);
      case 'conditions.get': return this.conditions.get(args.id);
      case 'conditions.cancel': return this.conditions.cancel(args);
      case 'conditions.evaluate': return this.conditions.evaluate(args);
      case 'conditions.previewTriggered': return this.conditions.previewTriggered(args);
      case 'order.replaceDraft': return this.store.transaction(() => { const row=this.store.require('order',args.id); requireThat(row.status==='DRAFT'&&row.revision===args.revision,'ORDER_STATE','只能替换当前版本的未确认草稿。',409); requireThat(Object.keys(args.patch).every(key=>Object.keys(row.order).includes(key)&&key!=='mode'),'INVALID_ORDER','草稿修改字段无效。'); const next=this.paper.preview({...row.order,...args.patch});this.store.put('order',row.id,{...row,status:'CANCELLED',supersededBy:next.id},row.revision);return next; });
      case 'research.stock': {
        const comparison=await this.execute('research.compare',{symbols:[args.symbol],sections:['quote','profile','financials','analysts','news']},context);
        let technical;
        try { const history=await this.providers.request('market.history',{symbol:args.symbol,from:args.from,to:args.to,limit:5000},{signal}); requireThat(history.priceBasis==='split_and_dividend_adjusted_eod','UNKNOWN_PRICE_BASIS','历史复权口径无法确认。'); technical={...technicalIndicators({symbol:args.symbol,series:history.data.map(row=>({date:row.date,close:Number(row.adjustedClose)})),priceBasis:'ADJUSTED_TOTAL_RETURN',asOf:new Date(this.now()).toISOString()}),source:history.source,complete:history.complete}; }
        catch(error){ if(signal?.aborted)throw error;technical={unavailable:true,code:error.code??'DATA_UNAVAILABLE'}; }
        return {symbol:args.symbol,research:comparison.results[0],technical,generatedAt:new Date(this.now()).toISOString(),orderSubmissionEnabled:false};
      }
      case 'snapshot.list': return this.store.list('snapshot', { limit: this.config.limits.listLimit }).map(({ data, ...row }) => row);
      case 'snapshot.get': return this.store.require('snapshot', args.id);
      case 'research.compare': case 'research.brief': {
        requireThat(args.symbols.length > 0 && args.symbols.length <= 8, 'INVALID_SYMBOLS', '一次研究限1到8个标的。');
        const sections = operation === 'research.brief' ? ['quote', 'news'] : args.sections;
        const results = [];
        for (const symbol of [...new Set(args.symbols)]) {
          const row = { symbol, sections: {} };
          for (const section of [...new Set(sections)]) {
            signal?.throwIfAborted();
            try { row.sections[section] = await this.providers.request(`market.${section}`, { symbol, limit: 5 }, { signal }); }
            catch (error) { if (signal?.aborted) throw error; row.sections[section] = { unavailable: true, code: error.code ?? 'DATA_UNAVAILABLE', message: '此项数据不可用；请检查数据订阅和服务配置。' }; }
          }
          results.push(row);
        }
        return { results, generatedAt: new Date(this.now()).toISOString(), interpretation: '结构化研究资料，包含来源和缺失项；可在Pi会话中解释。', recommendation: null };
      }
      case 'ledger.read': requireThat(this.ledger, 'LEDGER_UNAVAILABLE', '原账本插件未加载。', 503); return this.ledger.view();
      case 'ledger.propose': {
        requireThat(this.ledger, 'LEDGER_UNAVAILABLE', '原账本插件未加载。', 503);
        const value = this.ledger.change({ action: 'propose', revision: args.revision, data: { requestId: args.requestId, action: args.action, data: args.data } }, signal);
        return { revision: value.revision, status: 'PENDING_USER_REVIEW', proposals: value.proposals.filter(p => p.status === 'pending'), ledgerCommitted: false };
      }
      case 'portfolio.save': {
        const pairs = Object.entries(args.weights); requireThat(pairs.length > 0 && pairs.length <= 30, 'INVALID_WEIGHTS', '组合需包含1到30个标的。');
        requireThat(pairs.every(([symbol, weight]) => /^[A-Z0-9.\-]{1,24}$/.test(symbol) && typeof weight === 'number' && Number.isFinite(weight) && weight > 0 && weight <= 1) && Math.abs(pairs.reduce((n, [, w]) => n + w, 0) - 1) <= 1e-9, 'INVALID_WEIGHTS', '权重必须为正且合计为1。');
        return this.store.put('portfolio', args.id ?? randomUUID(), { name: args.name, weights: args.weights, note: args.note ?? '', type: 'RESEARCH_ONLY' }, args.id ? args.revision : 0);
      }
      case 'portfolio.list': return this.store.list('portfolio', { limit: this.config.limits.listLimit }).filter(row=>this.assistant.allowed(row,context));
      case 'portfolio.get': { const row=this.store.require('portfolio', args.id);requireThat(this.assistant.allowed(row,context),'SCOPE_DENIED','组合包含本轮未授权的私人资料。',403);return row; }
      case 'portfolio.backtestLive': {
        const symbols = [...new Set([...Object.keys(args.weights), ...(args.benchmarkSymbol ? [args.benchmarkSymbol] : [])])];
        requireThat(symbols.length > 0 && symbols.length <= 30, 'INVALID_WEIGHTS', '回测标的数量无效。');
        const series = {}, sources = [];
        for (const symbol of symbols) {
          const response = await this.providers.request('market.history', { symbol, from: args.from, to: args.to, limit: this.config.providers.limits?.maxItems ?? 100 }, { signal });
          requireThat(response.mode !== 'synthetic' && response.data.length >= 2, 'INSUFFICIENT_HISTORY', '缺少实际历史数据；不使用演示数据代替。');
          requireThat(response.priceBasis === 'split_and_dividend_adjusted_eod', 'UNKNOWN_RETURN_BASIS', '历史价格的复权总回报口径无法确认。');
          requireThat(response.complete === true, 'INCOMPLETE_HISTORY', '历史数据已截断或覆盖未确认；请调整日期或请求上限后重新获取。');
          series[symbol] = response.data.map(row => ({ date: row.date, adjustedClose: row.adjustedClose }));
          sources.push({ symbol, source: response.source, asOf: response.asOf, receivedAt: response.receivedAt, missing: response.missing, priceBasis: response.priceBasis });
        }
        const result = backtestPortfolio({ ...args, series, seriesKind: 'ADJUSTED_TOTAL_RETURN', dataFrequency: 'DAILY' });
        return this.store.put('backtest', randomUUID(), { ...result, sources, inputHash: sha(args), requestedRange: { from: args.from, to: args.to }, executed: true, orderSubmissionEnabled: false }, 0);
      }
      case 'watchlist.add': {
        const previous = this.store.get('watchlist', args.key);
        if (previous && !previous.removed) return previous;
        return this.store.put('watchlist', args.key, { ...args, removed: false }, previous?.revision ?? 0);
      }
      case 'watchlist.list': return this.store.list('watchlist', { limit: this.config.limits.listLimit }).filter(row => !row.removed);
      case 'watchlist.remove': { const row = this.store.require('watchlist', args.id); return this.store.put('watchlist', args.id, { ...row, removed: true }, args.revision); }
      case 'order.preview': { const result = this.paper.preview(args); if (actor === 'model') { const { confirmationToken, ...safe } = result; return { ...safe, message: '模拟草稿已保存；用户需在工作台重新预览并人工确认。' }; } return result; }
      case 'order.confirm': return this.paper.confirm(args);
      case 'order.cancel': return this.paper.cancel(args);
      case 'order.list': this.paper.expireDayOrders(); return this.paper.orders(args.accountId);
      case 'paper.create': return this.paper.createAccount(args);
      case 'paper.list': return this.store.list('paperAccount', { limit: this.config.limits.listLimit }).map(row => this.paper.account(row.id));
      case 'paper.get': return this.paper.account(args.id);
      case 'paper.fill': return this.paper.fill(args);
      case 'alerts.create': {
        requireThat(Number.isFinite(args.threshold) && Number.isSafeInteger(args.intervalMs) && args.intervalMs >= this.config.scheduler.minIntervalMs && Number.isSafeInteger(args.maxAgeMs) && args.maxAgeMs > 0, 'INVALID_ALERT', '提醒阈值、周期或数据有效期无效。');
        requireThat(/^[A-Za-z0-9_.]+$/.test(args.field) && !args.field.split('.').some(x => ['__proto__', 'prototype', 'constructor'].includes(x)), 'INVALID_FIELD', '提醒字段路径无效。');
        return this.store.put('alert', randomUUID(), { ...args, enabled: true, nextRunAt: this.now(), previousMatched: false, lastCheckedAt: null, lastError: null, delivery: 'LOCAL_INBOX', schedulerRunning: this.config.scheduler.enabled }, 0);
      }
      case 'alerts.list': return this.store.list('alert', { limit: this.config.limits.listLimit });
      case 'alerts.evaluate': return this.evaluateAlert(args.id, signal);
      case 'alerts.update': { const row = this.store.require('alert', args.id); return this.store.put('alert', args.id, { ...row, enabled: args.enabled, nextRunAt: this.now() }, args.revision); }
      case 'notifications.list': return this.store.list('notification', { limit: this.config.limits.listLimit }).filter(row=>actor!=='model'||(row.requiredScopes??[]).every(scope=>context.allowedScopes.includes(scope)));
      case 'notifications.read': { const row = this.store.require('notification', args.id); return this.store.put('notification', args.id, { ...row, read: true }, args.revision); }
      case 'file.import': return importFile(this.store, args, this.config.limits);
      case 'file.list': return this.store.list('file', { limit: this.config.limits.listLimit }).map(fileSummary);
      case 'file.get': case 'file.export': return this.store.require('file', args.id);
      case 'file.inspectEvents': { const file = this.store.require('file', args.id); requireThat(file.parsed, 'NOT_EVENTS', '该附件未解析为事件数组。'); return { fileId: file.id, checksum: file.checksum, ...inspectEvents(file.parsed) }; }
      case 'report.save': return importFile(this.store, { ...args, mimeType: 'text/markdown' }, this.config.limits);
      case 'chat.create': return this.store.put('chat', randomUUID(), { title: args.title ?? '研究会话', pinned: false, archived: false, messages: [], piMessages: [], events: [], status: 'IDLE' }, 0);
      case 'chat.list': return this.store.searchChats({query:args.query,includeArchived:args.includeArchived,limit:this.config.limits.listLimit}).items.map(({messages,piMessages,events,...row})=>row);
      case 'chat.get': return safeChat(this.store.require('chat', args.id));
      case 'chat.update': {
        requireThat(!this.activeChats.has(args.id), 'CHAT_BUSY', '会话正在回答，请完成后修改。', 409);
        const row = this.store.require('chat', args.id); const patch = {};
        requireThat(row.status !== 'RUNNING', 'CHAT_BUSY', '会话正在回答；中断的会话需先恢复。', 409);
        for (const key of ['title', 'pinned', 'archived']) if (args[key] !== undefined) patch[key] = args[key];
        return safeChat(this.store.put('chat', args.id, { ...row, ...patch }, args.revision ?? row.revision));
      }
      case 'chat.send': return this.sendChat(args, signal);
      case 'chat.recover': {
        const row = this.store.require('chat', args.id);
        requireThat(row.status === 'RUNNING' && !this.activeChats.has(args.id) && Number.isFinite(row.runExpiresAt) && row.runExpiresAt < this.now(), 'CHAT_BUSY', '会话仍可能运行，暂不能恢复。', 409);
        return safeChat(this.store.put('chat', args.id, { ...row, status: 'FAILED', lastError: { code: 'INTERRUPTED', message: '上轮未正常结束；请先核对已保存文件、草稿和操作记录，再发起新问题。' } }, args.revision));
      }
      case 'chat.export': { const row = this.store.require('chat', args.id); return importFile(this.store, { name: `chat-${row.id}.md`, mimeType: 'text/markdown', content: `# ${row.title}\n\n${row.messages.map(m => `## ${m.role}\n\n${m.content}`).join('\n\n')}\n` }, this.config.limits); }
      case 'chat.feedback': { const row = this.store.require('chat', args.id); requireThat(Number.isInteger(args.messageIndex) && row.messages[args.messageIndex]?.role === 'assistant', 'INVALID_MESSAGE', '反馈目标必须是助手消息。'); return this.store.put('feedback', randomUUID(), { ...args, createdAt: new Date(this.now()).toISOString() }, 0); }
      case 'settings.get': return this.settings();
      case 'settings.update': { try { new Intl.DateTimeFormat('en', { timeZone: args.timezone }); } catch (error) { throw new TradingError('INVALID_TIMEZONE', '时区无效。'); } const row = this.settings(); return this.store.put('settings', 'display', { language: args.language, timezone: args.timezone }, args.revision ?? row.revision); }
      case 'audit.list': return this.store.events(this.config.limits.listLimit);
      default: throw new TradingError('NOT_IMPLEMENTED', '该功能尚未实现。', 501);
    }
  }
  async evaluateAlert(id, signal) {
    requireThat(!this.activeAlerts.has(id), 'ALERT_BUSY', '提醒正在检查。', 409); this.activeAlerts.add(id);
    try {
      const initial = this.store.require('alert', id); if (!initial.enabled) return { id, skipped: 'PAUSED' };
      try {
        const response = await this.providers.request(initial.sourceOperation, initial.sourceArgs, { signal }); signal?.throwIfAborted();
        const sourceTime = response.asOf ? Date.parse(response.asOf) : NaN;
        requireThat(Number.isFinite(sourceTime) && sourceTime <= this.now() && this.now() - sourceTime <= initial.maxAgeMs, 'STALE_ALERT_DATA', '提醒源数据时间未知、未来或已过期。');
        const value = initial.field.split('.').reduce((node, key) => node?.[key], response);
        requireThat(value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)), 'ALERT_DATA_MISSING', '提醒所需数值不可用。');
        requireThat(response.mode !== 'synthetic', 'SYNTHETIC_ALERT', '实时提醒不能使用合成数据。');
        const matched = initial.comparator === 'gte' ? Number(value) >= initial.threshold : Number(value) <= initial.threshold;
        return this.store.transaction(() => {
          const current = this.store.require('alert', id);
          requireThat(current.revision === initial.revision && current.enabled, 'VERSION_CONFLICT', '提醒在查询期间已改变，本次结果未投递。', 409);
          let notification = null;
          if (matched && !initial.previousMatched) notification = this.store.put('notification', randomUUID(), { title: initial.name, alertId: id, value: Number(value), threshold: initial.threshold, source: response.source, asOf: response.asOf, observedAt: new Date(this.now()).toISOString(), read: false, delivery: 'LOCAL_INBOX' }, 0);
          const alert = this.store.put('alert', id, { ...current, enabled: !(matched && current.once), previousMatched: matched, lastValue: Number(value), lastCheckedAt: new Date(this.now()).toISOString(), nextRunAt: this.now() + current.intervalMs, lastError: null }, current.revision);
          return { alert, matched, notification };
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const current = this.store.require('alert', id);
        if (current.revision === initial.revision) this.store.put('alert', id, { ...current, lastError: { code: error.code ?? 'DATA_UNAVAILABLE', message: '本次提醒检查未完成，尚未确认触发。' }, nextRunAt: this.now() + current.intervalMs }, current.revision);
        throw error;
      }
    } finally { this.activeAlerts.delete(id); }
  }
  async backgroundTick(signal) {
    const results=this.config.scheduler.enabled?await this.tick(signal):[];
    return [...results,...await this.orderMonitor.tick(signal)];
  }
  async tick(signal) {
    this.paper.expireDayOrders();
    const results = [];
    for (const row of this.store.dueAlerts(this.now(), this.config.limits.listLimit)) {
      signal?.throwIfAborted(); if (!row.enabled || row.nextRunAt > this.now() || this.activeAlerts.has(row.id)) continue;
      try { results.push(await this.evaluateAlert(row.id, signal)); } catch (error) { if (signal?.aborted) throw error; results.push({ id: row.id, error: errorBody(error) }); }
    }
    for (const row of this.store.dueRecords('brief',this.now(),this.config.limits.listLimit)) { signal?.throwIfAborted(); try { results.push(await this.workspace.runBrief(row.id,signal)); } catch(error) { if(signal?.aborted)throw error; results.push({id:row.id,error:errorBody(error)}); } }
    results.push(...await this.assistantJobs.tick(signal));
    return results;
  }
  readShare(token) { return this.workspace.readShare(token); }
  modelTools(scopes, signal, runGuard, binding = {}) {
    requireThat(Array.isArray(scopes) && scopes.every(scope => allScopes.includes(scope)), 'INVALID_SCOPES', '数据访问范围无效。');
    return catalog.filter(o => o.model && (o.requiredScopes??[o.scope]).every(scope=>scopes.includes(scope))).map(o => ({ name: o.operation.replaceAll('.', '_'), label: o.title, description: o.description, parameters: o.inputSchema,
      execute: async (_toolCallId, args, toolSignal) => {
        try { runGuard?.(); const value = await this.execute(o.operation, args, { actor: 'model', allowedScopes: scopes, signal: toolSignal ?? signal, ...binding }); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }; }
        catch (error) { const failure = errorBody(error); return { content: [{ type: 'text', text: JSON.stringify({ error: failure }) }], details: { error: failure }, isError: true }; }
      } }));
  }
  async sendChat(args, signal) {
    requireThat(this.runner && this.config.pi.enabled, 'PI_UNCONFIGURED', 'Pi尚未配置模型；本地计算、账本和已配置数据工具仍可直接使用。', 503);
    requireThat(!this.activeChats.has(args.id), 'CHAT_BUSY', '此会话已有回答进行中。', 409);
    requireThat(args.message.trim().length > 0 && args.message.length <= 20000, 'INVALID_MESSAGE', '问题为空或过长。');
    const scopes = args.allowedScopes ?? defaultScopes;
    requireThat(scopes.every(scope => allScopes.includes(scope)), 'INVALID_SCOPES', '数据范围无效。');
    requireThat(!args.attachments?.length || scopes.includes('files'), 'ATTACHMENT_SCOPE_REQUIRED', '发送图片需明确允许已导入资料；该授权也将记入会话历史。', 403);
    const initial = this.store.require('chat', args.id);
    requireThat(!initial.deleted, 'CHAT_DELETED', '会话在回收站，请先恢复。', 409);
    requireThat(initial.status !== 'RUNNING', 'CHAT_BUSY', '会话在另一个实例运行或上次异常中断；超时后可手动恢复。', 409);
    // Full transcripts are resent. Conservatively remember every private scope previously granted,
    // including older records that predate historyScopes; never silently drop tool/result history.
    const privateScopes = ['broker', 'ledger', 'files', 'portfolio', 'localRead', 'localWrite', 'shell', 'resources', 'trade'];
    const historyScopes = [...new Set([...(initial.historyScopes ?? []), ...initial.messages.flatMap(item => item.allowedScopes ?? [])].filter(scope => privateScopes.includes(scope)))].sort();
    const missingScopes = historyScopes.filter(scope => !scopes.includes(scope));
    requireThat(missingScopes.length === 0, 'HISTORY_SCOPE_REQUIRED', '此会话历史可能包含之前获准的私人数据。请重新选择所需历史范围，或新建空会话；本次尚未发送模型，历史未删除。', 403, { requiredScopes: historyScopes, missingScopes });
    const nextHistoryScopes = [...new Set([...historyScopes, ...scopes.filter(scope => privateScopes.includes(scope))])].sort();
    this.activeChats.add(args.id);
    try {
      requireThat(!initial.archived, 'CHAT_ARCHIVED', '请先恢复已归档会话。', 409);
      requireThat((args.attachments ?? []).length <= 4, 'TOO_MANY_FILES', '每轮最多4张图片。');
      requireThat(!(args.attachments?.length) || this.runner.supportsImages === true, 'IMAGES_UNSUPPORTED', '当前模型未确认支持图片。');
      const attachments = (args.attachments ?? []).map(a => importFile(this.store, { name: a.name, mimeType: a.mimeType, dataBase64: a.dataBase64 }, this.config.limits));
      const user = { role: 'user', content: args.message, createdAt: new Date(this.now()).toISOString(), allowedScopes: scopes, attachments: attachments.map(fileSummary) };
      const runId = randomUUID();
      let row = this.store.put('chat', initial.id, { ...initial, status: 'RUNNING', runId, runExpiresAt: this.now() + this.config.pi.timeoutMs + 10000, messages: [...initial.messages, user], historyScopes: nextHistoryScopes, historyScopesPolicy: 'CONSERVATIVE_GRANTED_PRIVATE_SCOPES', lastError: null }, initial.revision);
      const checkRun = () => { const current = this.store.require('chat', initial.id); requireThat(current.status === 'RUNNING' && current.runId === runId, 'RUN_SUPERSEDED', '本轮会话已被恢复或替换，旧结果未写入。', 409); };
      const events = [];
      try {
        const result = await this.runner({ chatId: initial.id, scopes, messages: initial.piMessages, message: args.message, attachments, tools: this.modelTools(scopes, signal, checkRun, {chatId:initial.id,sourceMessage:args.message}), signal,
          onEvent: event => { events.push(event); this.store.append({ operation: 'pi.event', chatId: initial.id, runId, event }); } });
        checkRun();
        row = this.store.require('chat', initial.id);
        const answer = { role: 'assistant', content: result.answer, createdAt: new Date(this.now()).toISOString(), usage: result.usage };
        return safeChat(this.store.put('chat', initial.id, { ...row, status: 'IDLE', draft: null, nativeSession: result.nativeSession ?? null, messages: [...bindNativeUser(row.messages, result.nativeSession), answer], piMessages: result.messages, events: [...initial.events, ...events] }, row.revision));
      } catch (error) {
        row = this.store.require('chat', initial.id); const failure = errorBody(error);
        if (row.runId === runId && row.status === 'RUNNING') this.store.put('chat', row.id, { ...row, status: 'FAILED', lastError: failure, nativeSession: error.nativeSession ?? row.nativeSession ?? null, messages: bindNativeUser(row.messages, error.nativeSession), piMessages: error.messages ?? row.piMessages, events: [...initial.events, ...events] }, row.revision);
        throw error;
      }
    } finally { this.activeChats.delete(args.id); }
  }
  close() { this.closing = true; this.store.close(); }
}
