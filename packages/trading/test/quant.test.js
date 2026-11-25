import test from 'node:test';
import assert from 'node:assert/strict';
import { priceOption, impliedVolatility, optionScenario, analyzeWheel, portfolioRisk, backtestPortfolio, rankOptions, QuantError } from '../quant.js';

const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected} by more than ${tolerance}`);
const european = { model: 'BLACK_SCHOLES', right: 'CALL', spot: 100, strike: 100, timeYears: 30 / 365, rate: .05, dividendYield: 0, volatility: .2 };
const fullyChecked = { dataQuality: { fresh: true, reconciled: true, complete: true }, riskChecks: { willingToTakeAssignment: true, batchPolicyConfirmed: true, liquidity: 'PASS', eventRisk: 'PASS', concentration: 'PASS' } };
const candidate = { id: 'new', strategy: 'CC', symbol: 'TEST', currency: 'USD', contracts: 1, multiplier: 100, strike: '54', standardDeliverableVerified: true };
const cc = { ...fullyChecked, strategy: 'CC', symbol: 'TEST', currency: 'USD', position: { shares: '200', nominalCost: '11000', netPremium: '500', confirmed: true }, existingObligations: [], stockReservations: [], candidates: [candidate] };

test('European reference values and explicit per-day/per-percentage-point units', () => {
  const out = priceOption(european);
  near(out.price, 2.49337681940374, 1e-11);
  near(out.greeks.delta, .5399635456230846, 1e-12);
  near(out.greeks.gamma, .06922764046846869, 1e-12);
  near(out.greeks.thetaPerDay, -.0449881561118876, 1e-12);
  near(out.greeks.vegaPerPercentagePoint, .11379886104405812, 1e-12);
  assert.match(out.units.vegaPerPercentagePoint, /0.01/);
  assert.equal(out.executableQuote, false);
});

test('European Call and Put satisfy discounted parity with dividend yield', () => {
  const p = { ...european, timeYears: 1.7, dividendYield: .03, spot: 105, strike: 98 };
  near(priceOption(p).price - priceOption({ ...p, right: 'PUT' }).price, p.spot * Math.exp(-p.dividendYield * p.timeYears) - p.strike * Math.exp(-p.rate * p.timeYears), 1e-10);
});

test('Analytic Greeks agree with independent central finite differences for both rights', () => {
  for (const right of ['CALL', 'PUT']) {
    const p = { ...european, right, dividendYield: .02, timeYears: 1, spot: 105, strike: 100 };
    const g = priceOption(p).greeks, value = priceOption(p).price, ds = .01, dt = .00001, dv = .00001, dr = .00001;
    const up = priceOption({ ...p, spot: p.spot + ds }).price, down = priceOption({ ...p, spot: p.spot - ds }).price;
    near(g.delta, (up - down) / (2 * ds), 1e-7);
    near(g.gamma, (up - 2 * value + down) / (ds * ds), 1e-7);
    near(g.thetaPerDay, (priceOption({ ...p, timeYears: p.timeYears - dt }).price - priceOption({ ...p, timeYears: p.timeYears + dt }).price) / (2 * dt * 365), 1e-8);
    near(g.vegaPerPercentagePoint, (priceOption({ ...p, volatility: p.volatility + dv }).price - priceOption({ ...p, volatility: p.volatility - dv }).price) / (2 * dv) * .01, 1e-7);
    near(g.rhoPerPercentagePoint, (priceOption({ ...p, rate: p.rate + dr }).price - priceOption({ ...p, rate: p.rate - dr }).price) / (2 * dr) * .01, 1e-7);
  }
});

test('Expiry and zero-volatility degeneracy are labelled rather than assigned fabricated Greeks', () => {
  const expiry = priceOption({ ...european, timeYears: 0 });
  assert.equal(expiry.price, 0); assert.equal(expiry.greeks.delta, null); assert.equal(expiry.greeks.gamma, null);
  const zero = priceOption({ ...european, volatility: 0, spot: 110 });
  near(zero.price, 110 - 100 * Math.exp(-.05 * 30 / 365)); assert.equal(zero.greeks.vegaPerPercentagePoint, null);
});

test('Model assumptions reject invalid values, missing rates and unsupported exercise/dividends', () => {
  for (const patch of [{ spot: 0 }, { rate: undefined }, { volatility: NaN }, { volatility: -.1 }, { timeYears: -1 }, { exerciseStyle: 'AMERICAN' }, { discreteDividends: [{ amount: 1 }] }]) assert.throws(() => priceOption({ ...european, ...patch }), QuantError);
});

test('American CRR puts include early exercise and no-dividend calls converge to European value', () => {
  const call = priceOption({ ...european, model: 'CRR', timeYears: 1, steps: 500 });
  near(call.price, priceOption({ ...european, timeYears: 1 }).price, .01);
  const p = { ...european, right: 'PUT', spot: 80, timeYears: 1, rate: .1 };
  const american = priceOption({ ...p, model: 'CRR', steps: 500 });
  assert.ok(american.price >= intrinsicPut(p));
  assert.ok(american.price > priceOption(p).price);
  assert.match(american.warnings[0], /lattice/);
  assert.throws(() => priceOption({ ...european, model: 'CRR', steps: 3, volatility: .00001, rate: 1 }), error => error.code === 'MODEL_UNSTABLE');
});
const intrinsicPut = p => Math.max(p.strike - p.spot, 0);

test('IV inversion recovers the model input and reports unbracketed/expired/non-converged cases', () => {
  const { volatility: unused, ...p } = european;
  const input = { ...p, targetPrice: priceOption(european).price, minVol: .001, maxVol: 2, tolerance: 1e-10, maxIterations: 100 };
  const out = impliedVolatility(input); assert.equal(out.converged, true); near(out.volatility, .2, 1e-10);
  assert.throws(() => impliedVolatility({ ...input, targetPrice: 150 }), error => error.code === 'IV_NOT_BRACKETED');
  assert.throws(() => impliedVolatility({ ...input, timeYears: 0 }), error => error.code === 'IV_UNIDENTIFIABLE');
  const shortBudget = impliedVolatility({ ...input, maxIterations: 1 }); assert.equal(shortBudget.converged, false); assert.equal(shortBudget.volatility, null);
});

test('Short option scenario reverses the sign of repricing loss and retains multiplier', () => {
  const out = optionScenario({ option: european, signedContracts: -1, multiplier: 100, shocks: [{ spotChangePct: .1, volatilityChange: 0, daysElapsed: 0 }, { spotChangePct: 0, volatilityChange: 0, daysElapsed: 30 }] });
  assert.ok(out.rows[0].pnl < 0); near(out.rows[1].pnl, out.base.price * 100, 1e-9);
  assert.throws(() => optionScenario({ option: european, signedContracts: 1, multiplier: 100, shocks: [{ spotChangePct: 0, volatilityChange: -.3, daysElapsed: 0 }] }), QuantError);
});

test('CC uses exact current cost and strict greater-than, excluding hoped-for future premium', () => {
  const approved = analyzeWheel(cc); assert.equal(approved.decision, 'ALLOW'); assert.equal(approved.position.actualCostPerShare, '52.5');
  const equal = analyzeWheel({ ...cc, candidates: [{ ...candidate, strike: '52.50', expectedPremium: '5000' }] });
  assert.equal(equal.decision, 'BLOCK'); assert.equal(equal.checks.cc_cost, 'FAIL');
  assert.equal(analyzeWheel({ ...cc, candidates: [{ ...candidate, strike: '52.500001' }] }).decision, 'ALLOW');
});

test('Aggregate CC candidates cannot reuse shares reserved by existing calls or sale orders', () => {
  const out = analyzeWheel({ ...cc, existingObligations: [{ ...candidate, id: 'existing' }], stockReservations: [{ id: 'sell-stock', symbol: 'TEST', shares: '50' }] });
  assert.equal(out.position.availableShares, '50'); assert.equal(out.decision, 'BLOCK');
  const set = analyzeWheel({ ...cc, candidates: [candidate, { ...candidate, id: 'second', contracts: 2 }] }); assert.equal(set.decision, 'BLOCK');
});

test('Duplicate source IDs are idempotent but conflicting records and overlapping sets are rejected', () => {
  const out = analyzeWheel({ ...cc, existingObligations: [{ ...candidate, id: 'existing' }, { ...candidate, id: 'existing' }] });
  assert.equal(out.position.reservedShares, '100'); assert.equal(out.decision, 'ALLOW');
  assert.throws(() => analyzeWheel({ ...cc, candidates: [candidate, { ...candidate, strike: '55' }] }), error => error.code === 'DUPLICATE_CONFLICT');
  assert.throws(() => analyzeWheel({ ...cc, existingObligations: [candidate] }), error => error.code === 'DUPLICATE_CONFLICT');
});

test('CSP accounts for every symbol obligation, fees and the buffer once', () => {
  const csp = { ...cc, strategy: 'CSP', cash: { amount: '20000', confirmed: true, basis: 'GROSS_SETTLED' }, cashBuffer: '1000', estimatedFees: '0', candidates: [{ ...candidate, strategy: 'CSP', strike: '100' }], existingObligations: [{ ...candidate, id: 'existing', symbol: 'OTHER', strategy: 'CSP', strike: '100' }] };
  const out = analyzeWheel(csp); assert.equal(out.decision, 'BLOCK'); assert.equal(out.cashCoverage.assignmentDemand, '20000'); assert.equal(out.cashCoverage.remaining, '-1000');
  assert.equal(analyzeWheel({ ...csp, cash: { ...csp.cash, amount: '21000' } }).decision, 'ALLOW');
  assert.equal(analyzeWheel({ ...csp, cash: { ...csp.cash, amount: '21000', basis: 'AFTER_RESERVES' } }).decision, 'MANUAL_REVIEW');
});

test('Unknown multipliers, policy, source quality and absent obligation lists cannot yield ALLOW', () => {
  for (const patch of [{ existingObligations: undefined }, { stockReservations: undefined }, { riskChecks: {} }, { dataQuality: {} }, { position: { ...cc.position, confirmed: false } }, { candidates: [{ ...candidate, multiplier: null }] }, { candidates: [{ ...candidate, standardDeliverableVerified: false }] }]) assert.equal(analyzeWheel({ ...cc, ...patch }).decision, 'MANUAL_REVIEW');
  const out = analyzeWheel({ ...cc, riskChecks: {}, candidates: [{ ...candidate, strike: '50' }] }); assert.equal(out.decision, 'BLOCK'); assert.ok(out.reviewReasons.length); assert.ok(out.blockingReasons.length);
});

test('Zero shares do not divide by zero and negative strategy cost is retained', () => {
  const zero = analyzeWheel({ ...cc, position: { ...cc.position, shares: '0', nominalCost: '0' } });
  assert.equal(zero.position.actualCostPerShare, null); assert.equal(zero.decision, 'BLOCK');
  const negative = analyzeWheel({ ...cc, position: { ...cc.position, nominalCost: '100', netPremium: '500' } }); assert.equal(negative.position.actualCostPerShare, '-2');
});

test('Signed stock and option Greeks yield 170 shares of TEST Delta; other symbols remain separate', () => {
  const out = portfolioRisk({ currency: 'USD', cash: '1000', positions: [
    { id: 'stock', symbol: 'TEST', assetClass: 'STOCK', signedQuantity: '200', price: '100', sector: 'TECH' },
    { id: 'call', symbol: 'TEST', assetClass: 'OPTION', signedQuantity: -1, multiplier: 100, price: '2', underlyingSpot: 100, greeks: { delta: .3, gamma: .02, thetaPerDay: -.1, vegaPerPercentagePoint: .2, rhoPerPercentagePoint: .1 }, sector: 'TECH' },
    { id: 'other', symbol: 'OTHER', assetClass: 'STOCK', signedQuantity: 1, price: 50, sector: 'OTHER' },
  ] });
  assert.equal(out.greeksByUnderlying.TEST.delta, 170); assert.equal(out.greeksByUnderlying.OTHER.delta, 1);
  assert.equal(out.greeksByUnderlying.TEST.gamma, -2); assert.equal(out.greeksByUnderlying.TEST.thetaPerDay, 10);
  assert.equal(out.netDollarDelta, 17050); assert.equal(out.equity, 20850);
});

test('Missing Greeks propagate unknown totals instead of zero and currency mixing is rejected', () => {
  const p = { id: 'call', symbol: 'TEST', assetClass: 'OPTION', signedQuantity: -1, multiplier: 100, price: 2 };
  const out = portfolioRisk({ currency: 'USD', cash: 0, positions: [p] }); assert.equal(out.greeksByUnderlying.TEST.delta, null); assert.equal(out.netDollarDelta, null); assert.equal(out.complete, false);
  assert.throws(() => portfolioRisk({ currency: 'USD', cash: 0, positions: [{ ...p, currency: 'HKD' }] }), QuantError);
});

const daily = { initialCapital: '10000', weights: { A: .6, B: .4 }, seriesKind: 'ADJUSTED_TOTAL_RETURN', dataFrequency: 'DAILY', rebalance: 'MONTHLY', costBps: 0, annualRiskFreeRate: 0, periodsPerYear: 252,
  series: { A: [{ date: '2025-01-30', adjustedClose: 100 }, { date: '2025-01-31', adjustedClose: 200 }, { date: '2025-02-03', adjustedClose: 100 }, { date: '2025-02-04', adjustedClose: 110 }], B: [{ date: '2025-01-30', adjustedClose: 100 }, { date: '2025-01-31', adjustedClose: 100 }, { date: '2025-02-03', adjustedClose: 100 }, { date: '2025-02-04', adjustedClose: 100 }] } };

test('Monthly rebalancing takes effect only after the month-end close and differs from buy-and-hold', () => {
  const monthly = backtestPortfolio(daily), hold = backtestPortfolio({ ...daily, rebalance: 'NONE' });
  near(monthly.equityCurve[1].equity, 16000, 1e-8); near(monthly.equityCurve[2].equity, 11200, 1e-8); near(monthly.metrics.finalValue, 11680, 1e-8); near(hold.metrics.finalValue, 10600, 1e-8);
  near(monthly.metrics.maxDrawdown, -.3, 1e-12);
  assert.equal(monthly.trades.filter(t => t.reason === 'MONTHLY')[0].date, '2025-01-31');
  assert.ok(Number.isFinite(monthly.metrics.sharpe));
});

test('Given annual return sequences compound to 15322.61, not 16823, and remain labelled annual', () => {
  const spy = [.1833, .2873, -.1818, .2618, .2489, .1772], tlt = [.1815, -.046, -.3124, .0277, -.0806, .0425];
  const makeSeries = returns => { let value = 100; return [{ date: '2019-12-31', adjustedClose: value }, ...returns.map((r, i) => ({ date: `${2020 + i}-12-31`, adjustedClose: value *= 1 + r }))]; };
  const input = { ...daily, dataFrequency: 'ANNUAL', rebalance: 'ANNUAL', periodsPerYear: 1, weights: { SPY: .6, TLT: .4 }, series: { SPY: makeSeries(spy), TLT: makeSeries(tlt) }, benchmarkSymbol: 'SPY' };
  const out = backtestPortfolio(input); near(out.metrics.finalValue, 15322.611013227272, 1e-8); near(out.benchmark.metrics.finalValue, 23120.783712235097, 1e-8);
  assert.match(out.warnings[0], /Annual approximation/);
  assert.throws(() => backtestPortfolio({ ...input, rebalance: 'MONTHLY' }), error => error.code === 'INSUFFICIENT_HISTORY');
});

test('Cost equation conserves capital on initial allocation and rebalance', () => {
  const out = backtestPortfolio({ ...daily, costBps: 100 });
  near(out.equityCurve[0].equity, 10000 / 1.01, 1e-8);
  near(out.totalCosts, out.trades.reduce((s, t) => s + t.fee, 0), 1e-8);
  assert.ok(out.metrics.finalValue < backtestPortfolio(daily).metrics.finalValue);
  for (const trade of out.trades) near(trade.fee, Math.abs(trade.notional) * .01, 1e-9);
});

test('Duplicate dates, missing cross-asset observations and unverified frequency are rejected', () => {
  assert.throws(() => backtestPortfolio({ ...daily, series: { ...daily.series, B: daily.series.B.slice(1) } }), error => error.code === 'INVALID_HISTORY');
  assert.throws(() => backtestPortfolio({ ...daily, series: { ...daily.series, A: [daily.series.A[0], ...daily.series.A] } }), error => error.code === 'INVALID_HISTORY');
  assert.throws(() => backtestPortfolio({ ...daily, seriesKind: undefined }), QuantError);
  assert.throws(() => backtestPortfolio({ ...daily, expectedDates: ['2025-01-30'] }), error => error.code === 'INVALID_HISTORY');
  assert.throws(() => backtestPortfolio({ ...daily, weights: { A: .8, B: .4 } }), QuantError);
});

test('Constant returns have undefined Sharpe rather than infinity', () => {
  const series = [{ date: '2025-01-01', adjustedClose: 100 }, { date: '2025-01-02', adjustedClose: 100 }, { date: '2025-01-03', adjustedClose: 100 }];
  const out = backtestPortfolio({ ...daily, weights: { A: 1 }, series: { A: series }, rebalance: 'NONE' }); assert.equal(out.metrics.sharpe, null); near(out.metrics.maxDrawdown, 0);
});

test('Option screening obeys explicit thresholds and limit; incomplete Greeks are review items', () => {
  const criteria = { minAbsDelta: .2, maxAbsDelta: .4, maxRelativeSpread: .1, minOpenInterest: 100, minVolume: 10 };
  const good = { id: 'a', bid: 2, ask: 2.1, delta: -.3, openInterest: 500, volume: 50 };
  const out = rankOptions({ criteria, limit: 1, candidates: [good, { ...good, id: 'b', ask: 2.05 }, { ...good, id: 'unknown', delta: null }, { ...good, id: 'crossed', ask: 1 }] });
  assert.equal(out.ranked.length, 1); assert.equal(out.ranked[0].id, 'b'); assert.equal(out.eligibleCount, 2); assert.equal(out.review[0].id, 'unknown'); assert.ok(out.rejected[0].reasons.includes('CROSSED_QUOTE'));
});

test('CRR aggregate work is rejected before expensive scenario or IV loops', () => {
  const option = { model: 'CRR', right: 'PUT', spot: 100, strike: 100, timeYears: 1, rate: .05, dividendYield: 0, volatility: .2, steps: 2000 };
  const budgetExceeded = error => error.code === 'COMPUTE_BUDGET_EXCEEDED';
  assert.throws(() => optionScenario({ option, signedContracts: -1, multiplier: 100, shocks: Array.from({ length: 100 }, () => ({ spotChangePct: 0, volatilityChange: 0, daysElapsed: 0 })) }), budgetExceeded);
  assert.throws(() => impliedVolatility({ ...option, targetPrice: 6, minVol: .1, maxVol: 1, tolerance: 1e-8, maxIterations: 200 }), budgetExceeded);
});
