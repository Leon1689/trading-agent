import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingStore } from '../storage.js';
import { PaperExecution } from '../paper.js';
import { resolveConfig } from '../config.js';

const at = Date.parse('2026-11-21T15:00:00Z');
const code = expected => error => error.code === expected;
const base = { symbol: 'AAPL', assetClass: 'STOCK', side: 'BUY', positionEffect: 'OPEN', quantity: 100, type: 'LIMIT', limitPrice: '10.00', currency: 'USD', timeInForce: 'GTC', session: 'REGULAR', estimatedFees: '0.00' };
const contract = { right: 'CALL', underlying: 'AAPL', multiplier: 100, strike: '20.00', expiration: '2026-12-18', standardDeliverableVerified: true };
function setup(t, cash = '10000.00') {
  const dir = mkdtempSync(join(tmpdir(), 'paper-ledger-'));
  const store = new TradingStore(join(dir, 'state.sqlite'));
  let time = at;
  const paper = new PaperExecution(store, resolveConfig({ execution: { mode: 'LOCAL_PAPER' } }), () => time);
  const account = paper.createAccount({ name: 'Test only', initialCash: cash, currency: 'USD' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const order = (patch = {}) => paper.preview({ ...base, accountId: account.id, ...patch });
  const accept = (patch = {}) => { const draft = order(patch); paper.confirm(draft); return store.require('order', draft.id); };
  const fill = (row, patch = {}) => paper.fill({ id: row.id, revision: row.revision, quantity: row.remainingQuantity, price: row.order.limitPrice, fee: '0.00', eventId: `event-${row.id}`, ...patch });
  return { paper, store, account, order, accept, fill, advance: ms => { time += ms; } };
}

test('stock fills debit actual cash, partial fills preserve reservation and event IDs are idempotent', t => {
  const { paper, store, account, accept, fill } = setup(t, '1001.00');
  const open = accept({ estimatedFees: '1.00' });
  const first = fill(open, { quantity: 40, fee: '0.40', eventId: 'partial-1' });
  assert.equal(paper.account(account.id).cash, '600.60'); assert.equal(paper.account(account.id).positions.AAPL.quantity, 40);
  assert.deepEqual(fill(open, { quantity: 40, fee: '0.40', eventId: 'partial-1' }), first);
  assert.equal(paper.account(account.id).cash, '600.60');
  assert.throws(() => fill(open, { quantity: 41, fee: '0.40', eventId: 'partial-1' }), code('EVENT_CONFLICT'));
  const remaining = store.require('order', open.id);
  assert.equal(remaining.status, 'PARTIALLY_FILLED'); assert.equal(remaining.remainingQuantity, 60);
  fill(remaining, { quantity: 60, fee: '0.60', eventId: 'partial-2' });
  assert.equal(paper.account(account.id).cash, '0.00'); assert.equal(paper.account(account.id).positions.AAPL.quantity, 100);
  assert.equal(store.require('order', open.id).status, 'FILLED');
  assert.equal(store.list('paperFill').length, 2);
});

test('stale previews, wrong tokens and insufficient resources never accept orders', t => {
  const { paper, store, account, order, accept, advance } = setup(t, '1000.00');
  const preview = order();
  assert.throws(() => paper.confirm({ id: preview.id, confirmationToken: 'wrong' }), code('CONFIRMATION_REQUIRED'));
  const open = accept({ quantity: 50 });
  assert.throws(() => paper.confirm(preview), code('VERSION_CONFLICT'));
  const tooLarge = order({ quantity: 51 }); assert.throws(() => paper.confirm(tooLarge), code('CASH_COVERAGE'));
  paper.cancel({ id: open.id, revision: open.revision });
  const expired = order(); advance(300001); assert.throws(() => paper.confirm(expired), code('PREVIEW_EXPIRED'));
  assert.equal(paper.account(account.id).cash, '1000.00'); assert.equal(store.list('paperFill').length, 0);
});

test('covered calls reserve shares across open orders and premium does not replace share coverage', t => {
  const { paper, store, account, order, accept, fill } = setup(t);
  const call = { symbol: 'AAPL261218C00020000', assetClass: 'OPTION', side: 'SELL', quantity: 1, limitPrice: '1.00', contract };
  assert.throws(() => paper.confirm(order(call)), code('SHARE_COVERAGE'));
  fill(accept());
  const open = accept(call);
  assert.throws(() => paper.confirm(order({ ...call, symbol: 'AAPL261218C00021000', contract: { ...contract, strike: '21.00' } })), code('SHARE_COVERAGE'));
  assert.throws(() => paper.confirm(order({ side: 'SELL', positionEffect: 'CLOSE', quantity: 1 })), code('SHARE_COVERAGE'));
  fill(open, { fee: '1.00' });
  assert.equal(paper.account(account.id).cash, '9099.00');
  assert.equal(paper.account(account.id).positions[call.symbol].quantity, -1);
  const close = accept({ ...call, side: 'BUY', positionEffect: 'CLOSE', limitPrice: '0.50' }); fill(close, { fee: '1.00' });
  assert.equal(paper.account(account.id).cash, '9048.00');
  fill(accept({ side: 'SELL', positionEffect: 'CLOSE' }));
  assert.equal(paper.account(account.id).cash, '10048.00'); assert.equal(paper.account(account.id).positions.AAPL.quantity, 0);
  assert.equal(store.list('paperFill').length, 4);
});

test('covered call fees are reserved independently from shares', t => {
  const { paper, order, accept, fill } = setup(t, '1000.00'); fill(accept());
  const call = order({ symbol: 'AAPL261218C00020000', assetClass: 'OPTION', side: 'SELL', quantity: 1, limitPrice: '1.00', estimatedFees: '1.00', contract });
  assert.throws(() => paper.confirm(call), code('CASH_COVERAGE'));
});

test('cash secured puts reserve full assignment cash across symbols before premium arrives', t => {
  const { paper, account, order, accept, fill } = setup(t, '2001.00');
  const put = { symbol: 'AAPL261218P00020000', assetClass: 'OPTION', side: 'SELL', quantity: 1, limitPrice: '1.00', estimatedFees: '1.00', contract: { ...contract, right: 'PUT' } };
  const open = accept(put);
  assert.throws(() => paper.confirm(order({ ...put, symbol: 'MSFT261218P00020000', contract: { ...contract, right: 'PUT', underlying: 'MSFT' } })), code('CASH_COVERAGE'));
  fill(open, { fee: '1.00' }); assert.equal(paper.account(account.id).cash, '2100.00');
  assert.throws(() => paper.confirm(order({ quantity: 11 })), code('CASH_COVERAGE'));
  const affordable = order({ quantity: 10 }); assert.equal(paper.confirm(affordable).status, 'OPEN');
});

test('opposite OPEN orders and same-symbol differing contract metadata cannot silently net positions', t => {
  const { paper, order, accept, fill } = setup(t);
  const put = { symbol: 'AAPL261218P00020000', assetClass: 'OPTION', quantity: 1, limitPrice: '1.00', contract: { ...contract, right: 'PUT' } };
  const pendingBuy = accept(put);
  assert.throws(() => paper.confirm(order({ ...put, side: 'SELL' })), code('ORDER_CONFLICT'));
  fill(pendingBuy);
  assert.throws(() => paper.confirm(order({ ...put, contract: { ...put.contract, multiplier: 10 } })), code('CONTRACT_CONFLICT'));
  assert.throws(() => paper.confirm(order({ ...put, side: 'SELL' })), code('POSITION_EFFECT'));
  const reordered = Object.fromEntries(Object.entries(put.contract).reverse());
  assert.equal(paper.confirm(order({ ...put, contract: reordered })).status, 'OPEN');
});

test('calendar-invalid expiry is rejected and failed fills atomically roll back state', t => {
  const { paper, store, account, order, accept, fill } = setup(t, '1000.00');
  assert.throws(() => order({ symbol: 'BAD', assetClass: 'OPTION', quantity: 1, contract: { ...contract, expiration: '2027-02-30' } }), code('INVALID_EXPIRATION'));
  assert.throws(() => order({ symbol: 'BAD', assetClass: 'OPTION', quantity: 1, contract: { ...contract, strike: '0' } }), code('INVALID_STRIKE'));
  const row = accept();
  assert.throws(() => fill(row, { price: '10.01' }), code('LIMIT_VIOLATION'));
  assert.throws(() => fill(row, { fee: '0.01' }), error => ['CASH_OVERFLOW', 'CASH_COVERAGE'].includes(error.code));
  assert.equal(store.require('order', row.id).status, 'OPEN'); assert.equal(paper.account(account.id).cash, '1000.00'); assert.deepEqual(paper.account(account.id).positions, {});
  assert.equal(store.list('paperFill').length, 0);
});

test('cash overflow in an otherwise safe notional fill aborts the complete transaction', t => {
  const { paper, store, account, accept, fill } = setup(t);
  // Boundary state deliberately injected into this isolated test database.
  const a = store.require('paperAccount', account.id);
  store.put('paperAccount', a.id, { ...a, cashCents: Number.MAX_SAFE_INTEGER - 50, positions: { AAPL: { symbol: 'AAPL', quantity: 1, assetClass: 'STOCK', contract: null } } }, a.revision);
  const row = accept({ side: 'SELL', positionEffect: 'CLOSE', quantity: 1 });
  assert.throws(() => fill(row), code('CASH_OVERFLOW'));
  assert.equal(store.require('order', row.id).status, 'OPEN'); assert.equal(paper.account(account.id).positions.AAPL.quantity, 1);
  assert.equal(store.list('paperFill').length, 0);
});

test('DAY expiry releases reservations on a later New York date while GTC stays active', t => {
  const { paper, store, account, order, accept, fill, advance } = setup(t, '1000.00');
  const day = accept({ quantity: 50, timeInForce: 'DAY' });
  const gtc = accept({ quantity: 50, timeInForce: 'GTC' });
  assert.throws(() => paper.confirm(order({ quantity: 1 })), code('CASH_COVERAGE'));
  advance(24 * 3600000);
  assert.deepEqual(paper.expireDayOrders(), [day.id]);
  assert.equal(store.require('order', day.id).status, 'EXPIRED'); assert.equal(store.require('order', gtc.id).status, 'OPEN');
  assert.deepEqual(paper.expireDayOrders(), []);
  assert.throws(() => fill(day), code('ORDER_STATE'));
  assert.equal(paper.confirm(order({ quantity: 50 })).status, 'OPEN');
  fill(gtc);
  assert.equal(paper.account(account.id).cash, '500.00'); assert.equal(paper.account(account.id).positions.AAPL.quantity, 50);
});
