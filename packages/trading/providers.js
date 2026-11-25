/** Bounded read-only market and brokerage transports; credentials never enter result data. */
const OPERATIONS = Object.freeze([
  'market.quote', 'market.history', 'market.news', 'market.profile', 'market.financials',
  'market.analysts', 'market.screen', 'market.earnings', 'market.options',
  'broker.accounts', 'broker.snapshot', 'predict.markets', 'predict.detail',
]);
const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Structured provider failure with no upstream body, credential, account or URL in its message. */
export class ProviderError extends Error {
  constructor(code, message, status = 400) {
    super(message); this.name = 'ProviderError'; this.code = code; this.status = status;
  }
}
const reject = (code, message, status) => { throw new ProviderError(code, message, status); };
function object(value, label) { if (!OBJECT(value)) reject('INVALID_INPUT', `${label} must be an object`); return value; }
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) reject('INVALID_INPUT', `${label} is outside its allowed range`);
  return value;
}
function string(value, label, pattern, max = 200) {
  if (typeof value !== 'string' || value.length > max || !pattern.test(value)) reject('INVALID_INPUT', `${label} is invalid`);
  return value;
}
function symbol(value) { return string(value, 'symbol', /^[A-Z0-9][A-Z0-9.\-^/]{0,23}$/i, 24).toUpperCase(); }
function day(value, label) {
  string(value, label, /^\d{4}-\d{2}-\d{2}$/, 10);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) reject('INVALID_INPUT', `${label} is not a calendar date`);
  return value;
}
function range(args, required = false) {
  if (required && (!args.from || !args.to)) reject('INVALID_INPUT', 'from and to are required');
  const result = {};
  if (args.from !== undefined) result.from = day(args.from, 'from');
  if (args.to !== undefined) result.to = day(args.to, 'to');
  if (result.from && result.to && result.from > result.to) reject('INVALID_INPUT', 'from must not follow to');
  return result;
}
function enumOf(value, label, values) {
  if (!values.includes(value)) reject('INVALID_INPUT', `${label} must be one of ${values.join(', ')}`);
  return value;
}
function decimal(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || !Number.isFinite(Number(value))) return null;
  return String(value);
}
function probability(value) {
  const result = decimal(value);
  if (result !== null && (Number(result) < 0 || Number(result) > 1)) reject('UPSTREAM_SCHEMA', 'Prediction payout price is outside zero to one', 502);
  return result;
}
function instant(value) {
  if (value === null || value === undefined || value === '') return null;
  const input = typeof value === 'number' ? value * (value < 1e11 ? 1000 : 1) : value;
  if (typeof input === 'string' && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(input)) return null;
  if (typeof input === 'number' && (!Number.isFinite(input) || Math.abs(input) > 8.64e15)) return null;
  const parsed = Date.parse(typeof input === 'number' ? new Date(input).toISOString() : input);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
function rows(value) { if (!Array.isArray(value) || value.some(row => !OBJECT(row))) reject('UPSTREAM_SCHEMA', 'Provider returned an unexpected row format', 502); return value; }
function upstreamObject(value) { if (!OBJECT(value)) reject('UPSTREAM_SCHEMA', 'Provider returned an unexpected object format', 502); return value; }
function latest(values) { const valid = values.filter(Boolean).sort(); return valid.length ? valid.at(-1) : null; }
function safeUrl(value) {
  if (typeof value !== 'string') return null;
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; }
  catch (error) { return null; /* Provider-supplied invalid links are omitted, never navigated. */ }
}
function scrub(value) {
  if (Array.isArray(value)) return value.map(scrub);
  if (!OBJECT(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/secret|password|token|api.?key|authorization|cookie/i.test(key)).map(([key, item]) => [key, scrub(item)]));
}
function redactCredentials(value, secrets) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) {
      if (!secret) continue;
      result = result.replaceAll(secret, '[REDACTED]').replaceAll(encodeURIComponent(secret), '[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(item => redactCredentials(item, secrets));
  if (OBJECT(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactCredentials(item, secrets)]));
  return value;
}
function envName(value, label) { return string(value, label, /^[A-Z_][A-Z0-9_]{0,100}$/, 101); }
function resolveConfig(input) {
  object(input, 'config');
  const supplied = object(input.limits ?? {}, 'limits');
  const limits = {
    timeoutMs: supplied.timeoutMs ?? 15000, maxBytes: supplied.maxBytes ?? 2 * 1024 * 1024,
    maxItems: supplied.maxItems ?? 100, maxPages: supplied.maxPages ?? 5, minIntervalMs: supplied.minIntervalMs ?? 250,
  };
  integer(limits.timeoutMs, 'timeoutMs', 1, 60000); integer(limits.maxBytes, 'maxBytes', 256, 16 * 1024 * 1024);
  integer(limits.maxItems, 'maxItems', 1, 5000); integer(limits.maxPages, 'maxPages', 1, 100); integer(limits.minIntervalMs, 'minIntervalMs', 0, 60000);
  const result = { mode: enumOf(input.mode ?? 'live', 'mode', ['live', 'synthetic']), limits, fixtures: input.fixtures ?? {} };
  if (input.fmp) result.fmp = { apiKeyEnv: envName(object(input.fmp, 'fmp').apiKeyEnv, 'fmp.apiKeyEnv') };
  if (input.alpaca) {
    object(input.alpaca, 'alpaca');
    result.alpaca = { keyEnv: envName(input.alpaca.keyEnv, 'alpaca.keyEnv'), secretEnv: envName(input.alpaca.secretEnv, 'alpaca.secretEnv'), feed: enumOf(input.alpaca.feed, 'alpaca.feed', ['opra', 'indicative']) };
  }
  if (input.ibkr) {
    object(input.ibkr, 'ibkr');
    let url;
    try { url = new URL(input.ibkr.baseUrl); } catch (error) { reject('INVALID_CONFIG', 'ibkr.baseUrl must be a loopback URL'); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, '') !== '/v1/api') reject('INVALID_CONFIG', 'IBKR gateway must use a loopback /v1/api URL without credentials or query');
    if (!Array.isArray(input.ibkr.accountIds) || !input.ibkr.accountIds.length) reject('INVALID_CONFIG', 'IBKR requires an explicit nonempty account allowlist');
    result.ibkr = { baseUrl: url.href.replace(/\/$/, ''), accountIds: [...new Set(input.ibkr.accountIds.map(id => string(id, 'accountId', /^[A-Za-z0-9-]{1,40}$/, 40)))] };
  }
  if (input.predict) { object(input.predict, 'predict'); if (typeof input.predict.enabled !== 'boolean') reject('INVALID_CONFIG', 'predict.enabled must be boolean'); result.predict = { enabled: input.predict.enabled }; }
  return result;
}
function envelope(source, data, { asOf = null, mode = 'live', missing = [], ...extra } = {}) {
  return { source, asOf, receivedAt: new Date().toISOString(), mode, data, missing, ...extra };
}

/** Resolve deployment settings once; request inputs cannot replace hosts, credentials or account scope.
 * @param {object} config Provider choices, environment-variable references, request limits and optional fixtures.
 * @param {object} dependencies Transport and environment injection for deterministic tests.
 * @returns {{request: Function, capabilities: Function}} Fixed read-only operation dispatcher.
 */
export function createProviders(config = {}, { fetchImpl = fetch, env = process.env } = {}) {
  const settings = resolveConfig(config);
  const lastStarted = new Map();
  const pending = new Map();
  const cancelled = signal => new Promise(resolve => {
    if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true });
  });
  const key = reference => {
    const value = env[reference];
    if (typeof value !== 'string' || !value.trim()) reject('UNCONFIGURED', 'Provider credential is not configured', 503);
    return value;
  };
  const count = args => integer(args.limit ?? Math.min(20, settings.limits.maxItems), 'limit', 1, settings.limits.maxItems);
  const token = value => string(value, 'cursor', /^[\w+=/.:~-]{1,2000}$/, 2000);

  async function get(source, path, params = {}, headers = {}, signal) {
    const bases = { fmp: 'https://financialmodelingprep.com/stable', alpaca: 'https://data.alpaca.markets/v1beta1', kalshi: 'https://external-api.kalshi.com/trade-api/v2', polymarket: 'https://gamma-api.polymarket.com', ibkr: settings.ibkr?.baseUrl };
    if (!bases[source]) reject('UNCONFIGURED', 'Provider is not configured', 503);
    const url = new URL(bases[source] + path);
    for (const [name, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(name, String(value));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), settings.limits.timeoutMs);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const predecessor = pending.get(source) ?? Promise.resolve();
    let release; const slot = new Promise(resolve => { release = resolve; });
    const queueTail = predecessor.then(() => slot); pending.set(source, queueTail);
    queueTail.then(() => { if (pending.get(source) === queueTail) pending.delete(source); });
    try {
      await Promise.race([predecessor, cancelled(controller.signal)]);
      if (controller.signal.aborted) reject(signal?.aborted ? 'ABORTED' : 'TIMEOUT', 'Provider request was cancelled or timed out', 504);
      const limitedIbkr = source === 'ibkr' && ['/portfolio/accounts', '/iserver/account/orders', '/iserver/account/trades'].includes(path);
      const interval = source === 'ibkr' ? Math.max(100, settings.limits.minIntervalMs) : settings.limits.minIntervalMs;
      const globalNext = (lastStarted.get(source) ?? 0) + interval;
      const endpointNext = limitedIbkr ? (lastStarted.get(source + path) ?? 0) + 5000 : 0;
      const wait = Math.max(0, globalNext - Date.now(), endpointNext - Date.now());
      if (wait) await new Promise(resolve => { const timer = setTimeout(resolve, wait); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      if (controller.signal.aborted) reject(signal?.aborted ? 'ABORTED' : 'TIMEOUT', 'Provider request was cancelled or timed out', 504);
      lastStarted.set(source, Date.now()); if (limitedIbkr) lastStarted.set(source + path, Date.now());
      const response = await fetchImpl(url, { method: 'GET', headers: { accept: 'application/json', ...headers }, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        const code = response.status === 401 ? 'AUTH_REQUIRED' : response.status === 403 ? 'ACCESS_DENIED' : response.status === 429 ? 'RATE_LIMITED' : 'UPSTREAM_HTTP';
        reject(code, `Provider returned HTTP ${response.status}`, response.status === 401 || response.status === 403 ? response.status : 502);
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && Number(contentLength) > settings.limits.maxBytes) reject('RESPONSE_TOO_LARGE', 'Provider response exceeds configured byte limit', 502);
      const reader = response.body?.getReader();
      if (!reader) reject('UPSTREAM_SCHEMA', 'Provider response has no JSON body', 502);
      const chunks = []; let bytes = 0;
      try {
        while (true) {
          const chunk = await reader.read(); if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > settings.limits.maxBytes) { await reader.cancel(); reject('RESPONSE_TOO_LARGE', 'Provider response exceeds configured byte limit', 502); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (error) { reject('UPSTREAM_SCHEMA', 'Provider response is not valid JSON', 502); }
      if (OBJECT(data) && (data.error || data['Error Message'] || data['Error'] || (data.message && !data.markets && !data.snapshots))) reject('UPSTREAM_REJECTED', 'Provider rejected the read request', 502);
      return redactCredentials(data, Object.values(headers));
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (controller.signal.aborted) reject(signal?.aborted ? 'ABORTED' : 'TIMEOUT', 'Provider request was cancelled or timed out', 504);
      reject('UPSTREAM_UNAVAILABLE', 'Provider could not be reached; verify network and configured certificate trust', 502);
    } finally {
      clearTimeout(timeout); signal?.removeEventListener('abort', abort); release();
    }
  }

  async function fmp(operation, args, signal) {
    if (!settings.fmp) reject('UNCONFIGURED', 'FMP market data is not configured', 503);
    const headers = { apikey: key(settings.fmp.apiKeyEnv) };
    const limit = count(args); let path; let params = {}; let normalize = value => value;
    const missing = ['source_timestamp_or_feed_delay_not_guaranteed'];
    if (operation === 'market.quote') {
      path = '/quote'; params.symbol = symbol(args.symbol);
      normalize = value => value.map(row => ({ symbol: row.symbol ?? params.symbol, price: decimal(row.price), currency: row.currency ?? null, volume: decimal(row.volume), change: decimal(row.change), changePercent: decimal(row.changePercentage), asOf: instant(row.timestamp), raw: scrub(row) }));
    } else if (operation === 'market.history') {
      path = '/historical-price-eod/dividend-adjusted'; params = { symbol: symbol(args.symbol), ...range(args, true) };
      normalize = value => {
        const dates = new Set();
        return value.filter(row => row.date >= params.from && row.date <= params.to).map(row => {
          const date = day(row.date, 'source date');
          if (dates.has(date)) reject('UPSTREAM_SCHEMA', 'History contains duplicate session dates', 502); dates.add(date);
          const adjustedClose = decimal(row.adjClose);
          if (adjustedClose === null || Number(adjustedClose) <= 0) reject('UPSTREAM_SCHEMA', 'Dividend-adjusted history is missing adjClose', 502);
          return { date, adjustedClose, volume: decimal(row.volume), symbol: row.symbol ?? params.symbol };
        }).sort((a, b) => a.date.localeCompare(b.date));
      };
    } else if (operation === 'market.news') {
      path = args.symbol ? '/news/stock' : '/news/stock-latest';
      params = { limit, page: integer(args.page ?? 0, 'page', 0, 1000), ...range(args), ...(args.symbol ? { symbols: symbol(args.symbol) } : {}) };
      normalize = value => value.map(row => ({ symbol: row.symbol ?? null, title: row.title ?? null, summary: row.text ?? null, publisher: row.publisher ?? row.site ?? null, url: safeUrl(row.url), publishedAt: instant(row.publishedDate), publishedAtRaw: row.publishedDate ?? null }));
    } else if (operation === 'market.profile') { path = '/profile'; params.symbol = symbol(args.symbol); }
    else if (operation === 'market.financials') {
      const kind = enumOf(args.statement ?? 'income', 'statement', ['income', 'balance', 'cashflow', 'ratios']);
      path = '/' + ({ income: 'income-statement', balance: 'balance-sheet-statement', cashflow: 'cash-flow-statement', ratios: 'ratios' })[kind];
      params = { symbol: symbol(args.symbol), period: enumOf(args.period ?? 'quarter', 'period', ['quarter', 'annual']), limit };
    } else if (operation === 'market.analysts') {
      const kind = enumOf(args.kind ?? 'ratings', 'kind', ['ratings', 'targets', 'estimates']);
      path = '/' + ({ ratings: 'grades-consensus', targets: 'price-target-consensus', estimates: 'analyst-estimates' })[kind]; params.symbol = symbol(args.symbol);
      if (kind === 'estimates') { params.period = enumOf(args.period ?? 'annual', 'period', ['quarter', 'annual']); params.limit = limit; }
    }
    else if (operation === 'market.screen') {
      const category = enumOf(args.category ?? 'active', 'category', ['active', 'gainers', 'losers', 'filter']);
      path = '/' + ({ active: 'most-actives', gainers: 'biggest-gainers', losers: 'biggest-losers', filter: 'company-screener' })[category];
      params.limit = limit;
      if (category === 'filter') {
        for (const name of ['sector', 'industry', 'country', 'exchange']) if (args[name] !== undefined) params[name] = string(args[name], name, /^[\w .,&-]{1,80}$/, 80);
        for (const name of ['marketCapMoreThan', 'marketCapLowerThan', 'priceMoreThan', 'priceLowerThan', 'volumeMoreThan']) if (args[name] !== undefined) {
          if (decimal(args[name]) === null || Number(args[name]) < 0) reject('INVALID_INPUT', `${name} must be nonnegative`); params[name] = args[name];
        }
      }
    } else if (operation === 'market.earnings') { path = '/earnings-calendar'; params = range(args, true); }
    else reject('UNSUPPORTED', 'This FMP operation is not implemented', 501);
    const rawRows = rows(await get('fmp', path, params, headers, signal));
    const max = operation === 'market.history' ? settings.limits.maxItems : limit;
    const complete = rawRows.length <= max && !(operation === 'market.history' && rawRows.length >= 5000);
    const normalized = normalize(rawRows.slice(0, max));
    if (!complete) missing.push('response_truncated_to_configured_limit');
    if (!normalized.length) missing.push('no_rows_returned');
    const asOf = latest(normalized.map(row => row.asOf ?? null));
    return envelope('fmp', scrub(normalized), { asOf, mode: 'delayed', missing, complete, priceBasis: operation === 'market.history' ? 'split_and_dividend_adjusted_eod' : null, documentation: 'https://site.financialmodelingprep.com/developer/docs' });
  }

  async function options(args, signal) {
    if (!settings.alpaca) reject('UNCONFIGURED', 'Alpaca option data is not configured', 503);
    const s = symbol(args.symbol); const limit = Math.min(count(args), 1000); const dates = range(args);
    const params = { feed: settings.alpaca.feed, limit, expiration_date_gte: dates.from, expiration_date_lte: dates.to };
    if (args.right !== undefined) params.type = enumOf(string(args.right, 'right', /^[A-Za-z]+$/, 4).toUpperCase(), 'right', ['CALL', 'PUT']).toLowerCase();
    if (args.cursor !== undefined) params.page_token = token(args.cursor);
    const raw = upstreamObject(await get('alpaca', '/options/snapshots/' + encodeURIComponent(s), params,
      { 'APCA-API-KEY-ID': key(settings.alpaca.keyEnv), 'APCA-API-SECRET-KEY': key(settings.alpaca.secretEnv) }, signal));
    const snapshots = upstreamObject(raw.snapshots);
    const data = Object.entries(snapshots).slice(0, limit).map(([contract, value]) => {
      upstreamObject(value); const q = value.latestQuote ?? {}; const g = value.greeks ?? {};
      const occ = contract.match(/^([A-Z0-9.]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
      return { contract, underlying: s, expiration: occ ? `20${occ[2]}-${occ[3]}-${occ[4]}` : null, right: occ ? (occ[5] === 'C' ? 'CALL' : 'PUT') : null,
        strike: occ ? String(Number(occ[6]) / 1000) : null, bid: decimal(q.bp), ask: decimal(q.ap), asOf: instant(q.t), last: decimal(value.latestTrade?.p),
        impliedVolatility: decimal(value.impliedVolatility), greeks: Object.fromEntries(['delta', 'gamma', 'theta', 'vega', 'rho'].map(name => [name, decimal(g[name])])),
        greekUnits: 'provider_native_units_unverified', multiplier: null, deliverables: null, volume: null, raw: scrub(value) };
    });
    return envelope('alpaca', data, { asOf: latest(data.map(item => item.asOf)), mode: settings.alpaca.feed === 'indicative' ? 'delayed' : 'live', feed: settings.alpaca.feed,
      missing: ['contract_multiplier_and_deliverables', 'greek_unit_verification', 'session_volume'], complete: !raw.next_page_token && Object.keys(snapshots).length <= limit,
      nextCursor: raw.next_page_token ?? null, documentation: 'https://docs.alpaca.markets/us/reference/optionchain' });
  }

  async function broker(operation, args, signal) {
    if (!settings.ibkr) reject('UNCONFIGURED', 'IBKR read-only gateway is not configured', 503);
    if (operation === 'broker.snapshot') {
      const id = string(args.accountId, 'accountId', /^[A-Za-z0-9-]{1,40}$/, 40);
      if (!settings.ibkr.accountIds.includes(id)) reject('ACCOUNT_SCOPE', 'Account is outside the configured allowlist', 403);
    }
    const accounts = rows(await get('ibkr', '/portfolio/accounts', {}, {}, signal)).filter(account => settings.ibkr.accountIds.includes(String(account.id ?? account.accountId)));
    if (operation === 'broker.accounts') return envelope('ibkr', accounts.map(row => ({ accountId: String(row.id ?? row.accountId), currency: row.currency ?? null, accountType: row.type ?? null })), { missing: ['hierarchical_subaccounts_not_enumerated', 'source_timestamp'], accessMode: 'READ_ONLY' });
    const id = args.accountId;
    if (!accounts.some(account => String(account.id ?? account.accountId) === id)) reject('ACCOUNT_UNAVAILABLE', 'Configured account is not available in this gateway session', 403);
    const summary = upstreamObject(await get('ibkr', `/portfolio/${id}/summary`, {}, {}, signal));
    const ledger = upstreamObject(await get('ibkr', `/portfolio/${id}/ledger`, {}, {}, signal));
    if (summary.accountcode?.value && summary.accountcode.value !== id) reject('UPSTREAM_SCHEMA', 'Broker summary account does not match requested scope', 502);
    if (Object.values(ledger).some(value => OBJECT(value) && value.acctcode && value.acctcode !== id)) reject('UPSTREAM_SCHEMA', 'Broker cash account does not match requested scope', 502);
    const positions = []; let complete = false; let pages = 0;
    for (let page = 0; page < settings.limits.maxPages; page++) {
      const part = rows(await get('ibkr', `/portfolio/${id}/positions/${page}`, {}, {}, signal)); pages++;
      if (part.some(row => row.acctId && row.acctId !== id)) reject('UPSTREAM_SCHEMA', 'Broker position account does not match requested scope', 502);
      positions.push(...part);
      if (part.length < 100) { complete = true; break; }
      if (positions.length >= settings.limits.maxItems) break;
    }
    if (positions.length > settings.limits.maxItems) complete = false;
    const missing = ['non_atomic_snapshot', 'order_visibility_limited_to_current_brokerage_session', 'executions_limited_to_gateway_selected_account_and_current_plus_six_previous_days', 'fees_and_corporate_actions_not_reconstructed'];
    let orders = null;
    try {
      const response = upstreamObject(await get('ibkr', '/iserver/account/orders', { accountId: id }, {}, signal));
      orders = rows(response.orders).filter(row => (row.account ?? row.acct ?? row.accountId) === id).slice(0, settings.limits.maxItems).map(scrub);
      if (response.snapshot !== true) missing.push('orders_not_confirmed_as_snapshot');
      if (response.orders.some(row => !(row.account ?? row.acct ?? row.accountId))) missing.push('unattributed_orders_excluded');
      if (response.orders.length > settings.limits.maxItems) missing.push('orders_truncated');
    } catch (error) {
      if (!(error instanceof ProviderError) || ['ABORTED', 'TIMEOUT'].includes(error.code)) throw error;
      missing.push(`orders_unavailable:${error.code}`);
    }
    let executions = null;
    try {
      const response = rows(await get('ibkr', '/iserver/account/trades', {}, {}, signal));
      executions = response.filter(row => (row.account ?? row.accountCode) === id).slice(0, settings.limits.maxItems).map(row => ({
        accountId: row.account ?? row.accountCode ?? null, orderRef: row.order_ref ?? null, executionId: row.execution_id ?? null, instrumentId: row.conid === undefined ? null : String(row.conid), symbol: row.symbol ?? null,
        side: row.side ?? null, quantity: decimal(row.size), price: decimal(row.price), commission: decimal(row.commission), netAmount: decimal(row.net_amount),
        asOf: instant(row.trade_time_r), currency: row.currency ?? null, raw: scrub(row),
      }));
      if (response.some(row => !(row.account ?? row.accountCode))) missing.push('unattributed_executions_excluded');
      if (response.length > settings.limits.maxItems) missing.push('executions_truncated');
    } catch (error) {
      if (!(error instanceof ProviderError) || ['ABORTED', 'TIMEOUT'].includes(error.code)) throw error;
      missing.push(`executions_unavailable:${error.code}`);
    }
    const cash = Object.entries(ledger).filter(([currency]) => currency !== 'BASE').map(([currency, value]) => {
      upstreamObject(value); return { currency: value.currency ?? currency, cash: decimal(value.cashbalance), settledCash: decimal(value.settledcash), asOf: instant(value.timestamp), semantic: 'broker_cash_balance_not_csp_available_cash' };
    });
    const normalizedPositions = positions.slice(0, settings.limits.maxItems).map(row => ({ instrumentId: row.conid === undefined ? null : String(row.conid), symbol: row.ticker ?? row.contractDesc ?? null,
      quantity: decimal(row.position), currency: row.currency ?? null, brokerCostBasis: decimal(row.avgCost), costBasisUnit: 'broker_avgCost_native', averagePrice: decimal(row.avgPrice),
      marketPrice: decimal(row.mktPrice), marketValue: decimal(row.mktValue), assetClass: row.assetClass ?? null, multiplier: decimal(row.multiplier), expiration: row.expiry ?? null,
      strike: decimal(row.strike), right: row.putOrCall ?? null, exerciseStyle: row.exerciseStyle ?? null, raw: scrub(row) }));
    if (!complete) missing.push('positions_incomplete');
    return envelope('ibkr', { accountId: id, summary: scrub(summary), cash, positions: normalizedPositions, orders, executions,
      coverage: { positionsComplete: complete, positionsPages: pages, accountAtomic: false, executionsComplete: false, historicalLedgerComplete: false } },
    { asOf: null, missing, accessMode: 'READ_ONLY', complete: false, documentation: 'https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-trading/' });
  }

  function normalizeKalshi(row) {
    const bid = probability(row.yes_bid_dollars); const ask = probability(row.yes_ask_dollars);
    return { id: row.ticker ?? null, eventId: row.event_ticker ?? null, platform: 'kalshi', title: row.title ?? null, status: row.status ?? null,
      outcomes: [{ label: row.yes_sub_title || 'Yes', price: probability(row.last_price_dollars), bid, ask }, { label: row.no_sub_title || 'No', price: null, bid: probability(row.no_bid_dollars), ask: probability(row.no_ask_dollars) }],
      spread: bid !== null && ask !== null ? String(Number((Number(ask) - Number(bid)).toFixed(12))) : null, volume: decimal(row.volume_fp), volume24h: decimal(row.volume_24h_fp),
      asOf: instant(row.updated_time), closesAt: instant(row.close_time), rules: [row.rules_primary, row.rules_secondary].filter(Boolean).join('\n') || null,
      url: row.ticker ? `https://external-api.kalshi.com/trade-api/v2/markets/${encodeURIComponent(row.ticker)}` : null, raw: scrub(row) };
  }
  function normalizePolymarket(row) {
    let labels = row.outcomes; let prices = row.outcomePrices;
    try { if (typeof labels === 'string') labels = JSON.parse(labels); if (typeof prices === 'string') prices = JSON.parse(prices); }
    catch (error) { reject('UPSTREAM_SCHEMA', 'Prediction outcome arrays are invalid', 502); }
    if (!Array.isArray(labels) || !Array.isArray(prices) || labels.length !== prices.length) reject('UPSTREAM_SCHEMA', 'Prediction outcome prices do not match outcomes', 502);
    return { id: String(row.id ?? ''), platform: 'polymarket', title: row.question ?? null, status: row.closed === true ? 'closed' : row.active === true ? 'active' : 'unknown',
      outcomes: labels.map((label, index) => ({ label: String(label), price: probability(prices[index]), bid: null, ask: null })),
      spread: decimal(row.spread), volume: decimal(row.volumeNum ?? row.volume), volume24h: decimal(row.volume24hr), asOf: instant(row.updatedAt), closesAt: instant(row.endDate),
      rules: row.description ?? null, url: row.id === undefined ? null : `https://gamma-api.polymarket.com/markets/${encodeURIComponent(row.id)}`, raw: scrub(row) };
  }
  async function predict(operation, args, signal) {
    if (!settings.predict?.enabled) reject('UNCONFIGURED', 'Public prediction-market research is not enabled', 503);
    const platform = enumOf(args.platform, 'platform', ['kalshi', 'polymarket']); const limit = count(args);
    let path = '/markets'; let params = {}; let data; let nextCursor = null;
    if (operation === 'predict.detail') {
      const pattern = platform === 'polymarket' ? /^\d{1,30}$/ : /^[A-Z0-9_.-]{1,200}$/;
      path += '/' + encodeURIComponent(string(args.id, 'market id', pattern));
    } else if (platform === 'kalshi') {
      params = { limit: Math.min(limit, 1000), status: enumOf(args.status ?? 'open', 'status', ['unopened', 'open', 'closed', 'settled']) };
      if (args.cursor !== undefined) params.cursor = token(args.cursor);
      if (args.eventId !== undefined) params.event_ticker = string(args.eventId, 'eventId', /^[A-Z0-9_.-]{1,200}$/);
    } else {
      params = { limit, offset: integer(args.offset ?? 0, 'offset', 0, 100000), closed: args.closed === true, active: args.closed === true ? undefined : true };
      if (args.slug !== undefined) params.slug = string(args.slug, 'slug', /^[a-z0-9-]{1,200}$/);
    }
    const raw = await get(platform, path, params, {}, signal);
    if (platform === 'kalshi') {
      upstreamObject(raw); data = operation === 'predict.detail' ? [upstreamObject(raw.market)] : rows(raw.markets); nextCursor = raw.cursor || null;
      data = data.slice(0, limit).map(normalizeKalshi);
    } else data = (operation === 'predict.detail' ? [upstreamObject(raw)] : rows(raw)).slice(0, limit).map(normalizePolymarket);
    return envelope(platform, data, { asOf: latest(data.map(item => item.asOf)), missing: ['prices_are_not_objective_probabilities', ...(platform === 'polymarket' ? ['per_outcome_bid_ask_requires_clob'] : [])],
      nextCursor, complete: operation === 'predict.detail' || (platform === 'kalshi' ? !nextCursor : data.length < limit), priceUnit: 'USD_per_1_USD_binary_payout',
      documentation: platform === 'kalshi' ? 'https://docs.kalshi.com/api-reference/market/get-markets' : 'https://docs.polymarket.com/api-reference/markets/list-markets' });
  }

  return {
    capabilities() {
      return OPERATIONS.map(operation => {
        const provider = operation.startsWith('broker.') ? 'ibkr' : operation.startsWith('predict.') ? 'predict' : operation === 'market.options' ? 'alpaca' : 'fmp';
        const configured = settings.mode === 'synthetic' ? Object.hasOwn(settings.fixtures, operation) : provider === 'predict' ? settings.predict?.enabled === true : !!settings[provider];
        return { operation, provider, configured, mode: settings.mode, access: 'READ_ONLY', credentialsValidated: false };
      });
    },
    async request(operation, args = {}, { signal } = {}) {
      if (!OPERATIONS.includes(operation)) reject('UNSUPPORTED', 'Operation is not in the read-only provider allowlist', 501);
      object(args, 'args'); if (signal?.aborted) reject('ABORTED', 'Provider request was cancelled', 499);
      if (settings.mode === 'synthetic') {
        if (!Object.hasOwn(settings.fixtures, operation)) reject('UNCONFIGURED', 'No explicit synthetic fixture for this operation', 503);
        return envelope('explicit_fixture', structuredClone(settings.fixtures[operation]), { mode: 'synthetic', missing: ['not_market_or_account_evidence'], request: structuredClone(args) });
      }
      if (operation.startsWith('broker.')) return broker(operation, args, signal);
      if (operation.startsWith('predict.')) return predict(operation, args, signal);
      if (operation === 'market.options') return options(args, signal);
      return fmp(operation, args, signal);
    },
  };
}
