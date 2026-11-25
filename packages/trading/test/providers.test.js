import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviders, ProviderError } from '../providers.js';

const limits = { minIntervalMs: 0, timeoutMs: 2000, maxBytes: 100000, maxItems: 100, maxPages: 3 };
const fmpConfig = { fmp: { apiKeyEnv: 'TEST_FMP_KEY' }, limits };
const response = value => Response.json(value);
const errorCode = code => error => error instanceof ProviderError && error.code === code;

test('unconfigured and mutation operations never reach the network', async () => {
  const p = createProviders({}, { fetchImpl: () => assert.fail('unexpected network') });
  await assert.rejects(p.request('market.quote', { symbol: 'AAPL' }), errorCode('UNCONFIGURED'));
  await assert.rejects(p.request('broker.submit', {}), errorCode('UNSUPPORTED'));
  await assert.rejects(p.request('predict.markets', { platform: 'kalshi' }), errorCode('UNCONFIGURED'));
  assert.equal(p.capabilities().every(row => row.access === 'READ_ONLY'), true);
});

test('FMP uses a fixed host and header credential; returns sourced decimal quote without secret fields', async () => {
  const calls = [];
  const p = createProviders(fmpConfig, { env: { TEST_FMP_KEY: 'private-test-key' }, fetchImpl: async (url, init) => {
    calls.push([url, init]); return response([{ symbol: 'AAPL', price: 100.25, timestamp: 1795255200, volume: 12, apiKey: 'private-test-key', note: 'echo private-test-key' }]);
  } });
  const value = await p.request('market.quote', { symbol: 'aapl', baseUrl: 'https://attacker.invalid', apiKey: 'ignored' });
  assert.equal(calls[0][0].origin, 'https://financialmodelingprep.com');
  assert.equal(calls[0][0].pathname, '/stable/quote');
  assert.equal(calls[0][1].headers.apikey, 'private-test-key');
  assert.equal(calls[0][1].method, 'GET'); assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][0].searchParams.get('apikey'), null);
  assert.equal(value.data[0].price, '100.25'); assert.equal(value.data[0].currency, null);
  assert.equal(value.asOf, '2026-11-21T10:00:00.000Z');
  assert.equal(JSON.stringify(value).includes('private-test-key'), false);
});

test('transport failures and entitlement bodies do not leak credentials', async () => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'ACCESS_DENIED'], [429, 'RATE_LIMITED']]) {
    const p = createProviders(fmpConfig, { env: { TEST_FMP_KEY: 'do-not-leak' }, fetchImpl: async () => new Response('do-not-leak', { status }) });
    await assert.rejects(p.request('market.quote', { symbol: 'AAPL' }), error => error.code === code && !JSON.stringify(error).includes('do-not-leak'));
  }
  const p = createProviders(fmpConfig, { env: { TEST_FMP_KEY: 'do-not-leak' }, fetchImpl: async () => { throw new Error('URL?apikey=do-not-leak'); } });
  await assert.rejects(p.request('market.quote', { symbol: 'AAPL' }), error => error.code === 'UPSTREAM_UNAVAILABLE' && !error.message.includes('do-not-leak'));
});

test('validation rejects malformed calendar dates and symbols before the request', async () => {
  const p = createProviders(fmpConfig, { env: { TEST_FMP_KEY: 'key' }, fetchImpl: () => assert.fail('unexpected network') });
  await assert.rejects(p.request('market.quote', { symbol: '../orders' }), errorCode('INVALID_INPUT'));
  await assert.rejects(p.request('market.history', { symbol: 'AAPL', from: '2026-02-30', to: '2026-04-01' }), errorCode('INVALID_INPUT'));
  await assert.rejects(p.request('market.earnings', { from: '2026-04-01', to: '2026-03-01' }), errorCode('INVALID_INPUT'));
  await assert.rejects(p.request('market.news', { limit: 101 }), errorCode('INVALID_INPUT'));
});

test('dividend-adjusted history is sorted and never substitutes unadjusted close', async () => {
  let data = [{ date: '2026-01-05', adjClose: 102 }, { date: '2026-01-02', adjClose: 100 }];
  const p = createProviders(fmpConfig, { env: { TEST_FMP_KEY: 'key' }, fetchImpl: async url => {
    assert.equal(url.pathname, '/stable/historical-price-eod/dividend-adjusted'); return response(data);
  } });
  const args = { symbol: 'SPY', from: '2026-01-01', to: '2026-01-10' };
  const history = await p.request('market.history', args);
  assert.deepEqual(history.data.map(row => row.adjustedClose), ['100', '102']);
  assert.equal(history.priceBasis, 'split_and_dividend_adjusted_eod');
  data = [{ date: '2026-01-02', close: 100 }];
  await assert.rejects(p.request('market.history', args), errorCode('UPSTREAM_SCHEMA'));
  data = [{ date: '2026-01-02', adjClose: 100 }, { date: '2026-01-02', adjClose: 101 }];
  await assert.rejects(p.request('market.history', args), errorCode('UPSTREAM_SCHEMA'));
});

test('limits are surfaced as incomplete rather than silently declaring full coverage', async () => {
  const p = createProviders({ ...fmpConfig, limits: { ...limits, maxItems: 2 } }, { env: { TEST_FMP_KEY: 'key' }, fetchImpl: async () => response([{ symbol: 'A' }, { symbol: 'B' }, { symbol: 'C' }]) });
  const data = await p.request('market.screen', { category: 'gainers', limit: 2 });
  assert.equal(data.complete, false); assert.equal(data.data.length, 2); assert.ok(data.missing.includes('response_truncated_to_configured_limit'));
});

test('body and JSON shape bounds reject oversized or non-JSON upstream replies', async () => {
  for (const [value, code] of [[new Response('x'.repeat(1000)), 'RESPONSE_TOO_LARGE'], [new Response('not json'), 'UPSTREAM_SCHEMA'], [response({ error: 'private detail' }), 'UPSTREAM_REJECTED']]) {
    const p = createProviders({ ...fmpConfig, limits: { ...limits, maxBytes: 256 } }, { env: { TEST_FMP_KEY: 'key' }, fetchImpl: async () => value });
    await assert.rejects(p.request('market.quote', { symbol: 'AAPL' }), errorCode(code));
  }
});

test('cancelled and timed out transport calls report their own outcome', async () => {
  const p = createProviders({ ...fmpConfig, limits: { ...limits, timeoutMs: 10 } }, { env: { TEST_FMP_KEY: 'key' }, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(p.request('market.quote', { symbol: 'AAPL' }), errorCode('TIMEOUT'));
  const abort = new AbortController();
  const job = p.request('market.quote', { symbol: 'AAPL' }, { signal: abort.signal }); abort.abort();
  await assert.rejects(job, errorCode('ABORTED'));
});

test('Alpaca option snapshots retain native Greeks and never invent contract multipliers', async () => {
  const config = { alpaca: { keyEnv: 'OPTION_KEY', secretEnv: 'OPTION_SECRET', feed: 'indicative' }, limits };
  const p = createProviders(config, { env: { OPTION_KEY: 'key', OPTION_SECRET: 'secret' }, fetchImpl: async (url, init) => {
    assert.equal(url.hostname, 'data.alpaca.markets'); assert.equal(url.searchParams.get('type'), 'call');
    assert.equal(init.headers['APCA-API-SECRET-KEY'], 'secret');
    return response({ snapshots: { AAPL261224C00370000: { impliedVolatility: .2, greeks: { delta: .3 }, latestQuote: { bp: 1.92, ap: 2.85, t: '2026-11-21T20:00:00Z' } } }, next_page_token: 'next' });
  } });
  const value = await p.request('market.options', { symbol: 'AAPL', right: 'CALL', from: '2026-12-20', to: '2027-01-20' });
  assert.equal(value.data[0].strike, '370'); assert.equal(value.data[0].expiration, '2026-12-24');
  assert.equal(value.data[0].greeks.delta, '0.3'); assert.equal(value.data[0].greeks.theta, null);
  assert.equal(value.data[0].multiplier, null); assert.equal(value.mode, 'delayed'); assert.equal(value.complete, false); assert.equal(value.nextCursor, 'next');
});

test('IBKR account scope is checked before any network request and gateway is loopback-only', async () => {
  assert.throws(() => createProviders({ ibkr: { baseUrl: 'https://attacker.invalid/v1/api', accountIds: ['DU1'] } }), errorCode('INVALID_CONFIG'));
  assert.throws(() => createProviders({ ibkr: { baseUrl: 'https://localhost:5000/v1/api', accountIds: [] } }), errorCode('INVALID_CONFIG'));
  const p = createProviders({ ibkr: { baseUrl: 'https://localhost:5000/v1/api', accountIds: ['DU1'] }, limits }, { fetchImpl: () => assert.fail('unexpected network') });
  await assert.rejects(p.request('broker.snapshot', { accountId: 'DU2' }), errorCode('ACCOUNT_SCOPE'));
});

test('IBKR snapshot paginates positions, filters unrelated activity and separates cash from BASE translation', async () => {
  const calls = [];
  const p = createProviders({ ibkr: { baseUrl: 'https://localhost:5000/v1/api', accountIds: ['DU1'] }, limits: { ...limits, maxItems: 200 } }, { fetchImpl: async (url, init) => {
    calls.push(url.pathname); assert.equal(init.method, 'GET');
    if (url.pathname.endsWith('/accounts')) return response([{ id: 'DU1', currency: 'USD' }, { id: 'DU2', currency: 'USD' }]);
    if (url.pathname.endsWith('/summary')) return response({ netliquidation: { amount: 20000, currency: 'USD' } });
    if (url.pathname.endsWith('/ledger')) return response({ USD: { cashbalance: 10000, settledcash: 9000, currency: 'USD' }, BASE: { cashbalance: 10000, currency: 'BASE' } });
    if (url.pathname.endsWith('/positions/0')) return response(Array.from({ length: 100 }, (_, i) => ({ acctId: 'DU1', conid: i, position: 2, currency: 'USD' })));
    if (url.pathname.endsWith('/positions/1')) return response([{ acctId: 'DU1', conid: 100, position: 3, avgCost: 50 }]);
    if (url.pathname.endsWith('/orders')) return response({ snapshot: true, orders: [{ account: 'DU1', orderId: 1 }, { account: 'DU2', orderId: 2 }] });
    if (url.pathname.endsWith('/trades')) return response([{ account: 'DU1', execution_id: 'e1', order_ref: 'synthetic-ref', price: '2.5', size: 1 }, { account: 'DU2', execution_id: 'e2', price: '4', size: 1 }]);
    assert.fail(url.pathname);
  } });
  const result = await p.request('broker.snapshot', { accountId: 'DU1' });
  assert.equal(result.data.positions.length, 101); assert.equal(result.data.coverage.positionsComplete, true);
  assert.equal(result.data.cash.length, 1); assert.equal(result.data.cash[0].settledCash, '9000');
  assert.equal(result.data.orders.length, 1); assert.equal(result.data.executions.length, 1); assert.equal(result.data.executions[0].accountId, 'DU1'); assert.equal(result.data.executions[0].orderRef, 'synthetic-ref');
  assert.equal(result.data.coverage.historicalLedgerComplete, false); assert.equal(result.complete, false);
  assert.equal(result.asOf, null); assert.equal(calls.length, 7);
});

test('IBKR unavailable orders or executions are unknown, never empty success', async () => {
  const p = createProviders({ ibkr: { baseUrl: 'https://localhost:5000/v1/api', accountIds: ['DU1'] }, limits }, { fetchImpl: async url => {
    if (url.pathname.endsWith('/accounts')) return response([{ id: 'DU1' }]);
    if (url.pathname.endsWith('/summary') || url.pathname.endsWith('/ledger')) return response({});
    if (url.pathname.includes('/positions/')) return response([]);
    return new Response('', { status: 401 });
  } });
  const result = await p.request('broker.snapshot', { accountId: 'DU1' });
  assert.equal(result.data.orders, null); assert.equal(result.data.executions, null);
  assert.ok(result.missing.includes('orders_unavailable:AUTH_REQUIRED'));
  assert.ok(result.missing.includes('executions_unavailable:AUTH_REQUIRED'));
});

test('Kalshi uses dollar-denominated prices without converting them as cents', async () => {
  const p = createProviders({ predict: { enabled: true }, limits }, { fetchImpl: async url => {
    assert.equal(url.origin, 'https://external-api.kalshi.com');
    return response({ markets: [{ ticker: 'KXTEST', title: 'Test', yes_bid_dollars: '0.5600', yes_ask_dollars: '0.5800', last_price_dollars: '0.5700', volume_fp: '10.00', updated_time: '2026-11-21T10:00:00Z', rules_primary: 'Synthetic settle rule' }], cursor: 'more' });
  } });
  const result = await p.request('predict.markets', { platform: 'kalshi' });
  assert.equal(result.data[0].outcomes[0].bid, '0.5600'); assert.equal(result.data[0].outcomes[0].price, '0.5700');
  assert.ok(Math.abs(Number(result.data[0].spread) - .02) < 1e-10); assert.equal(result.complete, false);
});

test('Polymarket pairs serialized outcomes and rejects mismatched arrays', async () => {
  let data = [{ id: '123', question: 'Test', outcomes: '["Yes","No"]', outcomePrices: '["0.4","0.6"]', active: true, updatedAt: '2026-11-21T10:00:00Z' }];
  const p = createProviders({ predict: { enabled: true }, limits }, { fetchImpl: async () => response(data) });
  const result = await p.request('predict.markets', { platform: 'polymarket' });
  assert.deepEqual(result.data[0].outcomes.map(row => row.price), ['0.4', '0.6']);
  assert.equal(result.data[0].outcomes[0].bid, null);
  data = [{ outcomes: '["Yes","No"]', outcomePrices: '["0.4"]' }];
  await assert.rejects(p.request('predict.markets', { platform: 'polymarket' }), errorCode('UPSTREAM_SCHEMA'));
});

test('synthetic data requires explicit mode and fixture, does not fall back after a live failure', async () => {
  const p = createProviders({ mode: 'synthetic', fixtures: { 'market.quote': [{ symbol: 'TEST', price: '100' }] } }, { fetchImpl: () => assert.fail('unexpected network') });
  const result = await p.request('market.quote', { symbol: 'TEST' }); assert.equal(result.mode, 'synthetic');
  await assert.rejects(p.request('market.history', { symbol: 'TEST' }), errorCode('UNCONFIGURED'));
  const live = createProviders({ mode: 'live', fixtures: { 'market.quote': [] } }, { fetchImpl: () => assert.fail('unexpected network') });
  await assert.rejects(live.request('market.quote', { symbol: 'TEST' }), errorCode('UNCONFIGURED'));
});
