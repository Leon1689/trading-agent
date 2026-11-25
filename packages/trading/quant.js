/** Deterministic pricing and analysis. Outputs are estimates, never executions or ledger mutations. */
export class QuantError extends Error {
  constructor(message, code = 'INVALID_INPUT') { super(message); this.name = 'QuantError'; this.code = code; this.status = 400; }
}

const fail = (message, code) => { throw new QuantError(message, code); };
const obj = (x, name) => x && typeof x === 'object' && !Array.isArray(x) ? x : fail(`${name} must be an object`);
const number = (x, name, min = -1e12, max = 1e12) => {
  if ((typeof x !== 'number' && typeof x !== 'string') || String(x).trim() === '') fail(`${name} is required`);
  const n = Number(x);
  if (!Number.isFinite(n) || n < min || n > max) fail(`${name} is outside its supported range`);
  return n;
};
const integer = (x, name, min, max) => { const n = number(x, name, min, max); return Number.isSafeInteger(n) ? n : fail(`${name} must be an integer`); };
const choice = (x, values, name) => values.includes(x) ? x : fail(`${name} must be one of ${values.join(', ')}`);
const text = (x, name, max = 120) => typeof x === 'string' && x.length > 0 && x.length <= max ? x : fail(`${name} is required or too long`);
const list = (x, name, max = 1000) => Array.isArray(x) && x.length <= max ? x : fail(`${name} must be an array of at most ${max} items`);
const optional = (x, parser) => x === undefined || x === null ? null : parser(x);
const date = (x, name) => {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || !Number.isFinite(Date.parse(x)) || new Date(x).toISOString().slice(0, 10) !== x) fail(`${name} must be a calendar date`);
  return x;
};
const allFinite = x => Object.values(x).every(v => v === null || Number.isFinite(v));
const YEAR_DAYS = 365;
const QUANT_VERSION = 'quant-1.0.0';
// Bound synchronous lattice work before it can monopolize the authenticated Host event loop.
const MAX_LATTICE_UPDATES = 50000000;
function checkLatticeBudget(p, trees) {
  if (p.model === 'CRR' && p.timeYears > 0 && trees * (p.steps + 1) * (p.steps + 2) / 2 > MAX_LATTICE_UPDATES) {
    fail('Requested lattice work exceeds 50000000 updates; reduce steps, scenarios or iteration budget', 'COMPUTE_BUDGET_EXCEEDED');
  }
}

// Integrating the normal density by its convergent odd-power series avoids a low-precision CDF approximation.
function normalCdf(x) {
  if (x <= -8.3) return 0;
  if (x >= 8.3) return 1;
  let sum = x, term = x;
  for (let n = 1; n < 200; n++) {
    term *= x * x / (2 * n + 1);
    const next = sum + term;
    if (next === sum) break;
    sum = next;
  }
  return Math.max(0, Math.min(1, 0.5 + sum * normalPdf(x)));
}
const normalPdf = x => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
const intrinsic = (right, spot, strike) => Math.max(right === 'CALL' ? spot - strike : strike - spot, 0);

function optionInput(input, { requireVolatility = true } = {}) {
  obj(input, 'option');
  if (input.discreteDividends?.length) fail('Discrete dividends need a separate calibrated model; continuous dividend yield is the supported convention', 'UNSUPPORTED_MODEL');
  const p = {
    model: choice(input.model, ['BLACK_SCHOLES', 'CRR'], 'model'),
    right: choice(input.right, ['CALL', 'PUT'], 'right'),
    spot: number(input.spot, 'spot', 1e-8, 1e9), strike: number(input.strike, 'strike', 1e-8, 1e9),
    timeYears: number(input.timeYears, 'timeYears', 0, 50), rate: number(input.rate, 'rate', -2, 2),
    dividendYield: number(input.dividendYield, 'dividendYield', -2, 2),
  };
  if (requireVolatility) p.volatility = number(input.volatility, 'volatility', 0, 5);
  if (p.model === 'CRR') p.steps = integer(input.steps, 'steps', 3, 2000);
  if (input.exerciseStyle && input.exerciseStyle !== (p.model === 'CRR' ? 'AMERICAN' : 'EUROPEAN')) fail('exerciseStyle does not match model', 'UNSUPPORTED_MODEL');
  return p;
}

function bs(p) {
  const { spot: S, strike: K, timeYears: T, rate: r, dividendYield: q, volatility: v, right } = p;
  const sign = right === 'CALL' ? 1 : -1;
  const ds = Math.exp(-q * T), dk = Math.exp(-r * T);
  if (T === 0 || v === 0) {
    const difference = T === 0 ? S - K : S * ds - K * dk;
    return { price: Math.max(sign * difference, 0), greeks: {
      delta: difference === 0 ? null : (sign * difference > 0 ? sign * ds : 0),
      gamma: null, thetaPerDay: null, vegaPerPercentagePoint: null, rhoPerPercentagePoint: null,
    }, warnings: [T === 0 ? 'Expired option: time/volatility Greeks are undefined' : 'Zero-volatility degenerate limit: only price and non-kink Delta are reported'] };
  }
  const sqrtT = Math.sqrt(T), d1 = (Math.log(S / K) + (r - q + v * v / 2) * T) / (v * sqrtT), d2 = d1 - v * sqrtT;
  const density = normalPdf(d1);
  const nd1 = normalCdf(sign * d1), nd2 = normalCdf(sign * d2);
  return { price: Math.max(0, sign * (S * ds * nd1 - K * dk * nd2)), greeks: {
    delta: sign * ds * nd1,
    gamma: ds * density / (S * v * sqrtT),
    thetaPerDay: (-S * ds * density * v / (2 * sqrtT) - sign * r * K * dk * nd2 + sign * q * S * ds * nd1) / YEAR_DAYS,
    vegaPerPercentagePoint: S * ds * density * sqrtT * 0.01,
    rhoPerPercentagePoint: sign * K * T * dk * nd2 * 0.01,
  }, warnings: [] };
}

function crrTree(p, levels = false) {
  const { spot: S, strike: K, timeYears: T, rate: r, dividendYield: q, volatility: v, right, steps: n } = p;
  if (T === 0) return { price: intrinsic(right, S, K), levels: [] };
  if (v === 0) fail('CRR requires positive volatility; use a positive-volatility limit or an explicit deterministic exercise model');
  const dt = T / n, u = Math.exp(v * Math.sqrt(dt)), d = 1 / u, probability = (Math.exp((r - q) * dt) - d) / (u - d), discount = Math.exp(-r * dt);
  if (probability < 0 || probability > 1) fail('CRR risk-neutral probability is outside [0,1]; increase steps or revise assumptions', 'MODEL_UNSTABLE');
  const values = Array.from({ length: n + 1 }, (_, j) => intrinsic(right, S * Math.exp((2 * j - n) * Math.log(u)), K));
  const saved = [];
  for (let level = n - 1; level >= 0; level--) {
    for (let j = 0; j <= level; j++) {
      const stock = S * Math.exp((2 * j - level) * Math.log(u));
      values[j] = Math.max(intrinsic(right, stock, K), discount * (probability * values[j + 1] + (1 - probability) * values[j]));
    }
    if (levels && level <= 2) saved[level] = values.slice(0, level + 1);
  }
  return { price: values[0], levels: saved, u, d, dt };
}

/** Price one unit of underlying; rate, yield and volatility are decimals, not percentages.
 * @param {object} input Explicit model and option assumptions; CRR means American exercise and requires steps.
 * @returns {object} Model value, unit-labelled Greeks, warnings and the exact normalized assumptions.
 */
export function priceOption(input) {
  const p = optionInput(input);
  let result;
  if (p.model === 'BLACK_SCHOLES' || p.timeYears === 0) result = bs(p);
  else {
    const tree = crrTree(p, true), [low, high] = tree.levels[1], [ll, mid, hh] = tree.levels[2];
    const deltaHigh = (hh - mid) / (p.spot * (tree.u ** 2 - 1));
    const deltaLow = (mid - ll) / (p.spot * (1 - tree.d ** 2));
    const dv = Math.min(0.0001, p.volatility / 2), dr = 0.0001;
    result = { price: tree.price, greeks: {
      delta: (high - low) / (p.spot * (tree.u - tree.d)),
      gamma: (deltaHigh - deltaLow) / (p.spot * (tree.u ** 2 - tree.d ** 2) / 2),
      thetaPerDay: (mid - tree.price) / (2 * tree.dt * YEAR_DAYS),
      vegaPerPercentagePoint: (crrTree({ ...p, volatility: p.volatility + dv }).price - crrTree({ ...p, volatility: p.volatility - dv }).price) / (2 * dv) * 0.01,
      rhoPerPercentagePoint: (crrTree({ ...p, rate: p.rate + dr }).price - crrTree({ ...p, rate: p.rate - dr }).price) / (2 * dr) * 0.01,
    }, warnings: ['CRR finite lattice estimate; Greeks may vary with steps and around exercise boundaries', 'Continuous dividend yield only; discrete dividends and adjusted deliverables are not modelled'] };
  }
  if (!allFinite(result.greeks) || !Number.isFinite(result.price)) fail('Pricing became non-finite; inputs are outside the stable numerical range', 'MODEL_UNSTABLE');
  return { ...result, model: p.model, modelVersion: QUANT_VERSION, exerciseStyle: p.model === 'CRR' ? 'AMERICAN' : 'EUROPEAN', assumptions: p,
    units: { price: 'currency per underlying unit', delta: 'underlying units per option unit', gamma: 'delta per 1 currency spot change', thetaPerDay: 'currency per calendar day (annual derivative / 365)', vegaPerPercentagePoint: 'currency per 0.01 absolute IV change', rhoPerPercentagePoint: 'currency per 0.01 absolute rate change' },
    executableQuote: false };
}

/** Infer volatility using a caller-specified bracket, tolerance and iteration budget.
 * @param {object} input Pricing assumptions plus targetPrice, minVol, maxVol, tolerance and maxIterations.
 * @returns {object} Solved IV and model output, or a clear non-convergence state without invented IV.
 */
export function impliedVolatility(input) {
  const p = optionInput(input, { requireVolatility: false });
  if (p.timeYears === 0) fail('An expired option has no identifiable implied volatility', 'IV_UNIDENTIFIABLE');
  const target = number(input.targetPrice, 'targetPrice', 0, 1e9), tolerance = number(input.tolerance, 'tolerance', 1e-12, 1);
  let low = number(input.minVol, 'minVol', 1e-8, 5), high = number(input.maxVol, 'maxVol', 1e-8, 5);
  if (low >= high) fail('minVol must be less than maxVol');
  const budget = integer(input.maxIterations, 'maxIterations', 1, 200);
  checkLatticeBudget(p, budget + 8); // Bracket, inclusive solver loop and final five-tree Greeks.
  const value = vol => p.model === 'BLACK_SCHOLES' ? bs({ ...p, volatility: vol }).price : crrTree({ ...p, volatility: vol }).price;
  let lowValue = value(low), highValue = value(high);
  if (target < lowValue - tolerance || target > highValue + tolerance) fail('targetPrice is outside the attainable prices of the requested volatility bracket', 'IV_NOT_BRACKETED');
  for (let iteration = 0; iteration <= budget; iteration++) {
    const vol = iteration === 0 && Math.abs(lowValue - target) <= tolerance ? low : iteration === 0 && Math.abs(highValue - target) <= tolerance ? high : (low + high) / 2;
    const modelPrice = value(vol), error = modelPrice - target;
    if (Math.abs(error) <= tolerance) return { volatility: vol, converged: true, iterations: iteration, absolutePriceError: Math.abs(error), ...priceOption({ ...p, volatility: vol }) };
    if (iteration === budget) return { volatility: null, converged: false, iterations: iteration, absolutePriceError: Math.abs(error), bracket: [low, high], reason: 'ITERATION_LIMIT', executableQuote: false };
    if (error < 0) { low = vol; lowValue = modelPrice; } else { high = vol; highValue = modelPrice; }
  }
}

/** Reprice user-defined shocks without modifying positions or projecting deterministic market outcomes.
 * @param {object} input option, shocks, signedContracts and a verified multiplier.
 * @returns {object} Base model value and signed hypothetical position changes.
 */
export function optionScenario(input) {
  obj(input, 'scenario');
  const p = optionInput(input.option), contracts = integer(input.signedContracts, 'signedContracts', -1000000, 1000000), multiplier = integer(input.multiplier, 'multiplier', 1, 1000000);
  const shocks = list(input.shocks, 'shocks', 100);
  checkLatticeBudget(p, (shocks.length + 1) * 5);
  const base = priceOption(p), rows = shocks.map((shock, index) => {
    obj(shock, `shocks[${index}]`);
    const spotChangePct = number(shock.spotChangePct, 'spotChangePct', -0.999999, 100), volatilityChange = number(shock.volatilityChange, 'volatilityChange', -5, 5), daysElapsed = number(shock.daysElapsed, 'daysElapsed', 0, 18250);
    const result = priceOption({ ...p, spot: p.spot * (1 + spotChangePct), volatility: p.volatility + volatilityChange, timeYears: Math.max(0, p.timeYears - daysElapsed / YEAR_DAYS) });
    return { shock: { spotChangePct, volatilityChange, daysElapsed }, price: result.price, positionValue: result.price * contracts * multiplier, pnl: (result.price - base.price) * contracts * multiplier, greeks: result.greeks, warnings: result.warnings };
  });
  return { base, signedContracts: contracts, multiplier, basePositionValue: base.price * contracts * multiplier, rows, units: 'hypothetical currency amounts; no cash flow or ledger entry', executableQuote: false };
}

const SCALE = 1000000n;
function fixed(value, name, { signed = false } = {}) {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^-?\d+(?:\.\d{1,6})?$/.test(String(value))) fail(`${name} must be a decimal with at most six places`);
  const s = String(value), negative = s.startsWith('-'), [whole, fraction = ''] = s.replace(/^-/, '').split('.');
  let n = BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
  if (negative) n = -n;
  if ((!signed && n < 0) || n > 1000000000000n * SCALE || n < -1000000000000n * SCALE) fail(`${name} is outside its supported range`);
  return n;
}
function decimal(n, scale = SCALE) {
  const negative = n < 0n, abs = negative ? -n : n, places = scale.toString().length - 1;
  const fraction = (abs % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${abs / scale}${fraction ? `.${fraction}` : ''}`;
}
const ratio = (n, denominator) => denominator === 0n ? null : decimal(n * 1000000000000n / denominator, 1000000000000n);

function uniqueRows(rows, name) {
  if (rows === undefined || rows === null) return null;
  const byId = new Map();
  for (const row of list(rows, name)) {
    obj(row, name); text(row.id, `${name}.id`);
    if (byId.has(row.id) && JSON.stringify(byId.get(row.id)) !== JSON.stringify(row)) fail(`${name}: the same id contains conflicting records`, 'DUPLICATE_CONFLICT');
    byId.set(row.id, row);
  }
  return [...byId.values()];
}

/** Evaluate a complete proposed set against the confirmed pre-trade ledger using exact scaled integers.
 * @param {object} input Symbol-scoped ledger, gross settled cash, existing obligations/reservations, candidates and explicit quality/risk checks.
 * @returns {object} ALLOW/BLOCK/MANUAL_REVIEW, per-check evidence and exact decimal amounts; never order authorization.
 */
export function analyzeWheel(input) {
  obj(input, 'wheel');
  const strategy = choice(input.strategy, ['CC', 'CSP'], 'strategy'), symbol = text(input.symbol, 'symbol'), currency = text(input.currency, 'currency', 8);
  const checks = {}, blockingReasons = [], reviewReasons = [];
  const check = (name, state, reason) => {
    checks[name] = state;
    if (state === 'FAIL') blockingReasons.push(reason);
    if (state === 'UNKNOWN') reviewReasons.push(reason);
  };
  const confirm = (name, value, unknownReason, failureReason) => {
    if (value === true || value === 'PASS') check(name, 'PASS');
    else if (value === false || value === 'FAIL') check(name, 'FAIL', failureReason);
    else if (value === undefined || value === null || value === 'UNKNOWN') check(name, 'UNKNOWN', unknownReason);
    else fail(`${name} must be true/false or PASS/FAIL/UNKNOWN`);
  };
  const p = input.position === undefined || input.position === null ? {} : obj(input.position, 'position');
  const q = optional(p.shares, x => fixed(x, 'position.shares'));
  const nominal = optional(p.nominalCost, x => fixed(x, 'position.nominalCost'));
  const premium = optional(p.netPremium, x => fixed(x, 'position.netPremium', { signed: true }));
  const actualNumerator = nominal !== null && premium !== null ? nominal - premium : null;
  if (q === 0n && nominal !== null && nominal !== 0n) fail('A zero-share position cannot have remaining nominal cost');
  const candidates = uniqueRows(input.candidates, 'candidates');
  if (!candidates?.length) check('candidate_set', 'UNKNOWN', 'No complete proposed candidate set was supplied');
  const existing = uniqueRows(input.existingObligations, 'existingObligations');
  const reservations = uniqueRows(input.stockReservations, 'stockReservations');
  if (existing === null) check('existing_obligations', 'UNKNOWN', 'Existing obligations are unknown; provide an explicitly complete list');
  if (strategy === 'CC' && reservations === null) check('stock_reservations', 'UNKNOWN', 'Other stock-sale reservations are unknown');
  const seen = new Set();
  function contract(row, proposed) {
    if (seen.has(row.id)) fail('An obligation/reservation id occurs in more than one input collection', 'DUPLICATE_CONFLICT');
    seen.add(row.id);
    const kind = choice(row.strategy, ['CC', 'CSP'], 'obligation.strategy'), underlying = text(row.symbol, 'obligation.symbol');
    if (proposed && (kind !== strategy || underlying !== symbol)) fail('All proposed candidates must match the requested strategy and symbol');
    const contracts = optional(row.contracts, x => BigInt(integer(x, 'contracts', 1, 1000000)));
    const multiplier = optional(row.multiplier, x => BigInt(integer(x, 'multiplier', 1, 1000000)));
    const strike = optional(row.strike, x => fixed(x, 'strike'));
    if (strike === 0n) fail('strike must be positive');
    if (contracts === null || multiplier === null || strike === null || !row.currency) check(`contract:${row.id}`, 'UNKNOWN', `Contract ${row.id} has missing quantity, multiplier, strike or currency`);
    else if (row.currency !== currency) check(`currency:${row.id}`, 'UNKNOWN', `Contract ${row.id} uses another currency; automatic FX coverage is not defined`);
    if (proposed && row.standardDeliverableVerified !== true) check(`deliverable:${row.id}`, 'UNKNOWN', `Contract ${row.id} standard stock deliverable is not verified`);
    return { id: row.id, kind, underlying, shares: contracts !== null && multiplier !== null ? contracts * multiplier * SCALE : null, strike, compatibleCurrency: row.currency === currency, proposed };
  }
  const current = (existing ?? []).map(row => contract(row, false)), proposed = (candidates ?? []).map(row => contract(row, true));
  let reservedShares = 0n, proposedShares = 0n, shareInputsKnown = existing !== null && reservations !== null;
  for (const row of current.filter(x => x.kind === 'CC' && x.underlying === symbol)) {
    if (row.shares === null) shareInputsKnown = false; else reservedShares += row.shares;
  }
  for (const row of reservations ?? []) {
    if (seen.has(row.id)) fail('Reservation duplicates an option obligation id; identify the underlying resource once', 'DUPLICATE_CONFLICT');
    seen.add(row.id); text(row.symbol, 'stockReservation.symbol');
    const shares = optional(row.shares, x => fixed(x, 'stockReservation.shares'));
    if (row.symbol === symbol) { if (shares === null) shareInputsKnown = false; else reservedShares += shares; }
  }
  for (const row of proposed.filter(x => x.kind === 'CC')) { if (row.shares === null) shareInputsKnown = false; else proposedShares += row.shares; }
  let cashDemand = 0n, cashInputsKnown = existing !== null && !!candidates?.length;
  for (const row of [...current, ...proposed].filter(x => x.kind === 'CSP')) {
    if (row.shares === null || row.strike === null || !row.compatibleCurrency) cashInputsKnown = false;
    else cashDemand += row.shares / SCALE * row.strike;
  }
  const cash = input.cash === undefined || input.cash === null ? {} : obj(input.cash, 'cash');
  const cashAmount = optional(cash.amount, x => fixed(x, 'cash.amount'));
  const buffer = optional(input.cashBuffer, x => fixed(x, 'cashBuffer'));
  const fees = optional(input.estimatedFees, x => fixed(x, 'estimatedFees'));
  let remainingCash = null;
  if (strategy === 'CC') {
    if (q === null || actualNumerator === null || p.confirmed !== true || q === 0n) check('cc_cost', 'UNKNOWN', 'Confirmed positive shares, nominal cost and cumulative premium are required');
    else {
      const violations = proposed.filter(x => x.strike !== null && x.strike * q <= actualNumerator * SCALE);
      if (violations.length) check('cc_cost', 'FAIL', `CC strike must be strictly greater than pre-trade strategy cost: ${violations.map(x => x.id).join(', ')}`);
      else if (!proposed.length || proposed.some(x => x.strike === null)) check('cc_cost', 'UNKNOWN', 'Candidate strikes are incomplete');
      else check('cc_cost', 'PASS');
    }
    if (q === null || !shareInputsKnown || p.confirmed !== true || !proposed.length) check('cc_share_coverage', 'UNKNOWN', 'Verified shares and all current/proposed reservations are required');
    else check('cc_share_coverage', reservedShares + proposedShares <= q ? 'PASS' : 'FAIL', 'Existing and proposed covered calls and stock-sale reservations exceed confirmed shares');
    checks.csp_cash_coverage = 'NOT_APPLICABLE';
  } else {
    checks.cc_cost = 'NOT_APPLICABLE'; checks.cc_share_coverage = 'NOT_APPLICABLE';
    if (!cashInputsKnown || cashAmount === null || buffer === null || fees === null || cash.confirmed !== true || cash.basis !== 'GROSS_SETTLED') check('csp_cash_coverage', 'UNKNOWN', 'Gross settled cash before obligation reserves, complete obligations, fees and explicit buffer are required');
    else {
      remainingCash = cashAmount - cashDemand - buffer - fees;
      check('csp_cash_coverage', remainingCash >= 0n ? 'PASS' : 'FAIL', 'Cash cannot cover all existing and proposed CSP assignments plus fees and buffer');
    }
  }
  const quality = obj(input.dataQuality ?? {}, 'dataQuality'), risks = obj(input.riskChecks ?? {}, 'riskChecks');
  for (const key of ['fresh', 'reconciled', 'complete']) {
    if (quality[key] === true) check(`data_${key}`, 'PASS');
    else check(`data_${key}`, 'UNKNOWN', `Data quality ${key} is not verified`);
  }
  confirm('assignment_willingness', risks.willingToTakeAssignment, 'Assignment willingness is not confirmed', 'The proposed assignment is not acceptable to the user');
  if (strategy === 'CC') {
    if (risks.batchPolicyConfirmed === true) check('batch_policy', 'PASS');
    else check('batch_policy', 'UNKNOWN', 'Assigned-lot cost/matching and any batch-specific threshold policy are not confirmed');
  } else checks.batch_policy = 'NOT_APPLICABLE';
  for (const key of ['liquidity', 'eventRisk', 'concentration']) confirm(`risk_${key}`, risks[key], `${key} has not been checked against explicit policy`, `${key} failed the configured policy`);
  return { ruleVersion: 'consolidated-2026-11-21', calculationVersion: QUANT_VERSION, strategy, symbol, currency,
    decision: blockingReasons.length ? 'BLOCK' : reviewReasons.length ? 'MANUAL_REVIEW' : 'ALLOW', checks, blockingReasons, reviewReasons,
    position: { shares: q === null ? null : decimal(q), nominalCost: nominal === null ? null : decimal(nominal), netPremium: premium === null ? null : decimal(premium), actualCostPerShare: q !== null && q > 0n && actualNumerator !== null ? ratio(actualNumerator, q) : null, reservedShares: shareInputsKnown ? decimal(reservedShares) : null, proposedShares: shareInputsKnown ? decimal(proposedShares) : null, availableShares: q !== null && shareInputsKnown ? decimal(q - reservedShares) : null },
    cashCoverage: { basis: cash.basis ?? null, cash: cashAmount === null ? null : decimal(cashAmount), assignmentDemand: cashInputsKnown ? decimal(cashDemand) : null, buffer: buffer === null ? null : decimal(buffer), fees: fees === null ? null : decimal(fees), remaining: remainingCash === null ? null : decimal(remainingCash) },
    orderSubmissionEnabled: false, requiresHumanApproval: true, scope: 'Candidate analysis only; expected future premiums are excluded from current cost and cash' };
}

/** Aggregate signed positions without confusing options contracts, underlying units or currencies.
 * @param {object} input Currency, cash and positions with explicit prices, option multipliers and per-unit Greeks.
 * @returns {object} Exposure and underlying-grouped Greeks; a missing component makes the relevant total unknown.
 */
export function portfolioRisk(input) {
  obj(input, 'portfolio');
  const currency = text(input.currency, 'currency', 8), cash = number(input.cash, 'cash');
  const positions = list(input.positions, 'positions', 1000), bySymbol = Object.create(null), bySector = Object.create(null), missing = [];
  let netValue = 0, grossValue = 0, netDollarDelta = 0, dollarDeltaKnown = true, valuationKnown = true;
  const ids = new Set();
  const keys = ['delta', 'gamma', 'thetaPerDay', 'vegaPerPercentagePoint', 'rhoPerPercentagePoint'];
  const rows = positions.map((raw, index) => {
    obj(raw, `positions[${index}]`); const id = text(raw.id, 'position.id'), symbol = text(raw.symbol, 'position.symbol'), assetClass = choice(raw.assetClass, ['STOCK', 'OPTION'], 'assetClass');
    if (ids.has(id)) fail('Duplicate position id', 'DUPLICATE_CONFLICT'); ids.add(id);
    if (raw.currency !== undefined && raw.currency !== currency) fail('Cross-currency risk must be evaluated separately; supply validated FX conversions explicitly');
    const quantity = assetClass === 'OPTION' ? integer(raw.signedQuantity, 'signedQuantity', -1000000, 1000000) : number(raw.signedQuantity, 'signedQuantity');
    const multiplier = assetClass === 'STOCK' ? 1 : number(raw.multiplier, 'multiplier', 1e-8, 1000000);
    const price = optional(raw.price, x => number(x, 'price', 0, 1e9));
    const value = price === null ? null : price * quantity * multiplier;
    if (value === null) { valuationKnown = false; missing.push(`${id}: price`); } else { netValue += value; grossValue += Math.abs(value); }
    const sector = typeof raw.sector === 'string' && raw.sector ? raw.sector : 'UNKNOWN';
    bySector[sector] = (bySector[sector] ?? 0) + (value === null ? 0 : Math.abs(value));
    const greeks = assetClass === 'STOCK' ? { delta: 1, gamma: 0, thetaPerDay: 0, vegaPerPercentagePoint: 0, rhoPerPercentagePoint: 0 } : raw.greeks ?? {};
    bySymbol[symbol] ??= Object.fromEntries(keys.map(key => [key, 0]));
    const signed = {};
    for (const key of keys) {
      const greek = optional(greeks[key], x => number(x, key));
      signed[key] = greek === null ? null : greek * quantity * multiplier;
      if (greek === null) { bySymbol[symbol][key] = null; missing.push(`${id}: ${key}`); }
      else if (bySymbol[symbol][key] !== null) bySymbol[symbol][key] += signed[key];
    }
    const underlyingSpot = assetClass === 'STOCK' ? price : optional(raw.underlyingSpot, x => number(x, 'underlyingSpot', 1e-8, 1e9));
    if (underlyingSpot === null || signed.delta === null) {
      dollarDeltaKnown = false;
      if (underlyingSpot === null) missing.push(`${id}: underlyingSpot`);
    }
    else netDollarDelta += signed.delta * underlyingSpot;
    return { id, symbol, sector, assetClass, signedQuantity: quantity, multiplier, marketValue: value, greeks: signed };
  });
  return { currency, cash, netMarketValue: valuationKnown ? netValue : null, equity: valuationKnown ? cash + netValue : null, grossMarketValue: valuationKnown ? grossValue : null, netDollarDelta: dollarDeltaKnown ? netDollarDelta : null, greeksByUnderlying: bySymbol,
    sectorGrossWeights: valuationKnown && grossValue > 0 ? Object.fromEntries(Object.entries(bySector).map(([k, v]) => [k, v / grossValue])) : null,
    rows, missing, complete: missing.length === 0 && dollarDeltaKnown, units: { greeks: 'Signed contracts × verified multiplier × per-unit option Greeks, grouped by underlying', netDollarDelta: 'currency exposure for a 100% relative underlying move; first-order only', sectorGrossWeights: 'fraction of gross absolute marked position value, excludes cash' }, calculationVersion: QUANT_VERSION };
}

function curveMetrics(curve, initialCapital, periodsPerYear, annualRiskFreeRate) {
  const returns = curve.slice(1).map((row, index) => row.equity / curve[index].equity - 1), n = returns.length;
  const mean = returns.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : null;
  const dailyRf = (1 + annualRiskFreeRate) ** (1 / periodsPerYear) - 1;
  const years = (Date.parse(curve.at(-1).date) - Date.parse(curve[0].date)) / (365.25 * 86400000);
  let peak = initialCapital, drawdown = 0;
  for (const row of curve) { peak = Math.max(peak, row.equity); drawdown = Math.min(drawdown, row.equity / peak - 1); }
  return { initialCapital, finalValue: curve.at(-1).equity, totalReturn: curve.at(-1).equity / initialCapital - 1, cagr: years > 0 ? (curve.at(-1).equity / initialCapital) ** (1 / years) - 1 : null,
    maxDrawdown: drawdown, annualizedVolatility: variance === null ? null : Math.sqrt(variance * periodsPerYear), sharpe: variance !== null && variance > 1e-24 ? (mean - dailyRf) / Math.sqrt(variance) * Math.sqrt(periodsPerYear) : null, observations: curve.length, elapsedYears: years };
}

/** Backtest supplied aligned total-return price series; no downloads, forward-fill or hidden model costs.
 * @param {object} input Explicit weights, data frequency, cost/risk-free assumptions and aligned date/adjustedClose arrays.
 * @returns {object} Daily or annual equity, rebalancing trades, costs, benchmark and reproducible metrics.
 */
export function backtestPortfolio(input) {
  obj(input, 'backtest');
  choice(input.seriesKind, ['ADJUSTED_TOTAL_RETURN'], 'seriesKind');
  const frequency = choice(input.dataFrequency, ['DAILY', 'ANNUAL'], 'dataFrequency'), rebalance = choice(input.rebalance, ['MONTHLY', 'ANNUAL', 'NONE'], 'rebalance');
  if (rebalance === 'MONTHLY' && frequency !== 'DAILY') fail('Monthly rebalancing requires daily observations, not annual approximation', 'INSUFFICIENT_HISTORY');
  const initialCapital = number(input.initialCapital, 'initialCapital', 0.01, 1e12), costBps = number(input.costBps, 'costBps', 0, 1000), annualRiskFreeRate = number(input.annualRiskFreeRate, 'annualRiskFreeRate', -0.99, 2), periodsPerYear = number(input.periodsPerYear, 'periodsPerYear', 1, 366);
  if (frequency === 'ANNUAL' && periodsPerYear !== 1) fail('Annual observations require periodsPerYear=1');
  obj(input.weights, 'weights'); obj(input.series, 'series');
  const symbols = Object.keys(input.weights);
  if (!symbols.length || symbols.length > 50) fail('Provide 1–50 portfolio weights');
  const weights = Object.fromEntries(symbols.map(symbol => [text(symbol, 'symbol'), number(input.weights[symbol], `weights.${symbol}`, 0, 1)]));
  const sumWeights = Object.values(weights).reduce((sum, value) => sum + value, 0);
  if (sumWeights <= 0 || sumWeights > 1 + 1e-12) fail('Long-only portfolio weights must sum to (0, 1]; the rest is explicit uninvested cash');
  const benchmark = input.benchmarkSymbol === undefined || input.benchmarkSymbol === null ? null : text(input.benchmarkSymbol, 'benchmarkSymbol');
  const required = [...new Set([...symbols, ...(benchmark ? [benchmark] : [])])], data = {};
  for (const symbol of required) {
    data[symbol] = list(input.series[symbol], `series.${symbol}`, 10000).map((row, index) => ({ date: date(row.date, `series.${symbol}[${index}].date`), adjustedClose: number(row.adjustedClose, 'adjustedClose', 1e-8, 1e9) }));
    if (data[symbol].length < 2) fail('At least two observations are required', 'INSUFFICIENT_HISTORY');
    for (let index = 1; index < data[symbol].length; index++) if (data[symbol][index].date <= data[symbol][index - 1].date) fail('Dates must be strictly increasing and unique', 'INVALID_HISTORY');
  }
  const dates = data[required[0]].map(row => row.date);
  for (const symbol of required) if (data[symbol].length !== dates.length || data[symbol].some((row, index) => row.date !== dates[index])) fail(`Missing or unaligned observations for ${symbol}; no forward-fill is performed`, 'INVALID_HISTORY');
  if (input.expectedDates !== undefined && JSON.stringify(input.expectedDates) !== JSON.stringify(dates)) fail('Price dates do not match the supplied trading calendar', 'INVALID_HISTORY');
  if (frequency === 'DAILY') {
    for (let index = 1; index < dates.length; index++) if ((Date.parse(dates[index]) - Date.parse(dates[index - 1])) / 86400000 > 10) fail('Daily data has a gap longer than ten calendar days; verify the trading calendar and history coverage', 'INSUFFICIENT_HISTORY');
  }
  const rate = costBps / 10000, holdings = Object.fromEntries(symbols.map(symbol => [symbol, 0]));
  let cash = initialCapital, totalCosts = 0;
  const trades = [], curve = [];
  function rebalanceAt(index) {
    const currentValues = Object.fromEntries(symbols.map(symbol => [symbol, holdings[symbol] * data[symbol][index].adjustedClose]));
    const equity = cash + Object.values(currentValues).reduce((sum, value) => sum + value, 0);
    let low = 0, high = equity;
    for (let iteration = 0; iteration < 60; iteration++) {
      const after = (low + high) / 2, costs = symbols.reduce((sum, symbol) => sum + Math.abs(after * weights[symbol] - currentValues[symbol]) * rate, 0);
      if (after + costs > equity) high = after; else low = after;
    }
    const investable = (low + high) / 2;
    let costs = 0, invested = 0;
    for (const symbol of symbols) {
      const target = investable * weights[symbol], change = target - currentValues[symbol], price = data[symbol][index].adjustedClose, fee = Math.abs(change) * rate;
      holdings[symbol] = target / price; costs += fee; invested += target;
      if (Math.abs(change) > 1e-8) trades.push({ date: dates[index], symbol, notional: change, adjustedUnits: change / price, fee, reason: index === 0 ? 'INITIAL_ALLOCATION' : rebalance });
    }
    cash = equity - costs - invested; totalCosts += costs;
  }
  for (let index = 0; index < dates.length; index++) {
    const nextDate = dates[index + 1];
    const boundary = nextDate && (rebalance === 'MONTHLY' && dates[index].slice(0, 7) !== nextDate.slice(0, 7) || rebalance === 'ANNUAL' && dates[index].slice(0, 4) !== nextDate.slice(0, 4));
    if (index === 0 || boundary) rebalanceAt(index);
    const equity = cash + symbols.reduce((sum, symbol) => sum + holdings[symbol] * data[symbol][index].adjustedClose, 0);
    if (!Number.isFinite(equity) || equity <= 0) fail('Backtest became non-finite or depleted; input magnitude exceeds the supported range', 'MODEL_UNSTABLE');
    curve.push({ date: dates[index], equity, cash });
  }
  let benchmarkResult = null;
  if (benchmark) {
    const invested = initialCapital / (1 + rate), benchmarkCurve = dates.map((d, index) => ({ date: d, equity: invested * data[benchmark][index].adjustedClose / data[benchmark][0].adjustedClose }));
    benchmarkResult = { symbol: benchmark, equityCurve: benchmarkCurve, metrics: curveMetrics(benchmarkCurve, initialCapital, periodsPerYear, annualRiskFreeRate), totalCosts: initialCapital - invested };
  }
  return { calculationVersion: QUANT_VERSION, metrics: curveMetrics(curve, initialCapital, periodsPerYear, annualRiskFreeRate), equityCurve: curve, trades, totalCosts, benchmark: benchmarkResult,
    assumptions: { weights, rebalance, frequency, seriesKind: input.seriesKind, costBps, annualRiskFreeRate, periodsPerYear, cashAnnualYield: 0, executionTiming: 'Initial allocation at first supplied close; rebalance at last supplied close before a month/year boundary, holdings apply only to subsequent returns', dividends: 'Already embedded in adjusted total-return prices; never paid twice', costs: 'Proportional cost on absolute traded asset notional, including initial allocation; no forced terminal liquidation', sharpe: 'Sample standard deviation of subsequent observation returns, geometric per-period risk-free rate; initial allocation cost affects total return, not a standalone Sharpe observation', cagr: 'Actual elapsed calendar days / 365.25', units: 'Adjusted synthetic units, not executable share quantities', calendarVerification: input.expectedDates ? 'Matched caller-supplied expected dates' : 'Cross-asset alignment only; full exchange-calendar coverage unverified', taxes: 'Not modelled', dataSource: 'Caller-supplied; no claim of independently verified historical prices' }, warnings: frequency === 'ANNUAL' ? ['Annual approximation cannot establish intrayear drawdown or monthly-rebalanced performance'] : [] };
}

/** Screen known option fields under caller-configured thresholds; missing data is never treated as zero.
 * @param {object} input candidates, explicit criteria and output limit.
 * @returns {object} Ranked survivors, rejected contracts, unknown-field review and no execution authorization.
 */
export function rankOptions(input) {
  obj(input, 'screen'); const criteria = obj(input.criteria, 'criteria'), limit = integer(input.limit, 'limit', 1, 100);
  const rules = { minAbsDelta: number(criteria.minAbsDelta, 'minAbsDelta', 0, 1), maxAbsDelta: number(criteria.maxAbsDelta, 'maxAbsDelta', 0, 1), maxRelativeSpread: number(criteria.maxRelativeSpread, 'maxRelativeSpread', 0, 2), minOpenInterest: number(criteria.minOpenInterest, 'minOpenInterest', 0, 1e12), minVolume: number(criteria.minVolume, 'minVolume', 0, 1e12) };
  if (rules.minAbsDelta > rules.maxAbsDelta) fail('Delta interval is inverted');
  const accepted = [], rejected = [], review = [];
  for (const row of uniqueRows(input.candidates, 'candidates') ?? []) {
    const missing = ['bid', 'ask', 'delta', 'openInterest', 'volume'].filter(key => row[key] === null || row[key] === undefined);
    if (missing.length) { review.push({ id: row.id, missing }); continue; }
    const bid = number(row.bid, 'bid', 0, 1e9), ask = number(row.ask, 'ask', 0, 1e9), delta = number(row.delta, 'delta', -1, 1), oi = number(row.openInterest, 'openInterest', 0, 1e12), volume = number(row.volume, 'volume', 0, 1e12);
    const reasons = [], mid = (bid + ask) / 2, relativeSpread = mid > 0 ? (ask - bid) / mid : null;
    if (ask < bid) reasons.push('CROSSED_QUOTE');
    if (mid <= 0) reasons.push('NO_POSITIVE_QUOTE');
    if (Math.abs(delta) < rules.minAbsDelta || Math.abs(delta) > rules.maxAbsDelta) reasons.push('DELTA_OUTSIDE_INTERVAL');
    if (relativeSpread !== null && relativeSpread > rules.maxRelativeSpread) reasons.push('SPREAD_TOO_WIDE');
    if (oi < rules.minOpenInterest) reasons.push('OPEN_INTEREST_TOO_LOW');
    if (volume < rules.minVolume) reasons.push('VOLUME_TOO_LOW');
    if (reasons.length) rejected.push({ id: row.id, reasons }); else accepted.push({ ...row, mid, relativeSpread });
  }
  accepted.sort((a, b) => a.relativeSpread - b.relativeSpread || Number(b.openInterest) - Number(a.openInterest) || a.id.localeCompare(b.id));
  return { ranked: accepted.slice(0, limit), eligibleCount: accepted.length, rejected, review, criteria: rules, ranking: 'Narrowest relative spread, then highest open interest; not a return prediction or full Wheel decision', orderSubmissionEnabled: false };
}
