/** Pure UI contracts shared by the standalone browser and its tests. */
export function renderableChildren(...children) { return children.flat(Infinity).filter(child => child !== null && child !== undefined && typeof child !== 'boolean'); }
export const GROUPS = ['home', 'research', 'options', 'portfolios', 'predict', 'orders', 'alerts', 'files', 'conversations', 'ledger', 'settings'];
export const PRIVATE_SCOPES = ['trade', 'broker', 'ledger', 'files', 'portfolio', 'localRead', 'localWrite', 'shell', 'resources'];
export function formValues(schema, fields) {
  const args = {};
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    const value = fields[key];
    if (value === undefined || value === '') { if (schema.required?.includes(key)) throw new Error(`${key}: required`); continue; }
    if (spec.type === 'boolean') { if (![true,false,'true','false'].includes(value)) throw new Error(`${key}: invalid boolean`); args[key] = value === true || value === 'true'; }
    else if (spec.type === 'number' || spec.type === 'integer') {
      const n = Number(value); if (String(value).trim() === '' || !Number.isFinite(n) || (spec.type === 'integer' && !Number.isInteger(n))) throw new Error(`${key}: invalid number`); args[key] = n;
    } else if (spec.type === 'array' || spec.type === 'object') {
      const parsed = typeof value === 'string' ? JSON.parse(value) : value;
      if (spec.type === 'array' ? !Array.isArray(parsed) : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${key}: expected ${spec.type}`); args[key] = parsed;
    } else args[key] = String(value);
    if (spec.enum && !spec.enum.includes(args[key])) throw new Error(`${key}: invalid choice`);
  }
  return args;
}
const hiddenFields = new Set(['confirmationToken','tokenHash','apiKey','accessToken','refreshToken','password','piMessages','sessionFile']);
export function visibleResult(value) {
  if (Array.isArray(value)) return value.map(visibleResult);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !hiddenFields.has(k)).map(([k,v]) => [k,visibleResult(v)]));
  return value;
}
export function historyScopeRequirements(chat) {
  return [...new Set([...(chat?.historyScopes ?? []), ...(chat?.messages ?? []).flatMap(m => m.allowedScopes ?? [])].filter(s => PRIVATE_SCOPES.includes(s)))].sort();
}
export function missingScopes(chat, allowed) { return historyScopeRequirements(chat).filter(s => !allowed.includes(s)); }
export function canConfirmOrder(preview, now = Date.now()) {
  return !!(preview?.executionEnabled === true && preview?.confirmationToken && preview?.id && preview?.order?.accountId && Date.parse(preview.expiresAt) > now);
}
export function formatNumber(value, language = 'zh') { return typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat(language === 'en' ? 'en-US' : language === 'zh-TW' ? 'zh-TW' : 'zh-CN', {maximumSignificantDigits:9}).format(value) : String(value); }
export function operationAvailable(operation, capabilities) {
  const direct = capabilities?.providers?.find(x => x.operation === operation);
  if (direct) return direct.configured;
  if (operation === 'chat.send') return capabilities?.chat?.enabled === true;
  if (['paper.create','paper.fill','order.confirm','order.cancel'].includes(operation)) return capabilities?.execution === 'LOCAL_PAPER';
  if (['research.compare','research.brief','research.stock','portfolio.backtestLive'].includes(operation)) return capabilities?.providers?.some(x => x.provider === 'fmp' && x.configured) ?? false;
  return true;
}
export function chartSeries(rows) {
  if (!Array.isArray(rows) || rows.length < 2 || rows.some(r => !r || typeof r !== 'object' || Array.isArray(r))) return null;
  const timeKey = ['date','period','calendarYear','time','year'].find(k => rows.every(r => r[k] !== undefined && r[k] !== null));
  const wanted = ['revenue','netIncome','grossProfit','operatingIncome','netProfitMargin','grossProfitMargin','operatingCashFlow','freeCashFlow','equity','portfolioValue','nav','value','balance','adjustedClose','close','price'];
  const keys = wanted.filter(k => rows.every(r => r[k] !== null && r[k] !== undefined && r[k] !== '' && Number.isFinite(Number(r[k]))));
  if (!keys.length) return null;
  const ordered = timeKey ? [...rows].sort((a,b) => String(a[timeKey]).localeCompare(String(b[timeKey]))) : rows;
  return {keys,rows:ordered,timeKey};
}
export function newsCategory(row) {
  const supplied = String(row.category ?? '').toLowerCase();
  if (['macro','industry','company','unclassified'].includes(supplied)) return supplied;
  const text = `${row.title ?? ''} ${row.text ?? row.summary ?? ''}`.toLowerCase();
  if (/inflation|interest rate|federal reserve|\bfed\b|gdp|cpi|通胀|利率|联储|央行|宏观/.test(text)) return 'macro';
  if (/sector|industry|semiconductor|energy|行业|产业|半导体/.test(text)) return 'industry';
  return 'company';
}
export function safeExternalURL(value) { try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) && !u.username && !u.password ? u.href : null; } catch { return null; } }
export function downloadPayload(file) {
  if (typeof file.content === 'string') return {name:file.name, mime:file.mimeType ?? 'text/plain',content:file.content};
  if (typeof file.dataBase64 === 'string') return {name:file.name,mime:file.mimeType,base64:file.dataBase64};
  throw new Error('Saved file has no downloadable content');
}
