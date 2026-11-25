/** Deterministic research helpers. Inputs are scenarios, not verified broker facts. */
import { createHash } from 'node:crypto';
import { requireThat } from './errors.js';
import { moneyCents } from './paper.js';

const METHOD_VERSION = 'research-1.0.0';
const symbolPattern = /^[A-Z0-9.\-]{1,40}$/;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = value => (value / 100).toFixed(2);
const checkObject = (value, keys, name) => {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_INPUT', `${name}须为对象。`);
  requireThat(Object.keys(value).every(k => keys.includes(k)), 'INVALID_INPUT', `${name}包含未知字段。`);
};
const integer = (value, min, max, name) => { requireThat(Number.isSafeInteger(value) && value >= min && value <= max, 'INVALID_INPUT', `${name}须为${min}至${max}的整数。`); return value; };
const number = (value, min, max, name) => { requireThat(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'INVALID_INPUT', `${name}数值无效。`); return value; };
const text = (value, max, name) => { requireThat(typeof value === 'string' && value.trim() && value.length <= max, 'INVALID_INPUT', `${name}文本无效。`); return value; };
const instant = (value, name) => { requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) && Number.isFinite(Date.parse(value.slice(0, 10))) && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10), 'INVALID_TIME', `${name}须为带时区的有效ISO时间。`); return Date.parse(value); };
const date = value => { requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value, 'INVALID_HISTORY', '历史日期无效。'); return value; };

function sma(values, period) {
  const result = Array(values.length).fill(null); let sum = 0;
  for (let i = 0; i < values.length; i++) { sum += values[i]; if (i >= period) sum -= values[i - period]; if (i >= period - 1) result[i] = sum / period; }
  return result;
}
function ema(values, period) {
  const result = Array(values.length).fill(null); if (values.length < period) return result;
  let previous = values.slice(0, period).reduce((sum, v) => sum + v, 0) / period;
  result[period - 1] = previous; const alpha = 2 / (period + 1);
  for (let i = period; i < values.length; i++) { previous += alpha * (values[i] - previous); result[i] = previous; }
  return result;
}
function rsi(values, period) {
  const result = Array(values.length).fill(null); if (values.length <= period) return result;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { const change = values[i] - values[i - 1]; gain += Math.max(0, change) / period; loss += Math.max(0, -change) / period; }
  const value = () => gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  result[period] = value();
  for (let i = period + 1; i < values.length; i++) { const change = values[i] - values[i - 1]; gain = (gain * (period - 1) + Math.max(0, change)) / period; loss = (loss * (period - 1) + Math.max(0, -change)) / period; result[i] = value(); }
  return result;
}

export function technicalIndicators(input) {
  checkObject(input, ['series', 'priceBasis', 'smaPeriods', 'emaPeriods', 'rsiPeriod', 'macd', 'symbol', 'asOf'], '技术指标参数');
  requireThat(Array.isArray(input.series) && input.series.length >= 1 && input.series.length <= 20000, 'INVALID_HISTORY', '历史需包含1至20000个观测。');
  requireThat(['UNADJUSTED_CLOSE', 'SPLIT_ADJUSTED_CLOSE', 'ADJUSTED_TOTAL_RETURN'].includes(input.priceBasis), 'UNKNOWN_PRICE_BASIS', '须明确价格复权口径。');
  if (input.symbol !== undefined) requireThat(typeof input.symbol === 'string' && symbolPattern.test(input.symbol), 'INVALID_SYMBOL', '证券代码无效。');
  const asOf = instant(input.asOf, '分析截至时间');
  const periods = (value, fallback, label) => { const entries = value ?? fallback; requireThat(Array.isArray(entries) && entries.length <= 10 && new Set(entries).size === entries.length, 'INVALID_INPUT', `${label}须为不重复的周期数组。`); return entries.map(v => integer(v, 1, 2000, label)); };
  const smaPeriods = periods(input.smaPeriods, [20, 50], 'SMA周期'), emaPeriods = periods(input.emaPeriods, [12, 26], 'EMA周期');
  const rsiPeriod = integer(input.rsiPeriod ?? 14, 1, 2000, 'RSI周期');
  const settings = input.macd ?? { fast: 12, slow: 26, signal: 9 }; checkObject(settings, ['fast', 'slow', 'signal'], 'MACD');
  const fast = integer(settings.fast, 1, 2000, 'MACD快线'), slow = integer(settings.slow, 2, 2000, 'MACD慢线'), signal = integer(settings.signal, 1, 2000, 'MACD信号线');
  requireThat(fast < slow, 'INVALID_INPUT', 'MACD快线周期须小于慢线。');
  let previous = '';
  const series = input.series.map(row => {
    checkObject(row, ['date', 'close'], '历史观测'); const day = date(row.date);
    requireThat(day > previous && Date.parse(day) <= asOf, 'INVALID_HISTORY', '历史必须严格按日期递增，不能重复或晚于分析截至时间。'); previous = day;
    requireThat(typeof row.close === 'number' && Number.isFinite(row.close) && row.close > 0 && row.close <= 1e12, 'INVALID_HISTORY', '历史价格必须为正数。'); return { date: day, close: row.close };
  });
  const values = series.map(row => row.close), columns = {};
  for (const period of smaPeriods) columns[`sma${period}`] = sma(values, period);
  for (const period of emaPeriods) columns[`ema${period}`] = ema(values, period);
  columns.rsi = rsi(values, rsiPeriod);
  const fastValues = ema(values, fast), slowValues = ema(values, slow);
  columns.macd = values.map((_, i) => slowValues[i] === null ? null : fastValues[i] - slowValues[i]);
  const activeMacd = columns.macd.filter(v => v !== null), signals = ema(activeMacd, signal);
  columns.macdSignal = [...Array(Math.min(slow - 1, values.length)).fill(null), ...signals];
  columns.macdHistogram = values.map((_, i) => columns.macdSignal[i] === null ? null : columns.macd[i] - columns.macdSignal[i]);
  const rows = series.map((row, i) => ({ ...row, ...Object.fromEntries(Object.entries(columns).map(([key, list]) => [key, list[i]])) }));
  return { symbol: input.symbol ?? null, asOf: input.asOf, priceBasis: input.priceBasis, rows, latest: rows.at(-1), parameters: { smaPeriods, emaPeriods, rsiPeriod, macd: { fast, slow, signal } }, methodology: { emaSeed: 'SMA_FIRST_FULL_WINDOW', emaAlpha: '2/(period+1)', rsiSmoothing: 'WILDER', flatRsi: 50, warmup: 'NULL_UNTIL_SUFFICIENT_OBSERVATIONS', calendar: 'OBSERVED_SESSIONS_NO_FILL', lookahead: false }, methodVersion: METHOD_VERSION, inputAuthority: 'USER_SUPPLIED_SCENARIO', orderSubmissionEnabled: false };
}

const classificationRules = [
  { category: 'MACRO', id: 'macro-keywords', pattern: /\b(?:inflation|cpi|gdp|fomc|federal reserve|central bank|interest rates?|unemployment|treasury yields?|tariffs?)\b|通胀|美联储|央行|国内生产总值|关税|失业率|降息|加息/i },
  { category: 'INDUSTRY', id: 'industry-keywords', pattern: /\b(?:semiconductors?|banking|pharmaceuticals?|automakers?|oil industry|renewable energy|real estate|retail sector)\b|半导体|银行业|医药行业|汽车行业|房地产|新能源|零售业/i },
];
export function classifyNews(input) {
  checkObject(input, ['articles', 'asOf', 'limit'], '新闻分类参数'); const asOf = instant(input.asOf, '截至时间'), limit = integer(input.limit ?? 30, 1, 200, '新闻数量');
  requireThat(Array.isArray(input.articles) && input.articles.length <= 2000, 'INVALID_INPUT', '新闻数组过大或无效。');
  const seen = new Map(); let duplicates = 0;
  for (const article of input.articles) {
    checkObject(article, ['id', 'title', 'text', 'url', 'source', 'publishedAt', 'symbols', 'sector'], '新闻');
    text(article.title, 2000, '新闻标题'); text(article.source, 300, '新闻来源');
    requireThat(article.text === undefined || typeof article.text === 'string' && article.text.length <= 20000, 'INVALID_INPUT', '新闻正文过长。');
    requireThat(article.sector === undefined || typeof article.sector === 'string' && article.sector.length <= 200, 'INVALID_INPUT', '行业字段无效。');
    const publishedAt = article.publishedAt === null || article.publishedAt === undefined ? null : instant(article.publishedAt, '新闻时间');
    requireThat(publishedAt === null || publishedAt <= asOf, 'FUTURE_DATA', '新闻时间晚于分析截至时间。');
    let url = null;
    if (article.url !== undefined && article.url !== null) {
      text(article.url, 4000, '来源链接'); let parsed;
      try { parsed = new URL(article.url); } catch (error) { requireThat(false, 'INVALID_URL', '来源链接不是有效URL。'); }
      requireThat(['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password, 'INVALID_URL', '来源链接只支持不含凭据的HTTP(S)。'); url = parsed.href;
    }
    const symbols = article.symbols ?? []; requireThat(Array.isArray(symbols) && symbols.length <= 40 && symbols.every(s => typeof s === 'string' && symbolPattern.test(s)), 'INVALID_SYMBOL', '新闻标的列表无效。');
    if (article.id !== undefined) text(article.id, 300, '新闻ID');
    const key = article.id ? `${article.source}:${article.id}` : url ?? digest([article.source, article.title, article.publishedAt ?? null]);
    const payload = { title: article.title, text: article.text ?? '', url, source: article.source, publishedAt: article.publishedAt ?? null, symbols: [...new Set(symbols)].sort(), sector: article.sector ?? null };
    if (seen.has(key)) { requireThat(digest(seen.get(key).original) === digest(payload), 'EVENT_CONFLICT', '相同新闻ID存在不同内容。'); duplicates++; continue; }
    const matched = classificationRules.find(rule => rule.pattern.test(`${article.title}\n${article.text ?? ''}`));
    const category = matched?.category ?? (article.sector ? 'INDUSTRY' : symbols.length ? 'COMPANY' : 'UNCLASSIFIED');
    const reason = matched?.id ?? (article.sector ? 'provided-sector' : symbols.length ? 'provided-symbols' : 'no-rule-matched');
    seen.set(key, { original: payload, item: { id: key, ...payload, category, classification: { method: 'LOCAL_HEURISTIC', ruleId: reason, confirmed: false }, ageMs: publishedAt === null ? null : asOf - publishedAt } });
  }
  const items = [...seen.values()].map(x => x.item).sort((a, b) => (a.ageMs ?? Infinity) - (b.ageMs ?? Infinity) || a.id.localeCompare(b.id));
  return { asOf: input.asOf, items: items.slice(0, limit), availableItems: items.length, duplicatesRemoved: duplicates, truncated: items.length > limit, ordering: 'KNOWN_PUBLICATION_TIME_NEWEST_FIRST', classificationVersion: METHOD_VERSION, rankingClaim: 'NOT_BOBBY_HOT_TRADES_RANKING', inputAuthority: 'USER_SUPPLIED_SCENARIO' };
}

export function planRebalance(input) {
  checkObject(input, ['currency', 'cash', 'positions', 'targetWeights', 'estimatedFeePerOrder', 'minimumTradeValue'], '再平衡参数');
  requireThat(typeof input.currency === 'string' && /^[A-Z]{3}$/.test(input.currency), 'INVALID_CURRENCY', '请明确单一币种。');
  const cashCents = moneyCents(input.cash), fee = moneyCents(input.estimatedFeePerOrder), minimum = moneyCents(input.minimumTradeValue);
  requireThat(Array.isArray(input.positions) && input.positions.length > 0 && input.positions.length <= 200, 'INVALID_POSITIONS', '需提供1至200项持仓或候选价格。');
  checkObject(input.targetWeights, Object.keys(input.targetWeights ?? {}), '目标权重');
  const seen = new Set();
  const assets = input.positions.map(p => { checkObject(p, ['symbol', 'quantity', 'price'], '持仓'); requireThat(typeof p.symbol === 'string' && symbolPattern.test(p.symbol) && !seen.has(p.symbol), 'INVALID_POSITIONS', '证券代码无效或重复。'); seen.add(p.symbol); const quantity = integer(p.quantity, 0, 100000000, '股票数量'), priceCents = moneyCents(p.price); requireThat(priceCents > 0 && Number.isSafeInteger(priceCents * quantity), 'INVALID_POSITIONS', '价格必须为正且持仓金额在精确范围内。'); return { symbol: p.symbol, quantity, priceCents }; });
  let weightSum = 0;
  for (const [symbol, weight] of Object.entries(input.targetWeights)) { requireThat(symbolPattern.test(symbol) && seen.has(symbol), 'MISSING_PRICE', '每个目标标的必须有明确价格，零持仓也须提供。'); number(weight, 0, 1, '权重'); weightSum += weight; }
  requireThat(Object.keys(input.targetWeights).length > 0 && weightSum > 0 && weightSum <= 1 + 1e-9, 'INVALID_WEIGHTS', '股票目标权重合计须大于0且不超过1，余量视为现金。');
  const nav = assets.reduce((n, p) => n + p.quantity * p.priceCents, cashCents); requireThat(Number.isSafeInteger(nav) && nav > 0, 'INVALID_NAV', '组合净值须为正且在精确整数范围内。');
  // Reserve a fee for every asset conservatively before sizing. Unused fees remain cash.
  const feeReserve = assets.length * fee, investable = nav - feeReserve; requireThat(Number.isSafeInteger(feeReserve) && investable >= 0, 'FEE_COVERAGE', '组合不足以覆盖保守预留费用。');
  const candidates = assets.map(asset => { const weight = input.targetWeights[asset.symbol] ?? 0; const targetQuantity = Math.floor(investable * weight / asset.priceCents); return { ...asset, weight, targetQuantity, difference: targetQuantity - asset.quantity }; });
  let available = cashCents; const orders = [], skipped = [];
  const append = (asset, side, quantity) => { const notionalCents = quantity * asset.priceCents; requireThat(Number.isSafeInteger(notionalCents), 'OVERFLOW', '计划金额超出精确范围。'); available += (side === 'SELL' ? notionalCents : -notionalCents) - fee; orders.push({ symbol: asset.symbol, assetClass: 'STOCK', side, positionEffect: side === 'SELL' ? 'CLOSE' : 'OPEN', quantity, limitPrice: money(asset.priceCents), notional: money(notionalCents), estimatedFees: money(fee), currency: input.currency, status: 'RESEARCH_PREVIEW', executed: false }); };
  for (const asset of candidates.filter(p => p.difference < 0).sort((a, b) => a.symbol.localeCompare(b.symbol))) {
    const qty = -asset.difference, notional = qty * asset.priceCents;
    if (notional < minimum || notional < fee) skipped.push({ symbol: asset.symbol, side: 'SELL', reason: notional < minimum ? 'BELOW_MINIMUM' : 'FEE_EXCEEDS_PROCEEDS' }); else append(asset, 'SELL', qty);
  }
  // Larger deficits first; skipped sales cannot finance buys. Floor to whole shares and available cash.
  for (const asset of candidates.filter(p => p.difference > 0).sort((a, b) => b.difference * b.priceCents - a.difference * a.priceCents || a.symbol.localeCompare(b.symbol))) {
    const qty = Math.min(asset.difference, Math.max(0, Math.floor((available - fee) / asset.priceCents)));
    if (qty === 0 || qty * asset.priceCents < minimum) skipped.push({ symbol: asset.symbol, side: 'BUY', reason: qty === 0 ? 'CASH_COVERAGE' : 'BELOW_MINIMUM' }); else append(asset, 'BUY', qty);
  }
  requireThat(Number.isSafeInteger(available) && available >= 0, 'CASH_COVERAGE', '计划出现负现金，未生成可执行结果。');
  const fees = orders.length * fee, endingNav = nav - fees;
  const projected = assets.map(asset => { const change = orders.filter(o => o.symbol === asset.symbol).reduce((n, o) => n + (o.side === 'BUY' ? o.quantity : -o.quantity), 0); const quantity = asset.quantity + change; const value = quantity * asset.priceCents; return { symbol: asset.symbol, quantity, price: money(asset.priceCents), value: money(value), targetWeight: input.targetWeights[asset.symbol] ?? 0, projectedWeight: endingNav ? value / endingNav : 0 }; });
  return { currency: input.currency, initialNav: money(nav), initialCash: money(cashCents), estimatedFees: money(fees), projectedCash: money(available), projectedNav: money(endingNav), targetCashWeight: Math.max(0, 1 - weightSum), orders, projected, skipped, methodology: 'LONG_ONLY_WHOLE_SHARES_FEE_BUFFER_SELLS_BEFORE_BUYS', requiresConfirmedPricesAndHoldings: true, inputAuthority: 'USER_SUPPLIED_SCENARIO', methodVersion: METHOD_VERSION, orderSubmissionEnabled: false };
}

function ladder(levels, side) {
  requireThat(Array.isArray(levels) && levels.length <= 5000, 'INVALID_ORDERBOOK', '价格阶梯无效或过大。');
  const grouped = new Map();
  for (const level of levels) { checkObject(level, ['price', 'quantity'], '订单簿档位'); const price = number(level.price, 0, 1, '美元每合约价格'), quantity = number(level.quantity, 1e-8, 1e9, '档位数量'); grouped.set(price, (grouped.get(price) ?? 0) + quantity); }
  return [...grouped].sort(([a], [b]) => side === 'bids' ? b - a : a - b).map(([price, quantity]) => ({ price, quantity }));
}
function walk(levels, quantity) {
  let remaining = quantity, total = 0, filled = 0;
  for (const level of levels) { const take = Math.min(remaining, level.quantity); total += take * level.price; filled += take; remaining -= take; if (remaining === 0) break; }
  return { quantityRequested: quantity, quantityAvailable: filled, complete: remaining === 0, total: remaining === 0 ? total : null, averagePrice: remaining === 0 ? total / quantity : null };
}
export function comparePredictionMarkets(input) {
  checkObject(input, ['markets', 'quantity', 'asOf', 'maxAgeMs'], '预测市场比较');
  const asOf = instant(input.asOf, '比较时间'), maxAgeMs = integer(input.maxAgeMs, 1, 86400000, '最大数据年龄'), qty = number(input.quantity, 1e-8, 1e9, '比较数量');
  requireThat(Array.isArray(input.markets) && input.markets.length >= 1 && input.markets.length <= 30, 'INVALID_INPUT', '比较支持1至30个市场结果。');
  const seen = new Set();
  const rows = input.markets.map(market => {
    checkObject(market, ['id', 'platform', 'outcome', 'eventKey', 'resolutionRules', 'asOf', 'source', 'synthetic', 'priceUnit', 'payoutPerContract', 'orderbook', 'fairProbability', 'feePerContract'], '预测市场');
    text(market.id, 160, '市场ID'); text(market.platform, 100, '平台'); text(market.outcome, 500, '结果名称'); text(market.source, 300, '数据来源');
    requireThat(!seen.has(`${market.platform}:${market.id}`), 'INVALID_INPUT', '同一平台市场ID重复。'); seen.add(`${market.platform}:${market.id}`);
    requireThat(market.priceUnit === 'USD_PER_CONTRACT' && market.payoutPerContract === 1, 'UNKNOWN_PRICE_BASIS', '比较仅支持每合约以USD计价且成功兑付1美元的二元结果。');
    requireThat(typeof market.synthetic === 'boolean', 'SOURCE_REQUIRED', '必须明确是否合成数据。');
    const quoteTime = instant(market.asOf, '订单簿时间'); requireThat(quoteTime <= asOf && asOf - quoteTime <= maxAgeMs, 'STALE_MARKET_DATA', '订单簿时间未知、未来或过期。');
    checkObject(market.orderbook, ['bids', 'asks'], '订单簿'); const bids = ladder(market.orderbook.bids, 'bids'), asks = ladder(market.orderbook.asks, 'asks');
    requireThat(!bids.length || !asks.length || bids[0].price <= asks[0].price, 'CROSSED_ORDERBOOK', '订单簿买卖价格交叉，不能据此生成比较。');
    const fee = number(market.feePerContract, 0, 1, '每合约显式费用');
    if (market.fairProbability !== undefined) number(market.fairProbability, 0, 1, '主观概率');
    if (market.eventKey !== undefined) text(market.eventKey, 300, '事件键');
    if (market.resolutionRules !== undefined) text(market.resolutionRules, 10000, '结算规则');
    const buy = walk(asks, qty), sell = walk(bids, qty);
    return { id: market.id, platform: market.platform, outcome: market.outcome, eventKey: market.eventKey ?? null, resolutionRules: market.resolutionRules ?? null, asOf: market.asOf, source: market.source, synthetic: market.synthetic, bids, asks, spread: bids.length && asks.length ? asks[0].price - bids[0].price : null, depth: { bidQuantity: bids.reduce((n, x) => n + x.quantity, 0), askQuantity: asks.reduce((n, x) => n + x.quantity, 0) }, buy: { ...buy, costIncludingExplicitFees: buy.complete ? buy.total + fee * qty : null }, sell: { ...sell, proceedsAfterExplicitFees: sell.complete ? sell.total - fee * qty : null }, subjectiveProbability: market.fairProbability ?? null, subjectiveBuyEdgePerContractAfterFee: market.fairProbability === undefined || !buy.complete ? null : market.fairProbability - buy.averagePrice - fee, feePerContract: fee };
  });
  const equivalentInputRules = rows.length > 1 && rows[0].eventKey !== null && rows[0].resolutionRules !== null && rows.every(row => row.eventKey === rows[0].eventKey && row.outcome === rows[0].outcome && row.resolutionRules === rows[0].resolutionRules);
  const eligibleBuys = rows.filter(row => row.buy.complete), eligibleSells = rows.filter(row => row.sell.complete);
  return { asOf: input.asOf, quantity: qty, rows, comparisonBasis: 'USER_ATTESTED_RULES_NOT_INDEPENDENTLY_VERIFIED', sameEventAndRulesSupplied: equivalentInputRules, cheapestBuyMarketId: equivalentInputRules && eligibleBuys.length ? [...eligibleBuys].sort((a, b) => a.buy.costIncludingExplicitFees - b.buy.costIncludingExplicitFees)[0].id : null, highestSellMarketId: equivalentInputRules && eligibleSells.length ? [...eligibleSells].sort((a, b) => b.sell.proceedsAfterExplicitFees - a.sell.proceedsAfterExplicitFees)[0].id : null, arbitrageVerified: false, orderSubmissionEnabled: false, caveats: ['明确费用不是平台完整费用估计。', '主观概率差不是客观胜率或保证收益。', '结算规则、法律可用性、转移和执行风险未独立核验。'], methodVersion: METHOD_VERSION, inputAuthority: 'USER_SUPPLIED_SCENARIO' };
}
