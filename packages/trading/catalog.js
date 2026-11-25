import { tradeCatalog } from './trade-catalog.js';
import { extendedCatalog } from './extended-catalog.js';
/** Operation metadata drives the browser forms and scoped model tool schemas. */
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const obj = (description) => ({ type: 'object', description, additionalProperties: true });
const arr = (description, items = { type: 'object', additionalProperties: true }) => ({ type: 'array', description, items });
const op = (operation, title, group, kind, scope, properties = {}, required = [], example = {}, model = false) => ({ operation, title, description: title, group, kind, scope, model, inputSchema: { type: 'object', properties, required, additionalProperties: false }, example });
const id = { id: str('记录ID') };
const rev = { ...id, revision: num('读取结果中的revision', { minimum: 1 }) };
const symbol = { symbol: str('证券代码，例如AAPL'), limit: num('最多返回条数', { minimum: 1, maximum: 5000 }) };
const pricing = { model: str('定价模型', { enum: ['BLACK_SCHOLES', 'CRR'] }), right: str('期权方向', { enum: ['CALL', 'PUT'] }), spot: num('标的价格'), strike: num('执行价'), timeYears: num('剩余年数'), rate: num('年化连续复利无风险利率，例如0.05'), dividendYield: num('年化连续分红率'), volatility: num('年化波动率，例如0.20'), steps: num('CRR步数') };
const priceExample = { model: 'BLACK_SCHOLES', right: 'CALL', spot: 100, strike: 100, timeYears: 30 / 365, rate: 0.05, dividendYield: 0, volatility: 0.2 };
const backtest = { initialCapital: num('虚拟本金'), weights: obj('股票代码与权重'), series: obj('按标的的日期和复权总回报序列'), seriesKind: str('序列性质', { enum: ['ADJUSTED_TOTAL_RETURN'] }), dataFrequency: str('数据频率', { enum: ['DAILY', 'ANNUAL'] }), rebalance: str('再平衡频率', { enum: ['MONTHLY', 'ANNUAL', 'NONE'] }), costBps: num('每侧交易成本基点'), annualRiskFreeRate: num('Sharpe基准年利率'), periodsPerYear: num('年化周期数'), benchmarkSymbol: str('基准标的') };
export const catalog = [
  op('market.quote', '股票报价', 'research', 'read', 'market', symbol, ['symbol'], { symbol: 'AAPL' }, true),
  op('market.profile', '公司资料与估值字段', 'research', 'read', 'market', symbol, ['symbol'], { symbol: 'AAPL' }, true),
  op('market.financials', '财务报表', 'research', 'read', 'market', { ...symbol, statement: str('报表', { enum: ['income', 'balance', 'cashflow', 'ratios'] }), period: str('周期', { enum: ['annual', 'quarter'] }) }, ['symbol'], { symbol: 'AAPL', statement: 'income', period: 'quarter', limit: 4 }, true),
  op('market.analysts', '分析师共识', 'research', 'read', 'market', { ...symbol, kind: str('评级、目标价或预测', { enum: ['ratings', 'targets', 'estimates'] }), period: str('预测周期', { enum: ['annual', 'quarter'] }) }, ['symbol'], { symbol: 'AAPL', kind: 'ratings' }, true),
  op('market.news', '新闻与热点', 'research', 'read', 'market', { ...symbol, from: str('开始日期'), to: str('结束日期'), page: num('分页编号，从0开始') }, [], { limit: 10 }, true),
  op('market.history', '历史复权价格', 'research', 'read', 'market', { ...symbol, from: str('开始日期YYYY-MM-DD'), to: str('结束日期YYYY-MM-DD') }, ['symbol', 'from', 'to'], { symbol: 'SPY', from: '2025-01-01', to: '2025-12-31', limit: 1000 }, true),
  op('market.screen', '市场榜单', 'research', 'read', 'market', { category: str('类别', { enum: ['gainers', 'losers', 'active', 'filter'] }), limit: num('数量'), sector: str('行业大类'), industry: str('细分行业'), country: str('国家'), exchange: str('交易所'), marketCapMoreThan: num('市值下界'), marketCapLowerThan: num('市值上界'), priceMoreThan: num('价格下界'), priceLowerThan: num('价格上界'), volumeMoreThan: num('成交量下界') }, ['category'], { category: 'active', limit: 10 }, true),
  op('market.earnings', '财报日历', 'research', 'read', 'market', { from: str('开始日期'), to: str('结束日期'), limit: num('数量') }, ['from', 'to'], {}, true),
  op('research.compare', '股票对比与研究资料', 'research', 'read', 'market', { symbols: arr('股票列表', str('代码')), sections: arr('研究章节', str('数据类别', { enum: ['quote', 'profile', 'financials', 'analysts', 'news'] })) }, ['symbols', 'sections'], { symbols: ['AAPL', 'MSFT'], sections: ['quote', 'profile', 'financials', 'news'] }, true),
  op('research.brief', '观察列表每日简报', 'research', 'read', 'market', { symbols: arr('股票列表', str('代码')) }, ['symbols'], { symbols: ['AAPL', 'MSFT'] }, true),
  op('broker.accounts', '可读取账户', 'research', 'read', 'broker', {}, [], {}, true),
  op('broker.snapshot', '券商只读账户快照', 'research', 'read', 'broker', { accountId: str('服务配置中允许的账户ID') }, ['accountId'], {}, true),
  op('snapshot.list', '保存的券商快照', 'research', 'read', 'broker', {}, [], {}, true),
  op('snapshot.get', '读取固定快照', 'research', 'read', 'broker', id, ['id'], {}, true),
  op('market.options', '期权链与原生Greeks', 'options', 'read', 'market', { ...symbol, from: str('到期起始日期'), to: str('到期结束日期'), right: str('方向', { enum: ['CALL', 'PUT'] }), cursor: str('上一页返回的nextCursor') }, ['symbol'], { symbol: 'AAPL', limit: 20 }, true),
  op('quant.price', '期权定价与Greeks', 'options', 'compute', 'compute', pricing, ['model', 'right', 'spot', 'strike', 'timeYears', 'rate', 'dividendYield', 'volatility'], priceExample, true),
  op('quant.iv', '求隐含波动率', 'options', 'compute', 'compute', { ...pricing, targetPrice: num('目标期权价格'), minVol: num('求解下界'), maxVol: num('求解上界'), tolerance: num('价格容差'), maxIterations: num('最大迭代次数') }, ['model', 'right', 'spot', 'strike', 'timeYears', 'rate', 'dividendYield', 'targetPrice', 'minVol', 'maxVol', 'tolerance', 'maxIterations'], { ...priceExample, targetPrice: 2.49337682, minVol: 0.001, maxVol: 4, tolerance: 1e-7, maxIterations: 200 }, true),
  op('quant.scenario', '价格、波动率与时间情景', 'options', 'compute', 'compute', { option: obj('完整定价参数'), shocks: arr('冲击情景'), signedContracts: num('有符号合约数量'), multiplier: num('核实后的报价乘数') }, ['option', 'shocks', 'signedContracts', 'multiplier'], { option: priceExample, shocks: [{ spotChangePct: -0.1, volatilityChange: 0.05, daysElapsed: 1 }], signedContracts: -1, multiplier: 100 }, true),
  op('wheel.analyze', 'Wheel硬约束检查', 'options', 'compute', 'compute', { strategy: str('策略', { enum: ['CC', 'CSP'] }), symbol: str('标的'), currency: str('币种'), position: obj('已核对N/P/Q与confirmed'), cash: obj('现金金额、口径与confirmed'), existingObligations: arr('现有义务；空数组表示已核实为空'), stockReservations: arr('其他占股；空数组表示已核实为空'), candidates: arr('拟议候选集合'), cashBuffer: num('现金缓冲'), estimatedFees: num('预计费用'), dataQuality: obj('fresh/reconciled/complete'), riskChecks: obj('交割意愿/批次/流动性/事件/集中度') }, ['strategy', 'symbol', 'currency', 'candidates'], {}, true),
  op('options.rank', '期权候选筛选', 'options', 'compute', 'compute', { candidates: arr('包含报价与Greeks的候选'), criteria: obj('用户明确的筛选阈值'), limit: num('最多候选数') }, ['candidates', 'criteria', 'limit'], {}, true),
  op('ledger.read', '读取原有期权账本', 'options', 'read', 'ledger', {}, [], {}, true),
  op('ledger.propose', '提交原账本修改草稿', 'options', 'write', 'ledger', { revision: num('账本当前版本'), requestId: str('幂等请求ID'), action: str('操作', { enum: ['savePosition', 'saveTrade', 'assign'] }), data: obj('原账本操作参数') }, ['revision', 'requestId', 'action', 'data'], {}, true),
  op('portfolio.risk', '组合敞口与风险', 'portfolios', 'compute', 'compute', { currency: str('统一币种'), cash: num('现金'), positions: arr('仓位、方向、乘数和Greeks') }, ['currency', 'cash', 'positions'], {}, true),
  op('portfolio.save', '保存研究组合', 'portfolios', 'write', 'portfolio', { ...rev, name: str('组合名'), weights: obj('股票权重'), note: str('研究说明') }, ['name', 'weights'], { name: '研究组合', weights: { SPY: 0.6, TLT: 0.4 }, note: '仅研究' }, true),
  op('portfolio.list', '研究组合列表', 'portfolios', 'read', 'portfolio', {}, [], {}, true),
  op('portfolio.get', '读取研究组合', 'portfolios', 'read', 'portfolio', id, ['id'], {}, true),
  op('portfolio.backtest', '回测上传的总回报序列', 'portfolios', 'compute', 'compute', backtest, ['initialCapital', 'weights', 'series', 'seriesKind', 'dataFrequency', 'rebalance', 'costBps', 'annualRiskFreeRate', 'periodsPerYear'], {}, true),
  op('portfolio.backtestLive', '获取历史数据并回测', 'portfolios', 'compute', 'market', { ...backtest, from: str('开始日期'), to: str('结束日期') }, ['initialCapital', 'weights', 'from', 'to', 'rebalance', 'costBps', 'annualRiskFreeRate', 'periodsPerYear'], {}, true),
  op('predict.markets', '预测市场发现', 'predict', 'read', 'predict', { platform: str('平台', { enum: ['kalshi', 'polymarket'] }), limit: num('数量'), status: str('Kalshi状态', { enum: ['unopened', 'open', 'closed', 'settled'] }), cursor: str('Kalshi分页游标'), eventId: str('Kalshi事件标识'), offset: num('Polymarket分页偏移'), closed: { type: 'boolean', description: 'Polymarket已关闭市场' }, slug: str('Polymarket精确slug') }, ['platform'], { platform: 'kalshi', limit: 10 }, true),
  op('predict.detail', '预测市场详情与结果', 'predict', 'read', 'predict', { platform: str('平台', { enum: ['kalshi', 'polymarket'] }), id: str('市场ID') }, ['platform', 'id'], {}, true),
  op('watchlist.add', '收藏市场或证券', 'predict', 'write', 'portfolio', { key: str('平台+市场ID或证券ID'), title: str('显示名称'), platform: str('平台'), marketId: str('市场ID'), symbol: str('证券代码') }, ['key', 'title'], {}, true),
  op('watchlist.list', '收藏列表', 'predict', 'read', 'portfolio', {}, [], {}, true),
  op('watchlist.remove', '移除收藏', 'predict', 'human', 'portfolio', rev, ['id', 'revision']),
  op('order.preview', '本地模拟订单预览', 'orders', 'write', 'compute', { accountId: str('本地模拟账户ID；只预览可不填'), symbol: str('证券或期权合约代码'), assetClass: str('类型', { enum: ['STOCK', 'OPTION'] }), side: str('买卖', { enum: ['BUY', 'SELL'] }), positionEffect: str('开平', { enum: ['OPEN', 'CLOSE'] }), quantity: num('整数数量'), type: str('订单类型', { enum: ['LIMIT'] }), limitPrice: str('限价'), currency: str('币种', { enum: ['USD'] }), timeInForce: str('有效期', { enum: ['DAY', 'GTC'] }), session: str('交易时段', { enum: ['REGULAR'] }), estimatedFees: str('估计费用'), contract: obj('期权合约、交割物') }, ['symbol', 'assetClass', 'side', 'positionEffect', 'quantity', 'type', 'limitPrice', 'currency', 'timeInForce', 'session', 'estimatedFees'], { symbol: 'AAPL', assetClass: 'STOCK', side: 'BUY', positionEffect: 'OPEN', quantity: 1, type: 'LIMIT', limitPrice: '1.00', currency: 'USD', timeInForce: 'DAY', session: 'REGULAR', estimatedFees: '0.00' }, true),
  op('order.confirm', '确认本地模拟订单', 'orders', 'human', 'compute', { ...id, confirmationToken: str('预览中的确认凭证') }, ['id', 'confirmationToken']),
  op('order.cancel', '撤销本地模拟订单', 'orders', 'human', 'compute', rev, ['id', 'revision']),
  op('order.list', '本地模拟订单簿', 'orders', 'read', 'portfolio', { accountId: str('账户ID') }, [], {}, true),
  op('paper.create', '创建本地模拟账户', 'orders', 'human', 'portfolio', { name: str('账户名'), initialCash: str('初始虚拟现金'), currency: str('币种', { enum: ['USD'] }) }, ['name', 'initialCash', 'currency'], { name: '本地模拟', initialCash: '10000.00', currency: 'USD' }),
  op('paper.list', '本地模拟账户', 'orders', 'read', 'portfolio', {}, [], {}, true),
  op('paper.get', '模拟现金与持仓', 'orders', 'read', 'portfolio', id, ['id'], {}, true),
  op('paper.fill', '记录明确的模拟成交', 'orders', 'human', 'compute', { ...rev, quantity: num('模拟成交数量'), price: str('模拟成交价'), fee: str('模拟手续费'), eventId: str('唯一模拟成交ID') }, ['id', 'revision', 'quantity', 'price', 'fee', 'eventId']),
  op('alerts.create', '创建本地价格提醒', 'alerts', 'human', 'market', { name: str('提醒名'), sourceOperation: str('只读数据源', { enum: ['market.quote', 'predict.detail'] }), sourceArgs: obj('数据源参数'), field: str('数值字段路径，例如data.0.price'), comparator: str('条件', { enum: ['gte', 'lte'] }), threshold: num('阈值'), intervalMs: num('轮询毫秒数'), maxAgeMs: num('可接受的最大源数据年龄毫秒'), once: { type: 'boolean', description: '只触发一次' } }, ['name', 'sourceOperation', 'sourceArgs', 'field', 'comparator', 'threshold', 'intervalMs', 'maxAgeMs', 'once']),
  op('alerts.list', '提醒状态', 'alerts', 'read', 'portfolio', {}, [], {}, true),
  op('alerts.evaluate', '立即检查提醒', 'alerts', 'human', 'market', id, ['id']),
  op('alerts.update', '暂停或恢复提醒', 'alerts', 'human', 'portfolio', { ...rev, enabled: { type: 'boolean' } }, ['id', 'revision', 'enabled']),
  op('notifications.list', '通知中心', 'alerts', 'read', 'portfolio', {}, [], {}, true),
  op('notifications.read', '标记通知已读', 'alerts', 'human', 'portfolio', rev, ['id', 'revision']),
  op('file.import', '导入附件', 'files', 'human', 'files', { name: str('文件名'), content: str('文本内容'), mimeType: str('媒体类型'), dataBase64: str('图片base64') }, ['name']),
  op('file.list', '已保存文件', 'files', 'read', 'files', {}, [], {}, true),
  op('file.get', '读取文件', 'files', 'read', 'files', id, ['id'], {}, true),
  op('file.export', '导出文件', 'files', 'read', 'files', id, ['id']),
  op('file.inspectEvents', '事件去重与现金流复核', 'files', 'compute', 'files', id, ['id'], {}, true),
  op('report.save', '保存Markdown报告', 'files', 'write', 'files', { name: str('文件名.md'), content: str('报告正文') }, ['name', 'content'], {}, true),
  op('chat.create', '新建研究会话', 'conversations', 'human', 'portfolio', { title: str('会话名') }, [], { title: '研究会话' }),
  op('chat.list', '搜索会话', 'conversations', 'read', 'portfolio', { query: str('标题关键词'), includeArchived: { type: 'boolean' } }),
  op('chat.get', '读取会话', 'conversations', 'read', 'portfolio', id, ['id']),
  op('chat.update', '改名、置顶或归档', 'conversations', 'human', 'portfolio', { ...rev, title: str('新标题'), pinned: { type: 'boolean' }, archived: { type: 'boolean' } }, ['id']),
  op('chat.send', '向交易助手提问', 'conversations', 'human', 'market', { ...id, message: str('问题'), allowedScopes: arr('本轮允许的数据范围', str('范围', { enum: ['market', 'compute', 'predict', 'portfolio', 'files', 'ledger', 'broker', 'localRead', 'localWrite', 'shell', 'resources', 'trade'] })), attachments: arr('本轮图片附件') }, ['id', 'message']),
  op('chat.export', '导出会话Markdown', 'conversations', 'human', 'files', id, ['id']),
  op('chat.recover', '恢复超时中断的会话', 'conversations', 'human', 'portfolio', rev, ['id', 'revision']),
  op('chat.feedback', '记录回答反馈', 'conversations', 'human', 'portfolio', { ...id, messageIndex: num('消息序号'), rating: str('评价', { enum: ['good', 'bad'] }), note: str('说明') }, ['id', 'messageIndex', 'rating']),
  op('settings.get', '个人显示设置', 'settings', 'read', 'portfolio'),
  op('settings.update', '更新显示设置', 'settings', 'human', 'portfolio', { revision: num('当前设置版本'), language: str('语言', { enum: ['zh', 'en', 'zh-TW'] }), timezone: str('IANA时区') }, ['language', 'timezone']),
  op('audit.list', '本地操作审计', 'settings', 'human', 'portfolio'),
  ...extendedCatalog,
  ...tradeCatalog,
];

/** Validate wire/model values, including unknown fields, before reaching operation handlers. */
export function validateInput(value, schema, path = 'args', depth = 0) {
  if (depth > 20) throw new Error('输入嵌套过深');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path}须为对象`);
    for (const key of schema.required ?? []) if (value[key] === undefined) throw new Error(`${path}.${key}不能为空`);
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('字段名无效');
      const child = schema.properties?.[key];
      if (!child && schema.additionalProperties === false) throw new Error(`${path}.${key}不受支持`);
      if (child) validateInput(item, child, `${path}.${key}`, depth + 1);
    }
  } else if (schema.type === 'array') { if (!Array.isArray(value) || value.length > 20000) throw new Error(`${path}数组无效`); value.forEach((item, i) => validateInput(item, schema.items, `${path}.${i}`, depth + 1)); }
  else if (schema.type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value) || (schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new Error(`${path}数值无效`); }
  else if (typeof value !== schema.type) throw new Error(`${path}类型无效`);
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${path}取值无效`);
}
