import test from 'node:test';
import assert from 'node:assert/strict';
import { technicalIndicators, classifyNews, planRebalance, comparePredictionMarkets } from '../research-features.js';
const asOf = '2026-11-21T15:00:00Z';
const code = value => error => error.code === value;
const close = (actual, expected, tolerance = 1e-10) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const series = prices => prices.map((price, i) => ({ date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10), close: price }));
const technical = prices => ({ series: series(prices), priceBasis: 'ADJUSTED_TOTAL_RETURN', smaPeriods: [3], emaPeriods: [3], rsiPeriod: 3, macd: { fast: 2, slow: 3, signal: 2 }, asOf });

test('SMA/EMA seeded windows, Wilder RSI and MACD expose warmup instead of zeros', () => {
  const result = technicalIndicators(technical([1, 2, 3, 4, 5, 6]));
  assert.equal(result.rows[0].sma3, null); assert.equal(result.rows[1].ema3, null); assert.equal(result.rows[2].sma3, 2); assert.equal(result.rows[2].ema3, 2);
  assert.equal(result.rows[2].rsi, null); assert.equal(result.rows[3].rsi, 100);
  close(result.rows[2].macd, 0.5); assert.equal(result.rows[2].macdSignal, null); close(result.rows[3].macdSignal, 0.5); close(result.latest.macdHistogram, 0);
  assert.equal(result.latest.sma3, 5); assert.equal(result.latest.ema3, 5); assert.equal(result.orderSubmissionEnabled, false);
});

test('RSI handles flat and falling observations with explicit convention', () => {
  assert.equal(technicalIndicators(technical([3, 3, 3, 3, 3])).latest.rsi, 50);
  assert.equal(technicalIndicators(technical([5, 4, 3, 2, 1])).latest.rsi, 0);
  const prices = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.1, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28];
  close(technicalIndicators({ ...technical(prices), rsiPeriod: 14 }).latest.rsi, 70.46413502109705);
});

test('adding future observations never changes the historical prefix of any indicator', () => {
  const prices = Array.from({ length: 60 }, (_, i) => 100 + i * 0.2 + Math.sin(i) * 3);
  const short = technicalIndicators(technical(prices.slice(0, 30))), full = technicalIndicators(technical(prices));
  assert.deepEqual(full.rows.slice(0, 30), short.rows); assert.equal(full.methodology.lookahead, false);
});

test('technical calculations reject reordered, duplicate, future, invalid and undeclared basis input', () => {
  const base = technical([1, 2, 3]);
  assert.throws(() => technicalIndicators({ ...base, series: [...base.series].reverse() }), code('INVALID_HISTORY'));
  assert.throws(() => technicalIndicators({ ...base, series: [base.series[0], base.series[0]] }), code('INVALID_HISTORY'));
  assert.throws(() => technicalIndicators({ ...base, series: [{ date: '2026-02-30', close: 1 }] }), code('INVALID_HISTORY'));
  assert.throws(() => technicalIndicators({ ...base, asOf: '2025-12-31T23:59:00Z' }), code('INVALID_HISTORY'));
  assert.throws(() => technicalIndicators({ ...base, priceBasis: 'GUESS' }), code('UNKNOWN_PRICE_BASIS'));
  assert.throws(() => technicalIndicators({ ...base, symbol: 123 }), code('INVALID_SYMBOL'));
  assert.throws(() => technicalIndicators({ ...base, macd: { fast: 20, slow: 10, signal: 9 } }), code('INVALID_INPUT'));
  assert.throws(() => technicalIndicators({ ...base, series: [{ date: '2026-01-01', close: NaN }] }), code('INVALID_HISTORY'));
});

test('news cards classify with explicit heuristics and remove identical stable duplicates', () => {
  const company = { id: '1', title: 'AAPL new product', source: 'fixture-news', symbols: ['AAPL'], publishedAt: '2026-11-21T14:00:00Z' };
  const result = classifyNews({ asOf, limit: 30, articles: [company, { id: '2', title: 'Federal Reserve inflation outlook', source: 'fixture-news', publishedAt: '2026-11-21T14:30:00Z' }, { id: '3', title: 'Semiconductor demand rises', source: 'fixture-news', publishedAt: null }, company] });
  assert.equal(result.duplicatesRemoved, 1); assert.deepEqual(result.items.map(r => r.category), ['MACRO', 'COMPANY', 'INDUSTRY']);
  assert.ok(result.items.every(r => r.classification.method === 'LOCAL_HEURISTIC' && !r.classification.confirmed));
  assert.equal(result.items[2].ageMs, null); assert.equal(result.rankingClaim, 'NOT_BOBBY_HOT_TRADES_RANKING');
});

test('conflicting news identity, future timestamps and unsafe links are never hidden', () => {
  const article = { id: 'x', title: 'First', source: 'test', publishedAt: asOf };
  assert.throws(() => classifyNews({ asOf, articles: [article, { ...article, title: 'Changed' }] }), code('EVENT_CONFLICT'));
  assert.throws(() => classifyNews({ asOf, articles: [{ ...article, publishedAt: '2026-11-22T00:00:00Z' }] }), code('FUTURE_DATA'));
  assert.throws(() => classifyNews({ asOf, articles: [{ ...article, url: 'javascript:alert(1)' }] }), code('INVALID_URL'));
});

const rebalance = { currency: 'USD', cash: '1000.00', positions: [{ symbol: 'A', quantity: 10, price: '100.00' }, { symbol: 'B', quantity: 0, price: '50.00' }], targetWeights: { A: 0.5, B: 0.5 }, estimatedFeePerOrder: '1.00', minimumTradeValue: '0.00' };
test('rebalance sells before buying, pays actual planned fees and preserves total equity', () => {
  const result = planRebalance(rebalance);
  assert.deepEqual(result.orders.map(r => [r.symbol, r.side, r.quantity]), [['A', 'SELL', 1], ['B', 'BUY', 19]]);
  assert.equal(result.initialNav, '2000.00'); assert.equal(result.projectedCash, '148.00'); assert.equal(result.estimatedFees, '2.00'); assert.equal(result.projectedNav, '1998.00');
  const holdings = result.projected.reduce((n, x) => n + Math.round(Number(x.value) * 100), 0);
  assert.equal(holdings + Math.round(Number(result.projectedCash) * 100), Math.round(Number(result.projectedNav) * 100));
  assert.equal(result.orderSubmissionEnabled, false); assert.ok(result.orders.every(o => !o.executed && o.status === 'RESEARCH_PREVIEW'));
});

test('skipped small sales never finance planned buys and no borrowing is introduced', () => {
  const result = planRebalance({ ...rebalance, cash: '0.00', targetWeights: { A: 0.5, B: 0.5 }, minimumTradeValue: '1000.00' });
  assert.equal(result.orders.length, 0); assert.equal(result.projectedCash, '0.00'); assert.ok(result.skipped.some(s => s.reason === 'CASH_COVERAGE'));
});

test('rebalance refuses missing prices, leverage, duplicate and fractional-share inputs', () => {
  assert.throws(() => planRebalance({ ...rebalance, targetWeights: { C: 1 } }), code('MISSING_PRICE'));
  assert.throws(() => planRebalance({ ...rebalance, targetWeights: { A: 0.8, B: 0.8 } }), code('INVALID_WEIGHTS'));
  assert.throws(() => planRebalance({ ...rebalance, positions: [rebalance.positions[0], rebalance.positions[0]] }), code('INVALID_POSITIONS'));
  assert.throws(() => planRebalance({ ...rebalance, positions: [{ ...rebalance.positions[0], quantity: 0.5 }] }), code('INVALID_INPUT'));
  assert.throws(() => planRebalance({ ...rebalance, cash: '-1' }), code('INVALID_MONEY'));
});

const market = (id = 'm1') => ({ id, platform: 'test', outcome: 'Yes', eventKey: 'same-event', resolutionRules: 'This exact supplied rule string.', asOf, source: 'scenario', synthetic: true, priceUnit: 'USD_PER_CONTRACT', payoutPerContract: 1, orderbook: { bids: [{ price: 0.4, quantity: 10 }], asks: [{ price: 0.5, quantity: 5 }, { price: 0.6, quantity: 5 }] }, fairProbability: 0.7, feePerContract: 0.01 });
const comparison = markets => ({ markets, quantity: 10, asOf, maxAgeMs: 60000 });
test('prediction comparison walks complete depth and computes explicit fee-adjusted subjective edge', () => {
  const result = comparePredictionMarkets(comparison([market()])); const row = result.rows[0];
  close(row.buy.averagePrice, 0.55); close(row.buy.costIncludingExplicitFees, 5.6); close(row.sell.proceedsAfterExplicitFees, 3.9); close(row.subjectiveBuyEdgePerContractAfterFee, 0.14);
  assert.equal(result.arbitrageVerified, false); assert.equal(result.cheapestBuyMarketId, null); assert.equal(row.synthetic, true);
});

test('cross-platform ranking requires identical supplied event, outcome and settlement rules', () => {
  const second = { ...market('m2'), platform: 'another', feePerContract: 0, orderbook: { bids: [{ price: 0.49, quantity: 10 }], asks: [{ price: 0.51, quantity: 10 }] } };
  const result = comparePredictionMarkets(comparison([market(), second])); assert.equal(result.sameEventAndRulesSupplied, true); assert.equal(result.cheapestBuyMarketId, 'm2');
  const mismatch = comparePredictionMarkets(comparison([market(), { ...second, resolutionRules: 'Different resolution source.' }])); assert.equal(mismatch.cheapestBuyMarketId, null); assert.equal(mismatch.sameEventAndRulesSupplied, false);
});

test('insufficient depth stays incomplete rather than extrapolating a quote', () => {
  const m = market(); m.orderbook.asks = [{ price: 0.5, quantity: 2 }];
  const result = comparePredictionMarkets(comparison([m])); assert.equal(result.rows[0].buy.complete, false); assert.equal(result.rows[0].buy.quantityAvailable, 2); assert.equal(result.rows[0].buy.costIncludingExplicitFees, null); assert.equal(result.rows[0].subjectiveBuyEdgePerContractAfterFee, null);
  m.orderbook.asks = [{ price: 0.5, quantity: 1e-8 }];
  const tiny = comparePredictionMarkets({ ...comparison([m]), quantity: 1e-8 + 5e-13 });
  assert.equal(tiny.rows[0].buy.complete, false); assert.equal(tiny.rows[0].buy.total, null);
  assert.throws(() => comparePredictionMarkets({ ...comparison([m]), quantity: 1e-16 }), code('INVALID_INPUT'));
});

test('prediction units, timestamp, crossed book and absent synthetic flag are checked', () => {
  assert.throws(() => comparePredictionMarkets(comparison([{ ...market(), priceUnit: 'CENTS' }])), code('UNKNOWN_PRICE_BASIS'));
  assert.throws(() => comparePredictionMarkets(comparison([{ ...market(), asOf: '2026-11-20T15:00:00Z' }])), code('STALE_MARKET_DATA'));
  assert.throws(() => comparePredictionMarkets(comparison([{ ...market(), synthetic: undefined }])), code('SOURCE_REQUIRED'));
  assert.throws(() => comparePredictionMarkets(comparison([{ ...market(), orderbook: { bids: [{ price: 0.9, quantity: 1 }], asks: [{ price: 0.5, quantity: 1 }] } }])), code('CROSSED_ORDERBOOK'));
});
