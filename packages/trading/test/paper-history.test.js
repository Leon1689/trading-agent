import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingStore } from '../storage.js';
import { PaperExecution } from '../paper.js';
import { resolveConfig } from '../config.js';

const base = { symbol: 'AAPL', assetClass: 'STOCK', side: 'BUY', positionEffect: 'OPEN', quantity: 1, type: 'LIMIT', limitPrice: '10.00', currency: 'USD', timeInForce: 'GTC', session: 'REGULAR', estimatedFees: '0.00' };
const contract = { right: 'CALL', underlying: 'AAPL', multiplier: 100, strike: '20.00', expiration: '2026-12-18', standardDeliverableVerified: true };
const code = value => error => error.code === value;
function setup(t, cash = '10000.00') {
  const dir = mkdtempSync(join(tmpdir(), 'paper-history-')), store = new TradingStore(join(dir, 'state.sqlite'));
  let time = Date.parse('2026-11-21T15:00:00Z');
  const paper = new PaperExecution(store, resolveConfig({ execution: { mode: 'LOCAL_PAPER' } }), () => time);
  const account = paper.createAccount({ name: 'Historical fixture', currency: 'USD', initialCash: cash });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const preview = patch => paper.preview({ ...base, accountId: account.id, ...patch });
  const accept = patch => { const draft = preview(patch); paper.confirm(draft); return store.require('order', draft.id); };
  const fill = (row, patch = {}) => paper.fill({ id: row.id, revision: row.revision, quantity: row.remainingQuantity, price: row.order.limitPrice, fee: '0.00', eventId: `fill-${row.id}`, ...patch });
  return { store, paper, account, preview, accept, fill, setTime: value => { time = Date.parse(value); } };
}
function buryWithHistory(store, accountId, oldId, { count = 1001, status = 'DRAFT' } = {}) {
  // Populate only the isolated test database, keeping all historical rows newer than the risk-bearing order.
  store.db.prepare("UPDATE records SET updated_at='2020-01-01T00:00:00.000Z' WHERE kind='order' AND id=?").run(oldId);
  store.transaction(() => {
    for (let index = 0; index < count; index++) store.put('order', `history-${index}`, { order: { ...base, accountId, symbol: 'OTHER', limitPrice: '1.00', contract: null }, status, remainingQuantity: 1, filledQuantity: 0, acceptedAt: '2026-11-21T15:00:00.000Z', synthetic: true }, 0);
  });
}

test('over 1000 newer drafts cannot hide an older OPEN cash reservation', t => {
  const { store, paper, account, preview, accept } = setup(t, '1000.00');
  const open = accept({ quantity: 90 }); buryWithHistory(store, account.id, open.id);
  assert.equal(paper.orders(account.id).length, 1000); assert.equal(paper.orders(account.id).some(row => row.id === open.id), false);
  assert.deepEqual(store.paperOrders({ accountId: account.id, activeOnly: true }).map(row => row.id), [open.id]);
  assert.throws(() => paper.confirm(preview({ quantity: 90 })), code('CASH_COVERAGE'));
  assert.equal(store.require('order', open.id).status, 'OPEN'); assert.equal(paper.account(account.id).cash, '1000.00');
});

test('SQL filters account before display limit, while active risk queries have no limit', t => {
  const { store, paper, account, accept } = setup(t);
  const open = accept(); buryWithHistory(store, 'another-account', open.id, { status: 'OPEN' });
  assert.deepEqual(paper.orders(account.id).map(row => row.id), [open.id]);
  assert.equal(store.paperOrders({ activeOnly: true }).length, 1002);
  assert.equal(store.paperOrders({ activeOnly: true, limit: 1000 }).length, 1000);
  assert.equal(store.paperOrders({ accountId: account.id, activeOnly: true }).length, 1);
  assert.throws(() => store.paperOrders({ limit: 0 }), code('INVALID_PAGE'));
});

test('older covered calls still reserve shares after more than 1000 drafts', t => {
  const { store, paper, account, preview, accept, fill } = setup(t);
  fill(accept({ quantity: 100 }));
  const call = { symbol: 'AAPL261218C00020000', assetClass: 'OPTION', side: 'SELL', quantity: 1, limitPrice: '1.00', contract };
  const open = accept(call); buryWithHistory(store, account.id, open.id);
  assert.throws(() => paper.confirm(preview({ ...call, symbol: 'AAPL261218C00021000', contract: { ...contract, strike: '21.00' } })), code('SHARE_COVERAGE'));
  assert.throws(() => paper.confirm(preview({ side: 'SELL', positionEffect: 'CLOSE' })), code('SHARE_COVERAGE'));
});

test('older pending option closes remain in close-quantity and order-conflict checks', t => {
  const { store, paper, account, preview, accept, fill } = setup(t);
  const option = { symbol: 'AAPL261218C00020000', assetClass: 'OPTION', quantity: 2, limitPrice: '1.00', contract };
  fill(accept(option));
  const closing = accept({ ...option, side: 'SELL', positionEffect: 'CLOSE' }); buryWithHistory(store, account.id, closing.id);
  assert.throws(() => paper.confirm(preview({ ...option, side: 'SELL', positionEffect: 'CLOSE', quantity: 1 })), code('CLOSE_COVERAGE'));
  assert.throws(() => paper.confirm(preview({ ...option, quantity: 1 })), code('ORDER_CONFLICT'));
});

test('DAY expiry finds older active orders behind more than 1000 drafts and releases reservations', t => {
  const { store, paper, account, preview, accept, setTime } = setup(t, '1000.00');
  const open = accept({ quantity: 90, timeInForce: 'DAY' }); buryWithHistory(store, account.id, open.id);
  setTime('2026-11-22T15:00:00Z'); assert.deepEqual(paper.expireDayOrders(), [open.id]);
  assert.equal(store.require('order', open.id).status, 'EXPIRED'); assert.deepEqual(paper.expireDayOrders(), []);
  assert.equal(paper.confirm(preview({ quantity: 100 })).status, 'OPEN');
});

test('expired GTC options cannot be confirmed or newly filled and no settlement is invented', t => {
  const { store, paper, account, preview, accept, fill, setTime } = setup(t);
  const option = { symbol: 'AAPL261218C00020000', assetClass: 'OPTION', quantity: 2, limitPrice: '1.00', contract };
  const open = accept(option); const first = fill(open, { quantity: 1, eventId: 'pre-expiry-fill' });
  setTime('2026-12-17T23:59:00Z'); const draft = preview({ ...option, quantity: 1 });
  const beforeAccount = paper.account(account.id), beforeOpen = store.require('order', open.id), beforeDraft = store.require('order', draft.id);
  setTime('2026-12-18T00:00:00Z');
  assert.throws(() => paper.confirm(draft), code('CONTRACT_EXPIRED'));
  assert.throws(() => fill(beforeOpen, { quantity: 1, eventId: 'after-expiry-fill' }), code('CONTRACT_EXPIRED'));
  assert.equal(store.get('paperFill', 'after-expiry-fill'), null);
  assert.deepEqual(paper.account(account.id), beforeAccount); assert.deepEqual(store.require('order', open.id), beforeOpen); assert.deepEqual(store.require('order', draft.id), beforeDraft);
  assert.deepEqual(fill(open, { quantity: 1, eventId: 'pre-expiry-fill' }), first); // Historical idempotent read, not another fill.
  assert.equal(paper.account(account.id).positions[option.symbol].quantity, 1);
});
