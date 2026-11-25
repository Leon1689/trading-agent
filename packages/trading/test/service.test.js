import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingService } from '../service.js';
import { TradingError } from '../errors.js';
import { createProviders } from '../providers.js';

const at = Date.parse('2026-11-21T10:00:00Z');
const limits = { minIntervalMs: 0, timeoutMs: 2000, maxBytes: 100000, maxItems: 5000, maxPages: 2 };
const providerConfig = { fmp: { apiKeyEnv: 'TEST_KEY' }, limits };
const pi = { enabled: true, provider: 'test', model: 'mock-model', apiKeyEnv: 'TEST_MODEL_KEY' };
const code = expected => error => error.code === expected;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function service(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'trading-service-'));
  const path = join(directory, 'state.sqlite');
  const value = new TradingService({ path, now: () => at, ...options });
  Object.defineProperty(value, 'testPath', { value: path });
  t.after(() => { if (!value.closing) value.close(); rmSync(directory, { recursive: true, force: true }); });
  return value;
}
function fmp(fetchImpl, config = providerConfig) { return createProviders(config, { env: { TEST_KEY: 'unit-test-only' }, fetchImpl }); }
const stockOrder = { symbol: 'AAPL', assetClass: 'STOCK', side: 'BUY', positionEffect: 'OPEN', quantity: 1, type: 'LIMIT', limitPrice: '10.00', currency: 'USD', timeInForce: 'DAY', session: 'REGULAR', estimatedFees: '0.00' };
const alertInput = { name: 'AAPL above 100', sourceOperation: 'market.quote', sourceArgs: { symbol: 'AAPL' }, field: 'data.0.price', comparator: 'gte', threshold: 100, intervalMs: 60000, maxAgeMs: 300000, once: false };
const backtestInput = { initialCapital: 1000, weights: { AAPL: 0.5, MSFT: 0.5 }, from: '2026-11-16', to: '2026-11-18', rebalance: 'NONE', costBps: 0, annualRiskFreeRate: 0, periodsPerYear: 252, benchmarkSymbol: 'SPY' };

test('model scopes deny broker access by default and cannot be promoted through arguments', async t => {
  let calls = 0;
  const providers = createProviders({ ibkr: { baseUrl: 'https://localhost:5000/v1/api', accountIds: ['DU1'] }, limits }, { fetchImpl: async () => { calls++; return Response.json([{ id: 'DU1' }, { id: 'DU2' }]); } });
  const s = service(t, { providers });
  await assert.rejects(s.execute('broker.accounts', {}, { actor: 'model' }), code('SCOPE_DENIED'));
  await assert.rejects(s.execute('broker.accounts', { allowedScopes: ['broker'] }, { actor: 'model' }), code('SCOPE_DENIED'));
  assert.equal(calls, 0);
  const allowed = await s.execute('broker.accounts', {}, { actor: 'model', allowedScopes: ['broker'] });
  assert.deepEqual(allowed.data.map(a => a.accountId), ['DU1']); assert.equal(calls, 1);
  assert.ok(!s.modelTools(['market', 'compute', 'predict']).some(tool => tool.name.startsWith('broker_')));
  assert.ok(s.modelTools(['broker']).some(tool => tool.name === 'broker_accounts'));
  assert.ok(!s.modelTools(['compute', 'portfolio']).some(tool => ['order_confirm', 'paper_fill', 'paper_create'].includes(tool.name)));
});

test('model order drafts omit confirmation credentials and default service never executes', async t => {
  const s = service(t);
  const preview = await s.execute('order.preview', stockOrder, { actor: 'model' });
  assert.equal(preview.confirmationToken, undefined); assert.equal(preview.executionEnabled, false);
  assert.equal(preview.requiresHumanConfirmation, true);
  await assert.rejects(s.execute('order.confirm', { id: preview.id, confirmationToken: 'pretend' }, { actor: 'model', allowedScopes: ['compute'] }), code('HUMAN_REQUIRED'));
  await assert.rejects(s.execute('paper.create', { name: 'no', initialCash: '1000.00', currency: 'USD' }), code('EXECUTION_DISABLED'));
  assert.equal(s.capabilities().liveTrading, false);
});

test('catalog inputs route through actual providers for screen, analysts, ratios and cursor filters', async t => {
  const calls = [];
  const s = service(t, { providers: fmp(async url => { calls.push(url); return Response.json([{ symbol: 'AAPL' }]); }) });
  await s.execute('market.screen', { category: 'filter', sector: 'Technology', marketCapMoreThan: 1000, limit: 3 });
  await s.execute('market.analysts', { symbol: 'AAPL', kind: 'estimates', period: 'quarter', limit: 2 });
  await s.execute('market.financials', { symbol: 'AAPL', statement: 'ratios' });
  assert.equal(calls[0].pathname, '/stable/company-screener'); assert.equal(calls[0].searchParams.get('sector'), 'Technology');
  assert.equal(calls[1].pathname, '/stable/analyst-estimates'); assert.equal(calls[1].searchParams.get('period'), 'quarter');
  assert.equal(calls[2].pathname, '/stable/ratios');
  await assert.rejects(s.execute('market.screen', { kind: 'gainers' }), code('INVALID_INPUT'));
  await assert.rejects(s.execute('predict.markets', { platform: 'polymarket', query: 'unsupported search' }), code('INVALID_INPUT'));
});

test('broker snapshot is saved as incomplete evidence without touching the strategy ledger', async t => {
  let ledgerCalls = 0;
  const providers = createProviders({ ibkr: { baseUrl: 'https://localhost:5000/v1/api', accountIds: ['DU1'] }, limits }, { fetchImpl: async url => {
    if (url.pathname.endsWith('/accounts')) return Response.json([{ id: 'DU1' }]);
    if (url.pathname.endsWith('/summary')) return Response.json({ netliquidation: { amount: 1000, currency: 'USD' } });
    if (url.pathname.endsWith('/ledger')) return Response.json({ USD: { settledcash: 1000, cashbalance: 1000, currency: 'USD' } });
    if (url.pathname.endsWith('/positions/0')) return Response.json([]);
    if (url.pathname.endsWith('/orders')) return Response.json({ orders: [], snapshot: true });
    if (url.pathname.endsWith('/trades')) return Response.json([]);
    assert.fail(url.pathname);
  } });
  const s = service(t, { providers, ledger: { change: () => { ledgerCalls++; }, view: () => { ledgerCalls++; } } });
  const snapshot = await s.execute('broker.snapshot', { accountId: 'DU1' });
  assert.equal(snapshot.immutable, true); assert.equal(snapshot.quality.complete, false);
  assert.equal(snapshot.inputAuthority, 'BROKER_REPORTED'); assert.equal(snapshot.strategyLedgerUpdated, false);
  assert.equal(snapshot.asOf, null); assert.equal(snapshot.data.cash[0].settledCash, '1000'); assert.equal(ledgerCalls, 0);
  assert.deepEqual(await s.execute('snapshot.get', { id: snapshot.id }), snapshot);
  assert.equal((await s.execute('snapshot.list'))[0].data, undefined);
});

test('explicit synthetic broker fixtures never acquire broker-reported authority when persisted', async t => {
  const providers = createProviders({ mode: 'synthetic', fixtures: { 'broker.snapshot': { accountId: 'TEST', positions: [], cash: [] } } });
  const s = service(t, { providers });
  const result = await s.execute('broker.snapshot', { accountId: 'TEST' });
  assert.equal(result.mode, 'synthetic'); assert.equal(result.source, 'explicit_fixture');
  assert.equal(result.inputAuthority, 'SYNTHETIC_FIXTURE'); assert.equal(result.strategyLedgerUpdated, false);
  assert.equal((await s.execute('snapshot.get', { id: result.id })).inputAuthority, 'SYNTHETIC_FIXTURE');
});

test('CSV import/export preserves bytes and de-duplicates +140 cash flow without ledger mutation', async t => {
  const s = service(t, { ledger: { change: () => assert.fail('must not write ledger') } });
  const content = '\uFEFFevent_id,currency,amount,note\r\ne1,USD,200.00,"premium, collected"\r\ne2,USD,-50.00,"close\nfee"\r\ne3,USD,-10.00,tax\r\ne1,USD,200.00,"premium, collected"\r\n';
  const file = await s.execute('file.import', { name: 'events.csv', content });
  const check = await s.execute('file.inspectEvents', { id: file.id });
  assert.deepEqual(check.totals, { USD: '140.00' }); assert.equal(check.uniqueEvents, 3); assert.equal(check.duplicates, 1); assert.equal(check.ledgerUpdated, false);
  const exported = await s.execute('file.export', { id: file.id });
  assert.equal(exported.content, content); assert.equal(exported.checksum, file.checksum);
  const listed = await s.execute('file.list'); assert.equal(listed[0].content, undefined); assert.equal(listed[0].parsed, undefined);
  const conflict = await s.execute('file.import', { name: 'bad.csv', content: 'event_id,currency,amount\na,USD,1.00\na,USD,2.00\n' });
  await assert.rejects(s.execute('file.inspectEvents', { id: conflict.id }), code('EVENT_CONFLICT'));
  await assert.rejects(s.execute('file.import', { name: '../bad.csv', content }), code('INVALID_NAME'));
});

test('chat persists messages, scoped tool execution and internal conversation across reopen', async t => {
  let received;
  const runner = async input => {
    received = input; assert.equal(input.tools.some(tool => tool.name === 'broker_accounts'), false);
    input.onEvent({ type: 'tool_start', name: 'market_quote' });
    const value = await input.tools.find(tool => tool.name === 'market_quote').execute('call-1', { symbol: 'AAPL' });
    assert.equal(value.details.data[0].price, '101');
    return { answer: 'AAPL quote: 101, FMP delayed.', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'internal text' }] }], usage: { input: 10, output: 9 } };
  };
  const s = service(t, { config: { pi }, runner, providers: fmp(async () => Response.json([{ symbol: 'AAPL', price: 101, timestamp: at / 1000 }])) });
  const created = await s.execute('chat.create', { title: 'AAPL research' });
  const answered = await s.execute('chat.send', { id: created.id, message: 'Read AAPL' });
  assert.equal(answered.status, 'IDLE'); assert.deepEqual(answered.messages.map(m => m.role), ['user', 'assistant']);
  assert.deepEqual(answered.messages[0].allowedScopes, ['market', 'compute', 'predict']);
  assert.equal(answered.piMessages, undefined); assert.equal(answered.events, undefined); assert.equal(received.message, 'Read AAPL');
  assert.ok(s.store.events().some(event => event.operation === 'pi.event'));
  const file = await s.execute('chat.export', { id: created.id }); assert.match(file.content, /AAPL quote: 101/);
  const filePath = s.testPath; s.close();
  const reopened = new TradingService({ path: filePath });
  try { const persisted = await reopened.execute('chat.get', { id: created.id }); assert.deepEqual(persisted.messages, answered.messages); assert.equal(reopened.store.require('chat', created.id).piMessages.length, 1); }
  finally { reopened.close(); }
});

test('chat failure keeps the user turn, reports FAILED and permits an explicit retry', async t => {
  let attempt = 0;
  const s = service(t, { config: { pi }, runner: async ({ onEvent }) => { onEvent({ type: 'model_start' }); if (++attempt === 1) throw new TradingError('MODEL_UNAVAILABLE', 'Test model unavailable', 503); return { answer: 'Recovered', messages: [], usage: {} }; } });
  const chat = await s.execute('chat.create');
  await assert.rejects(s.execute('chat.send', { id: chat.id, message: 'First request' }), code('MODEL_UNAVAILABLE'));
  const failed = await s.execute('chat.get', { id: chat.id });
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.lastError.code, 'MODEL_UNAVAILABLE'); assert.equal(failed.messages.length, 1); assert.equal(failed.messages[0].role, 'user');
  const retry = await s.execute('chat.send', { id: chat.id, message: 'Retry' });
  assert.equal(retry.status, 'IDLE'); assert.equal(retry.lastError, null); assert.deepEqual(retry.messages.map(m => m.role), ['user', 'user', 'assistant']);
});

test('private history scopes must be reauthorized before the full transcript is resent', async t => {
  const received = [];
  const history = [{ role: 'user', content: 'Previously authorized private evidence', timestamp: 1 }, { role: 'assistant', content: [{ type: 'text', text: 'Private account conclusion' }], timestamp: 2 }];
  const s = service(t, { config: { pi }, runner: async input => { received.push(input); return { answer: 'Research saved.', messages: history, usage: {} }; } });
  const created = await s.execute('chat.create');
  const first = await s.execute('chat.send', { id: created.id, message: 'Account research', allowedScopes: ['broker', 'compute'] });
  assert.deepEqual(first.historyScopes, ['broker']); assert.equal(first.historyScopesPolicy, 'CONSERVATIVE_GRANTED_PRIVATE_SCOPES');
  const before = s.store.require('chat', first.id);
  await assert.rejects(s.execute('chat.send', { id: first.id, message: 'Continue with defaults' }), error => {
    assert.equal(error.code, 'HISTORY_SCOPE_REQUIRED'); assert.equal(error.status, 403); assert.deepEqual(error.details, { requiredScopes: ['broker'], missingScopes: ['broker'] }); return true;
  });
  assert.equal(received.length, 1); assert.deepEqual(s.store.require('chat', first.id), before);
  const second = await s.execute('chat.send', { id: first.id, message: 'Explicitly authorize history', allowedScopes: ['broker', 'portfolio'] });
  assert.deepEqual(received[1].messages, history); assert.deepEqual(second.historyScopes, ['broker', 'portfolio']);
  await assert.rejects(s.execute('chat.send', { id: first.id, message: 'Drop just the portfolio scope', allowedScopes: ['broker'] }), error => error.code === 'HISTORY_SCOPE_REQUIRED' && error.details.missingScopes[0] === 'portfolio');
  assert.equal(received.length, 2);
});

test('older chats derive private history requirements from all persisted user grants', async t => {
  let calls = 0;
  const s = service(t, { config: { pi }, runner: async () => { calls++; return { answer: 'Continued', messages: [], usage: {} }; } });
  const chat = await s.execute('chat.create');
  const legacy = s.store.put('chat', chat.id, { ...chat, historyScopes: [], messages: [
    { role: 'user', content: 'Earlier files', allowedScopes: ['files', 'ledger'] },
    { role: 'assistant', content: 'Earlier answer' },
    { role: 'user', content: 'Earlier saved portfolios', allowedScopes: ['portfolio'] },
  ], piMessages: [{ role: 'user', content: 'Complete earlier evidence', timestamp: 1 }] }, chat.revision);
  await assert.rejects(s.execute('chat.send', { id: chat.id, message: 'New question', allowedScopes: ['files', 'ledger'] }), error => {
    assert.equal(error.code, 'HISTORY_SCOPE_REQUIRED'); assert.deepEqual(error.details.requiredScopes, ['files', 'ledger', 'portfolio']); assert.deepEqual(error.details.missingScopes, ['portfolio']); return true;
  });
  assert.equal(calls, 0); assert.deepEqual(s.store.require('chat', chat.id), legacy);
  const out = await s.execute('chat.send', { id: chat.id, message: 'All required history scopes selected', allowedScopes: ['files', 'ledger', 'portfolio'] });
  assert.deepEqual(out.historyScopes, ['files', 'ledger', 'portfolio']); assert.equal(calls, 1);
});

test('failed private turns retain conservative grants while a fresh conversation starts with no private history', async t => {
  let calls = 0;
  const s = service(t, { config: { pi }, runner: async () => { calls++; throw new TradingError('MODEL_UNAVAILABLE', 'Unavailable fixture provider', 503); } });
  const chat = await s.execute('chat.create');
  await assert.rejects(s.execute('chat.send', { id: chat.id, message: 'Research files', allowedScopes: ['files'] }), code('MODEL_UNAVAILABLE'));
  assert.deepEqual(s.store.require('chat', chat.id).historyScopes, ['files']);
  await assert.rejects(s.execute('chat.send', { id: chat.id, message: 'Retry without files' }), code('HISTORY_SCOPE_REQUIRED')); assert.equal(calls, 1);
  const fresh = await s.execute('chat.create');
  await assert.rejects(s.execute('chat.send', { id: fresh.id, message: 'Fresh public research' }), code('MODEL_UNAVAILABLE')); assert.equal(calls, 2);
  assert.deepEqual(s.store.require('chat', fresh.id).historyScopes, []);
});

test('one running chat rejects concurrent send/update and cancellation persists no invented answer', async t => {
  const started = deferred(), finish = deferred();
  const s = service(t, { config: { pi }, runner: async ({ signal }) => { started.resolve(); await finish.promise; signal.throwIfAborted(); return { answer: 'never', messages: [], usage: {} }; } });
  const chat = await s.execute('chat.create'); const controller = new AbortController();
  const sending = s.execute('chat.send', { id: chat.id, message: 'Wait' }, { signal: controller.signal });
  await started.promise;
  await assert.rejects(s.execute('chat.send', { id: chat.id, message: 'Second' }), code('CHAT_BUSY'));
  await assert.rejects(s.execute('chat.update', { id: chat.id, title: 'Changed' }), code('CHAT_BUSY'));
  controller.abort(); finish.resolve(); await assert.rejects(sending, error => error.name === 'AbortError');
  const final = await s.execute('chat.get', { id: chat.id });
  assert.equal(final.status, 'FAILED'); assert.equal(final.lastError.code, 'CANCELLED'); assert.equal(final.messages.length, 1);
});

test('persisted RUNNING lease blocks a second instance and human recovery requires expiry', async t => {
  const started = deferred(), finish = deferred(); let now = at;
  const s = service(t, { now: () => now, config: { pi }, runner: async () => { started.resolve(); await finish.promise; return { answer: 'Owner result', messages: [], usage: {} }; } });
  const chat = await s.execute('chat.create');
  const running = s.execute('chat.send', { id: chat.id, message: 'Owner turn' }); await started.promise;
  const sibling = new TradingService({ path: s.testPath, now: () => now, config: { pi }, runner: async () => assert.fail('sibling must not start') });
  try {
    const row = await sibling.execute('chat.get', { id: chat.id });
    assert.equal(row.status, 'RUNNING'); assert.ok(row.runExpiresAt > now);
    await assert.rejects(sibling.execute('chat.send', { id: chat.id, message: 'Concurrent turn' }), code('CHAT_BUSY'));
    await assert.rejects(sibling.execute('chat.update', { id: chat.id, title: 'Concurrent rename' }), code('CHAT_BUSY'));
    await assert.rejects(sibling.execute('chat.recover', { id: chat.id, revision: row.revision }), code('CHAT_BUSY'));
    await assert.rejects(sibling.execute('chat.recover', { id: chat.id, revision: row.revision }, { actor: 'model', allowedScopes: ['portfolio'] }), code('HUMAN_REQUIRED'));
    now = row.runExpiresAt + 1;
    await assert.rejects(s.execute('chat.recover', { id: chat.id, revision: row.revision }), code('CHAT_BUSY'));
  } finally { finish.resolve(); await running; sibling.close(); }
});

test('recovered expired chat survives a late answer from its previous process', async t => {
  const started = deferred(), finish = deferred(); let now = at;
  const s = service(t, { now: () => now, config: { pi }, runner: async () => { started.resolve(); await finish.promise; return { answer: 'Obsolete result', messages: [], usage: {} }; } });
  const chat = await s.execute('chat.create');
  const running = s.execute('chat.send', { id: chat.id, message: 'Old interrupted turn' }); await started.promise;
  const sibling = new TradingService({ path: s.testPath, now: () => now, config: { pi }, runner: async () => ({ answer: 'New result', messages: [], usage: {} }) });
  try {
    const row = await sibling.execute('chat.get', { id: chat.id }); now = row.runExpiresAt + 1;
    await assert.rejects(sibling.execute('chat.recover', { id: chat.id, revision: row.revision - 1 }), code('VERSION_CONFLICT'));
    const recovered = await sibling.execute('chat.recover', { id: chat.id, revision: row.revision });
    assert.equal(recovered.status, 'FAILED'); assert.equal(recovered.lastError.code, 'INTERRUPTED'); assert.equal(recovered.messages.length, 1);
    const fresh = await sibling.execute('chat.send', { id: chat.id, message: 'New turn' });
    assert.equal(fresh.messages.at(-1).content, 'New result');
    finish.resolve(); await assert.rejects(running, code('RUN_SUPERSEDED'));
    const current = await sibling.execute('chat.get', { id: chat.id });
    assert.equal(current.status, 'IDLE'); assert.equal(current.revision, fresh.revision);
    assert.equal(current.messages.at(-1).content, 'New result'); assert.equal(current.messages.some(m => m.content === 'Obsolete result'), false);
  } finally { finish.resolve(); await running.catch(() => {}); sibling.close(); }
});

test('alerts notify only on threshold transition and pause prevents a data request', async t => {
  let price = 110, calls = 0;
  const s = service(t, { providers: fmp(async () => { calls++; return Response.json([{ symbol: 'AAPL', price, timestamp: at / 1000 }]); }) });
  const a = await s.execute('alerts.create', alertInput);
  assert.ok((await s.execute('alerts.evaluate', { id: a.id })).notification);
  assert.equal((await s.execute('alerts.evaluate', { id: a.id })).notification, null);
  price = 99; assert.equal((await s.execute('alerts.evaluate', { id: a.id })).matched, false);
  price = 105; const again = await s.execute('alerts.evaluate', { id: a.id }); assert.ok(again.notification);
  assert.equal((await s.execute('notifications.list')).length, 2);
  await s.execute('alerts.update', { id: a.id, revision: again.alert.revision, enabled: false });
  assert.equal((await s.execute('alerts.evaluate', { id: a.id })).skipped, 'PAUSED'); assert.equal(calls, 4);
  const read = await s.execute('notifications.read', { id: again.notification.id, revision: again.notification.revision }); assert.equal(read.read, true);
});

test('alert results arriving after pause are discarded; cancellation does not change condition state', async t => {
  let started = deferred(), finish = deferred();
  const s = service(t, { providers: fmp(async () => { started.resolve(); await finish.promise; return Response.json([{ symbol: 'AAPL', price: 110, timestamp: at / 1000 }]); }) });
  const a = await s.execute('alerts.create', alertInput);
  const checking = s.execute('alerts.evaluate', { id: a.id }); await started.promise;
  const paused = await s.execute('alerts.update', { id: a.id, revision: a.revision, enabled: false });
  finish.resolve(); await assert.rejects(checking, code('VERSION_CONFLICT'));
  assert.equal((await s.execute('notifications.list')).length, 0); assert.equal(s.store.require('alert', a.id).revision, paused.revision);
  const active = await s.execute('alerts.update', { id: a.id, revision: paused.revision, enabled: true });
  started = deferred(); finish = deferred(); const controller = new AbortController();
  const cancelled = s.execute('alerts.evaluate', { id: a.id }, { signal: controller.signal }); await started.promise;
  controller.abort(); finish.resolve(); await assert.rejects(cancelled, error => ['ABORTED', 20].includes(error.code) || error.name === 'AbortError');
  assert.equal(s.store.require('alert', a.id).revision, active.revision); assert.equal((await s.execute('notifications.list')).length, 0);
});

test('stale, unknown and future timestamps cannot trigger an alert or reset its last condition', async t => {
  let timestamp = (at - 3600000) / 1000;
  const s = service(t, { providers: fmp(async () => Response.json([{ symbol: 'AAPL', price: 110, timestamp }])) });
  const a = await s.execute('alerts.create', alertInput);
  for (const value of [timestamp, null, (at + 60000) / 1000]) {
    timestamp = value;
    await assert.rejects(s.execute('alerts.evaluate', { id: a.id }), code('STALE_ALERT_DATA'));
    const row = s.store.require('alert', a.id);
    assert.equal(row.previousMatched, false); assert.equal(row.lastError.code, 'STALE_ALERT_DATA');
    assert.equal((await s.execute('notifications.list')).length, 0);
  }
  timestamp = at / 1000;
  assert.ok((await s.execute('alerts.evaluate', { id: a.id })).notification);
});

test('scheduler selects due enabled alerts before applying its batch limit', async t => {
  let calls = 0;
  const s = service(t, { config: { limits: { listLimit: 2 } }, providers: fmp(async () => { calls++; return Response.json([{ symbol: 'AAPL', price: 110, timestamp: at / 1000 }]); }) });
  const due = [];
  for (let i = 0; i < 5; i++) due.push(await s.execute('alerts.create', { ...alertInput, name: `due-${i}` }));
  for (let i = 0; i < 6; i++) {
    const row = await s.execute('alerts.create', { ...alertInput, name: `paused-${i}` });
    await s.execute('alerts.update', { id: row.id, revision: row.revision, enabled: false });
  }
  assert.equal((await s.tick()).length, 2);
  assert.equal((await s.tick()).length, 2);
  assert.equal((await s.tick()).length, 1);
  assert.equal((await s.tick()).length, 0);
  assert.equal(calls, 5);
  assert.ok(due.every(row => s.store.require('alert', row.id).lastCheckedAt));
});

test('portfolio revisions prevent overwrites and real history backtests retain exact provider provenance', async t => {
  const requests = [];
  const s = service(t, { config: { providers: providerConfig }, providers: fmp(async url => {
    requests.push(url); const symbol = url.searchParams.get('symbol');
    return Response.json([{ date: '2026-11-18', adjClose: symbol === 'AAPL' ? 120 : 100 }, { date: '2026-11-16', adjClose: 100 }, { date: '2026-11-17', adjClose: 100 }]);
  }) });
  const p = await s.execute('portfolio.save', { name: 'Balanced', weights: backtestInput.weights });
  const updated = await s.execute('portfolio.save', { id: p.id, revision: p.revision, name: 'Updated', weights: p.weights });
  await assert.rejects(s.execute('portfolio.save', { id: p.id, revision: p.revision, name: 'Stale', weights: p.weights }), code('VERSION_CONFLICT'));
  assert.equal((await s.execute('portfolio.get', { id: p.id })).revision, updated.revision);
  const result = await s.execute('portfolio.backtestLive', backtestInput);
  assert.equal(requests.length, 3); assert.ok(requests.every(url => url.pathname === '/stable/historical-price-eod/dividend-adjusted'));
  assert.ok(Math.abs(result.metrics.finalValue - 1100) < 1e-9); assert.equal(result.benchmark.metrics.finalValue, 1000);
  assert.deepEqual(result.sources.map(row => row.symbol), ['AAPL', 'MSFT', 'SPY']);
  assert.ok(result.sources.every(row => row.source === 'fmp' && row.asOf === null && row.priceBasis === 'split_and_dividend_adjusted_eod'));
  assert.equal(result.executed, true); assert.equal(result.orderSubmissionEnabled, false);
  assert.deepEqual(s.store.require('backtest', result.id), result);
});

test('live backtests reject synthetic or truncated data and never persist a fabricated result', async t => {
  const history = [{ date: '2026-11-16', adjClose: 100 }, { date: '2026-11-17', adjClose: 110 }, { date: '2026-11-18', adjClose: 120 }];
  const config = { ...providerConfig, limits: { ...limits, maxItems: 2 } };
  const s = service(t, { config: { providers: config }, providers: fmp(async () => Response.json(history), config) });
  await assert.rejects(s.execute('portfolio.backtestLive', backtestInput), code('INCOMPLETE_HISTORY'));
  assert.equal(s.store.list('backtest').length, 0);
  const synthetic = service(t, { providers: createProviders({ mode: 'synthetic', fixtures: { 'market.history': history.map(row => ({ date: row.date, adjustedClose: row.adjClose })) } }) });
  await assert.rejects(synthetic.execute('portfolio.backtestLive', backtestInput), code('INSUFFICIENT_HISTORY'));
  assert.equal(synthetic.store.list('backtest').length, 0);
});

test('live backtests refuse cross-asset missing sessions instead of forward filling prices', async t => {
  const s = service(t, { config: { providers: providerConfig }, providers: fmp(async url => Response.json(url.searchParams.get('symbol') === 'MSFT'
    ? [{ date: '2026-11-16', adjClose: 100 }, { date: '2026-11-18', adjClose: 100 }]
    : [{ date: '2026-11-16', adjClose: 100 }, { date: '2026-11-17', adjClose: 100 }, { date: '2026-11-18', adjClose: 100 }])) });
  await assert.rejects(s.execute('portfolio.backtestLive', backtestInput), code('INVALID_HISTORY'));
  assert.equal(s.store.list('backtest').length, 0);
});
