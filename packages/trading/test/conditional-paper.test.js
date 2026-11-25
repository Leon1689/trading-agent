import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConditionalPaper } from '../conditional-paper.js';
import { PaperExecution } from '../paper.js';
import { TradingStore } from '../storage.js';
import { resolveConfig } from '../config.js';
const at = Date.parse('2026-11-21T15:00:00Z');
const code = value => error => error.code === value;
const baseOrder = { symbol: 'AAPL', assetClass: 'STOCK', side: 'BUY', positionEffect: 'OPEN', quantity: 5, type: 'LIMIT', limitPrice: '100.00', currency: 'USD', timeInForce: 'GTC', session: 'REGULAR', estimatedFees: '0.00' };
const rule = patch => ({ name: 'Synthetic stop', kind: 'SINGLE', maxAgeMs: 300000, expiresAt: '2026-11-22T15:00:00Z', legs: [{ type: 'STOP_LIMIT', triggerPrice: '100.00', order: baseOrder }], ...patch });
function setup(t, execution = 'READ_ONLY') {
  const dir = mkdtempSync(join(tmpdir(), 'condition-paper-')), store = new TradingStore(join(dir, 'state.sqlite')); let now = at;
  const config = resolveConfig({ execution: { mode: execution } }), paper = new PaperExecution(store, config, () => now), conditional = new ConditionalPaper(store, paper, () => now);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const evaluate = (condition, patch = {}, quotePatch = {}) => conditional.evaluate({ id: condition.id, revision: condition.revision, eventId: 'test-event', quote: { symbol: 'AAPL', assetClass: 'STOCK', currency: 'USD', priceUnit: 'USD_PER_SHARE', price: '100.00', asOf: new Date(now).toISOString(), source: 'test-scenario', synthetic: true, ...quotePatch }, ...patch });
  return { store, paper, conditional, evaluate, advance: delta => { now += delta; }, path: join(dir, 'state.sqlite') };
}

test('trigger creates a real draft but no accepted order, resource reservation or account mutation', t => {
  const { store, conditional, evaluate } = setup(t), created = conditional.create(rule());
  assert.equal(created.status, 'ARMED'); assert.equal(created.reservesResources, false);
  const result = evaluate(created); assert.equal(result.matched, true); assert.equal(result.draft.status, 'DRAFT'); assert.equal(result.draft.executionEnabled, false); assert.equal(result.orderSubmitted, false); assert.equal(result.quoteAuthority, 'SYNTHETIC_SCENARIO');
  assert.equal(store.require('order', result.draft.id).status, 'DRAFT'); assert.equal(store.paperOrders({ activeOnly: true }).length, 0); assert.equal(store.list('paperAccount').length, 0);
  assert.ok(result.draft.confirmationToken); assert.equal(JSON.stringify(conditional.get(created.id)).includes(result.draft.confirmationToken), false);
  assert.equal(JSON.stringify(store.list('conditionEvaluation')).includes(result.draft.confirmationToken), false);
});

test('duplicate trigger events are idempotent and conflicting reuse fails without extra drafts', t => {
  const { store, conditional, evaluate } = setup(t), created = conditional.create(rule());
  const result = evaluate(created), repeat = evaluate(created);
  assert.equal(repeat.repeated, true); assert.equal(repeat.draft.id, result.draft.id); assert.equal(repeat.draft.confirmationToken, undefined); assert.equal(store.list('order').length, 1);
  assert.throws(() => evaluate(created, {}, { price: '101.00' }), code('EVENT_CONFLICT'));
  assert.equal(store.list('order').length, 1);
});

test('OCO stop trigger closes the other branch atomically even across a second store connection', t => {
  const { store, paper, conditional, evaluate, path } = setup(t);
  const closeOrder = { ...baseOrder, side: 'SELL', positionEffect: 'CLOSE' };
  const created = conditional.create(rule({ kind: 'OCO', legs: [{ type: 'STOP_LIMIT', triggerPrice: '90.00', order: { ...closeOrder, limitPrice: '89.00' } }, { type: 'TAKE_PROFIT_LIMIT', triggerPrice: '110.00', order: { ...closeOrder, limitPrice: '110.00' } }] }));
  const siblingStore = new TradingStore(path), sibling = new ConditionalPaper(siblingStore, new PaperExecution(siblingStore, paper.config, () => at), () => at);
  try {
    const result = evaluate(created, {}, { price: '89.50' }); assert.deepEqual(result.condition.legs.map(leg => leg.status), ['TRIGGERED', 'CANCELLED_BY_OCO']);
    assert.throws(() => sibling.evaluate({ id: created.id, revision: created.revision, eventId: 'second-event', quote: { symbol: 'AAPL', assetClass: 'STOCK', currency: 'USD', priceUnit: 'USD_PER_SHARE', price: '111.00', asOf: new Date(at).toISOString(), source: 'test', synthetic: true } }), code('CONDITION_STATE'));
    assert.equal(store.list('order').length, 1);
  } finally { siblingStore.close(); }
});

test('rules reject overlapping OCO conditions and different-account or opening legs', t => {
  const { conditional } = setup(t);
  const closeOrder = { ...baseOrder, side: 'SELL', positionEffect: 'CLOSE' };
  assert.throws(() => conditional.create(rule({ kind: 'OCO', legs: [{ type: 'STOP_LIMIT', triggerPrice: '110.00', order: closeOrder }, { type: 'TAKE_PROFIT_LIMIT', triggerPrice: '90.00', order: closeOrder }] })), code('INVALID_OCO'));
  assert.throws(() => conditional.create(rule({ kind: 'OCO', legs: [{ type: 'STOP_LIMIT', triggerPrice: '90.00', order: baseOrder }, { type: 'TAKE_PROFIT_LIMIT', triggerPrice: '110.00', order: baseOrder }] })), code('INVALID_OCO'));
});

test('stop and take-profit directions depend on explicit buy or sell side', t => {
  const { conditional, evaluate } = setup(t);
  const buyTake = conditional.create(rule({ legs: [{ type: 'TAKE_PROFIT_LIMIT', triggerPrice: '90.00', order: baseOrder }] }));
  assert.equal(evaluate(buyTake, {}, { price: '89.00' }).matched, true);
  const sellTake = conditional.create(rule({ legs: [{ type: 'TAKE_PROFIT_LIMIT', triggerPrice: '110.00', order: { ...baseOrder, side: 'SELL', positionEffect: 'CLOSE' } }] }));
  assert.equal(evaluate(sellTake, {}, { price: '110.00' }).matched, true);
});

test('stale, future, wrong-symbol and unlabelled quotes leave the rule armed', t => {
  const { store, conditional, evaluate } = setup(t), created = conditional.create(rule());
  assert.throws(() => evaluate(created, {}, { asOf: '2026-11-21T14:00:00Z' }), code('STALE_CONDITION_DATA'));
  assert.throws(() => evaluate(created, {}, { asOf: '2026-11-21T16:00:00Z' }), code('STALE_CONDITION_DATA'));
  assert.throws(() => evaluate(created, {}, { symbol: 'MSFT' }), code('SYMBOL_MISMATCH'));
  assert.throws(() => evaluate(created, {}, { synthetic: undefined }), code('SOURCE_REQUIRED'));
  assert.equal(conditional.get(created.id).revision, created.revision); assert.equal(store.list('order').length, 0);
});

test('nonmatching checks update the version; older quotes cannot trigger after newer checks', t => {
  const { conditional, evaluate, advance } = setup(t), created = conditional.create(rule());
  const checked = evaluate(created, {}, { price: '99.00' }); assert.equal(checked.matched, false);
  advance(1000);
  assert.throws(() => evaluate(checked.condition, { eventId: 'old' }, { asOf: '2026-11-21T14:59:59Z' }), code('OUT_OF_ORDER_QUOTE'));
  const result = evaluate(checked.condition, { eventId: 'new' }); assert.equal(result.matched, true);
});

test('expired and cancelled conditions cannot create drafts', t => {
  const { store, conditional, evaluate, advance } = setup(t), created = conditional.create(rule({ expiresAt: '2026-11-21T15:00:01Z' }));
  advance(2000); const result = evaluate(created); assert.equal(result.condition.status, 'EXPIRED'); assert.equal(result.matched, false);
  const another = conditional.create(rule()); const cancelled = conditional.cancel({ id: another.id, revision: another.revision });
  assert.equal(cancelled.status, 'CANCELLED'); assert.throws(() => evaluate(cancelled), code('CONDITION_STATE')); assert.equal(store.list('order').length, 0);
});

test('a failed draft transaction rolls back trigger and event so it can be inspected safely', t => {
  const { store, paper, conditional, evaluate } = setup(t), created = conditional.create(rule());
  paper.preview = () => { throw new Error('injected preview failure'); };
  assert.throws(() => evaluate(created), /injected preview failure/);
  assert.equal(conditional.get(created.id).status, 'ARMED'); assert.equal(conditional.get(created.id).revision, created.revision); assert.equal(store.list('conditionEvaluation').length, 0); assert.equal(store.list('order').length, 0);
});

test('human re-preview supersedes a lost draft; accepted draft cannot be replayed into a second order', t => {
  const { store, paper, conditional, evaluate } = setup(t, 'LOCAL_PAPER');
  const account = paper.createAccount({ name: 'test', initialCash: '1000.00', currency: 'USD' });
  const created = conditional.create(rule({ legs: [{ type: 'STOP_LIMIT', triggerPrice: '100.00', order: { ...baseOrder, accountId: account.id } }] }));
  const first = evaluate(created), fresh = conditional.previewTriggered({ id: created.id, revision: first.condition.revision });
  assert.equal(store.require('order', first.draft.id).status, 'CANCELLED'); assert.equal(paper.confirm(first.draft).status, 'CANCELLED');
  assert.equal(paper.confirm(fresh.draft).status, 'OPEN');
  assert.throws(() => conditional.previewTriggered({ id: created.id, revision: fresh.condition.revision }), code('CONDITION_ALREADY_ACCEPTED'));
  assert.equal(store.paperOrders({ activeOnly: true }).length, 1); assert.equal(paper.account(account.id).cash, '1000.00');
});

test('option triggers require the exact contract and explicit per-underlying premium units', t => {
  const { store, conditional, evaluate } = setup(t);
  const contract = { right: 'CALL', underlying: 'AAPL', multiplier: 100, strike: '100.00', expiration: '2026-12-18', standardDeliverableVerified: true };
  const order = { ...baseOrder, symbol: 'AAPL261218C00100000', assetClass: 'OPTION', quantity: 1, limitPrice: '3.00', contract };
  const created = conditional.create(rule({ legs: [{ type: 'STOP_LIMIT', triggerPrice: '3.00', order }] }));
  const quote = { symbol: order.symbol, assetClass: 'OPTION', currency: 'USD', priceUnit: 'USD_PER_UNDERLYING_UNIT', price: '3.00', contract };
  assert.equal(created.priceUnit, 'USD_PER_UNDERLYING_UNIT');
  assert.throws(() => evaluate(created, {}, { symbol: order.symbol }), code('CONTRACT_MISMATCH'));
  assert.throws(() => evaluate(created, {}, { ...quote, contract: { ...contract, strike: '105.00' } }), code('CONTRACT_MISMATCH'));
  assert.throws(() => evaluate(created, {}, { ...quote, priceUnit: 'USD_PER_CONTRACT' }), code('UNKNOWN_PRICE_BASIS'));
  assert.throws(() => evaluate(created, {}, { ...quote, currency: 'HKD' }), code('UNKNOWN_PRICE_BASIS'));
  assert.equal(store.list('order').length, 0); assert.equal(conditional.get(created.id).status, 'ARMED');
  const result = evaluate(created, {}, quote); assert.equal(result.matched, true); assert.equal(result.draft.order.contract.multiplier, 100);
});

test('condition quantities and option multipliers are typed rather than coerced', t => {
  const { conditional } = setup(t);
  assert.throws(() => conditional.create(rule({ legs: [{ type: 'STOP_LIMIT', triggerPrice: '100.00', order: { ...baseOrder, quantity: '5' } }] })), code('INVALID_QUANTITY'));
  const contract = { right: 'CALL', underlying: 'AAPL', multiplier: '100', strike: '100.00', expiration: '2026-12-18', standardDeliverableVerified: true };
  assert.throws(() => conditional.create(rule({ legs: [{ type: 'STOP_LIMIT', triggerPrice: '3.00', order: { ...baseOrder, assetClass: 'OPTION', contract } }] })), code('UNVERIFIED_CONTRACT'));
});
