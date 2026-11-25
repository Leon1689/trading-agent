import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../../ledger/ledger.js';
import { TradingService } from '../service.js';
import { createHttpHandler } from '../integration.js';

function fixture(t, { request, config = {} } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'trading-http-'));
  const ledger = new Ledger(join(directory, 'legacy-ledger.sqlite'));
  const calls = [];
  const providers = {
    capabilities: () => ({ broker: { access: 'READ_ONLY', configured: true } }),
    request: async (operation, args, context) => {
      calls.push({ operation, args });
      if (request) return request(operation, args, context);
      return { mode: 'live', source: 'test-broker', data: [{ accountId: 'TEST' }] };
    },
  };
  const service = new TradingService({ path: join(directory, 'workbench.sqlite'), ledger, providers, config });
  t.after(() => { service.close(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  const handler = createHttpHandler(service);
  const post = (operation, args = {}) => handler(new Request('http://localhost/api/trading-workbench', { method: 'POST', body: JSON.stringify({ operation, args }) }));
  return { service, handler, post, ledger, calls };
}

test('HTTP bootstrap returns explicit capabilities and no credentials or private ledger state', async t => {
  const { handler, ledger, calls } = fixture(t, { config: { pi: { enabled: true, provider: 'private-provider', model: 'private-model', apiKeyEnv: 'PRIVATE_KEY_NAME' } } });
  const before = ledger.view();
  const response = await handler(new Request('http://localhost/api/trading-workbench'));
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.ok, true); assert.match(body.traceId, /^[a-f0-9-]{36}$/);
  assert.equal(body.data.capabilities.brokerAccess, 'READ_ONLY'); assert.equal(body.data.capabilities.liveTrading, false);
  assert.equal(body.data.capabilities.chat.images, false); assert.equal(body.data.capabilities.execution, 'READ_ONLY');
  assert.equal(JSON.stringify(body).includes('PRIVATE_KEY_NAME'), false); assert.equal(JSON.stringify(body).includes('private-model'), false);
  assert.deepEqual(ledger.view(), before); assert.equal(calls.length, 0);
});

test('HTTP pricing uses real quant units while legacy ledger remains unchanged', async t => {
  const { post, ledger, calls } = fixture(t); const before = ledger.view();
  const response = await post('quant.price', { model: 'BLACK_SCHOLES', right: 'CALL', spot: 100, strike: 100, timeYears: 30 / 365, rate: .05, dividendYield: 0, volatility: .2 });
  const body = await response.json(); assert.equal(response.status, 200); assert.equal(body.ok, true);
  assert.ok(Math.abs(body.data.price - 2.4933768194) < 1e-9); assert.equal(body.data.executableQuote, false);
  assert.equal(body.data.inputAuthority, 'USER_SUPPLIED_SCENARIO'); assert.match(body.data.units.vegaPerPercentagePoint, /0\.01/);
  const invalid = await post('quant.price', { model: 'BLACK_SCHOLES', right: 'CALL', spot: -1, strike: 100, timeYears: 1, rate: .05, dividendYield: 0, volatility: .2 });
  assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, 'INVALID_INPUT');
  assert.deepEqual(ledger.view(), before); assert.equal(calls.length, 0);
});

test('HTTP rejects actor promotion, extra fields, unknown broker writes and invalid protocol inputs', async t => {
  const { handler, post, calls } = fixture(t);
  const promoted = await handler(new Request('http://localhost/api/trading-workbench', { method: 'POST', body: JSON.stringify({ operation: 'broker.accounts', args: {}, actor: 'model', allowedScopes: ['broker'] }) }));
  assert.equal(promoted.status, 400); assert.equal((await promoted.json()).error.code, 'INVALID_REQUEST');
  const extra = await post('broker.accounts', { actor: 'human' }); assert.equal(extra.status, 400); assert.equal((await extra.json()).error.code, 'INVALID_INPUT');
  const unknown = await post('broker.submitOrder', { symbol: 'AAPL' }); assert.equal(unknown.status, 404); assert.equal((await unknown.json()).error.code, 'UNKNOWN_OPERATION');
  const malformed = await handler(new Request('http://localhost/api/trading-workbench', { method: 'POST', body: '{' })); assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error.code, 'INVALID_JSON');
  const method = await handler(new Request('http://localhost/api/trading-workbench', { method: 'DELETE' })); assert.equal(method.status, 405); assert.equal((await method.json()).error.code, 'METHOD_NOT_ALLOWED');
  assert.equal(calls.length, 0);
});

test('HTTP enforces declared and actual UTF-8 byte limits', async t => {
  const { handler } = fixture(t, { config: { limits: { requestBytes: 64 } } });
  const declared = await handler(new Request('http://localhost/api/trading-workbench', { method: 'POST', headers: { 'content-length': '1000' }, body: '{}' }));
  assert.equal(declared.status, 413); assert.equal((await declared.json()).error.code, 'BODY_TOO_LARGE');
  const body = JSON.stringify({ operation: 'chat.create', args: { title: '中'.repeat(15) } });
  assert.ok(body.length < 64); assert.ok(Buffer.byteLength(body) > 64);
  const actual = await handler(new Request('http://localhost/api/trading-workbench', { method: 'POST', body }));
  assert.equal(actual.status, 413); assert.equal((await actual.json()).error.code, 'BODY_TOO_LARGE');
});

test('HTTP provider exception and cancellation do not expose upstream secrets', async t => {
  const { post, handler } = fixture(t, { request: async () => { throw new Error('Bearer hidden-test-secret https://upstream.test?apikey=hidden-test-secret'); } });
  const response = await post('broker.accounts'); const body = await response.json();
  assert.equal(response.status, 500); assert.equal(body.error.code, 'OPERATION_FAILED'); assert.equal(JSON.stringify(body).includes('hidden-test-secret'), false);
  const controller = new AbortController(); controller.abort();
  const cancelled = await handler(new Request('http://localhost/api/trading-workbench', { method: 'POST', body: JSON.stringify({ operation: 'broker.accounts', args: {} }), signal: controller.signal }));
  assert.equal((await cancelled.json()).error.code, 'CANCELLED');
});

test('HTTP reads the actual original ledger; model tools never include confirmations or context promotion', async t => {
  const { service, post, ledger, calls } = fixture(t); const before = ledger.view();
  const read = await post('ledger.read'); assert.equal(read.status, 200); assert.deepEqual((await read.json()).data, before);
  const scopes = ['market', 'compute', 'predict', 'portfolio', 'files', 'ledger', 'broker'];
  const names = service.modelTools(scopes).map(tool => tool.name);
  for (const name of ['order_confirm', 'order_cancel', 'paper_create', 'paper_fill', 'chat_send', 'file_import', 'alerts_create']) assert.equal(names.includes(name), false, name);
  assert.ok(names.includes('order_preview')); assert.ok(names.includes('broker_accounts'));
  await assert.rejects(service.execute('order.confirm', { id: 'fake', confirmationToken: 'fake' }, { actor: 'model', allowedScopes: scopes }), error => error.code === 'HUMAN_REQUIRED');
  await assert.rejects(service.execute('broker.accounts', {}, { actor: 'model', allowedScopes: ['market'] }), error => error.code === 'SCOPE_DENIED');
  assert.equal(calls.length, 0); assert.deepEqual(ledger.view(), before);
  const result = await post('broker.accounts'); assert.equal(result.status, 200); assert.deepEqual(calls, [{ operation: 'broker.accounts', args: {} }]);
});
