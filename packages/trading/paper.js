/** Local simulation only. No method in this module calls a broker or treats a simulation as an execution. */
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { requireThat } from './errors.js';

export function moneyCents(value) {
  const text = String(value); requireThat(/^\d{1,10}(\.\d{1,2})?$/.test(text), 'INVALID_MONEY', '金额必须非负且最多两位小数。');
  const [whole, part = ''] = text.split('.'); return Number(BigInt(whole) * 100n + BigInt(part.padEnd(2, '0')));
}
const dollar = cents => (cents / 100).toFixed(2);
const hash = value => createHash('sha256').update(value).digest('hex');
const sessionDate = instant => { const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(instant)); const get = type => parts.find(p => p.type === type).value; return `${get('year')}-${get('month')}-${get('day')}`; };
function quantity(value) { const n = Number(value); requireThat(Number.isSafeInteger(n) && n > 0 && n <= 1000000, 'INVALID_QUANTITY', '模拟数量须为1到1000000的整数。'); return n; }

export class PaperExecution {
  constructor(store, config, now = () => Date.now()) { this.store = store; this.config = config; this.now = now; }
  enabled() { requireThat(this.config.execution.mode === 'LOCAL_PAPER', 'EXECUTION_DISABLED', '当前为只读模式；请在服务配置中显式启用本地模拟。', 403); }
  createAccount(input) {
    this.enabled(); requireThat(input.currency === 'USD', 'UNSUPPORTED_CURRENCY', '本地模拟当前仅支持USD。');
    const cashCents = moneyCents(input.initialCash);
    return this.store.put('paperAccount', randomUUID(), { name: input.name, currency: 'USD', cashCents, positions: {}, mode: 'LOCAL_PAPER', initialCash: dollar(cashCents) }, 0);
  }
  account(id) { const a = this.store.require('paperAccount', id); return { ...a, cash: dollar(a.cashCents), synthetic: true }; }
  validateOrder(input) {
    requireThat(input && typeof input === 'object', 'INVALID_ORDER', '订单参数缺失。');
    requireThat(typeof input.symbol === 'string' && /^[A-Z0-9.\-]{1,40}$/.test(input.symbol), 'INVALID_SYMBOL', '订单标识无效。');
    requireThat(['STOCK', 'OPTION'].includes(input.assetClass) && ['BUY', 'SELL'].includes(input.side) && ['OPEN', 'CLOSE'].includes(input.positionEffect), 'INVALID_ORDER', '请明确资产类型、方向和开平仓。');
    requireThat(input.type === 'LIMIT' && ['DAY', 'GTC'].includes(input.timeInForce) && input.session === 'REGULAR', 'UNSUPPORTED_ORDER', '本地模拟支持常规时段DAY/GTC限价单；不隐含盘前盘后交易。');
    requireThat(input.currency === 'USD', 'UNSUPPORTED_CURRENCY', '本地模拟当前仅支持USD。');
    const qty = quantity(input.quantity), limitCents = moneyCents(input.limitPrice);
    requireThat(limitCents > 0, 'INVALID_PRICE', '限价须大于零。');
    const contract = input.assetClass === 'OPTION' && input.contract ? { right: input.contract.right, underlying: input.contract.underlying, multiplier: Number(input.contract.multiplier), strike: dollar(moneyCents(input.contract.strike)), expiration: input.contract.expiration, standardDeliverableVerified: input.contract.standardDeliverableVerified } : null;
    if (contract) {
      requireThat(['CALL', 'PUT'].includes(contract.right) && typeof contract.underlying === 'string' && /^[A-Z0-9.\-]{1,24}$/.test(contract.underlying) && contract.standardDeliverableVerified === true, 'UNVERIFIED_CONTRACT', '期权必须具有已核实的普通股票交割物。');
      quantity(contract.multiplier); requireThat(moneyCents(contract.strike) > 0, 'INVALID_STRIKE', '期权执行价必须大于零。');
      requireThat(/^\d{4}-\d{2}-\d{2}$/.test(contract.expiration) && Number.isFinite(Date.parse(contract.expiration)) && new Date(contract.expiration).toISOString().slice(0, 10) === contract.expiration && Date.parse(contract.expiration) > this.now(), 'INVALID_EXPIRATION', '期权到期日必须是未来有效日期。');
    }
    requireThat(input.assetClass !== 'OPTION' || contract, 'CONTRACT_REQUIRED', '缺少完整期权合约。');
    return { accountId: input.accountId ?? null, symbol: input.symbol, assetClass: input.assetClass, side: input.side, positionEffect: input.positionEffect, type: input.type, limitPrice: dollar(limitCents), quantity: qty, currency: 'USD', timeInForce: input.timeInForce, session: input.session, contract, estimatedFees: dollar(moneyCents(input.estimatedFees)), mode: 'LOCAL_PAPER' };
  }
  preview(input) {
    const order = this.validateOrder(input), confirmationToken = randomBytes(24).toString('hex');
    const id = randomUUID(), expiresAt = new Date(this.now() + this.config.limits.orderPreviewTtlMs).toISOString();
    const account = order.accountId ? this.store.require('paperAccount', order.accountId) : null;
    const row = this.store.put('order', id, { order, status: 'DRAFT', expiresAt, tokenHash: hash(confirmationToken), accountRevision: account?.revision ?? null, synthetic: true }, 0);
    return { id, confirmationToken, expiresAt, order, status: row.status, executionEnabled: this.config.execution.mode === 'LOCAL_PAPER', requiresHumanConfirmation: true };
  }
  orders(accountId) { return this.store.paperOrders({ accountId, limit: 1000 }).map(({ tokenHash, ...row }) => row); }
  /** Conservative cutoff matches preview validation: expiration UTC 00:00, not an exchange closing calendar. */
  requireActiveContract(order) {
    if (order.assetClass === 'OPTION') requireThat(Number.isFinite(Date.parse(order.contract?.expiration)) && Date.parse(order.contract.expiration) > this.now(), 'CONTRACT_EXPIRED', '合约已到本地保守截止日，禁止确认或新增模拟成交；未执行行权、交割或仓位结算。', 409);
  }
  /** Reserve all outstanding stock/option obligations. Order and open position refs are disjoint. */
  coverage(account, candidate, excludeId = null) {
    let cashReserved = 0; const sharesReserved = {};
    const add = (o, count, price, fee = 0) => {
      const mult = o.assetClass === 'OPTION' ? Number(o.contract.multiplier) : 1;
      if (o.side === 'BUY') cashReserved += count * mult * price + fee;
      else if (o.assetClass === 'STOCK') sharesReserved[o.symbol] = (sharesReserved[o.symbol] ?? 0) + count;
      else if (o.positionEffect === 'OPEN') {
        if (o.contract.right === 'PUT') cashReserved += count * mult * moneyCents(o.contract.strike) + fee;
        else { sharesReserved[o.contract.underlying] = (sharesReserved[o.contract.underlying] ?? 0) + count * mult; cashReserved += fee; }
      }
    };
    for (const p of Object.values(account.positions)) if (p.assetClass === 'OPTION' && p.quantity < 0) add({ ...p, side: 'SELL', positionEffect: 'OPEN' }, -p.quantity, 0);
    for (const o of this.store.paperOrders({ accountId: account.id, activeOnly: true })) if (o.id !== excludeId) add(o.order, o.remainingQuantity, moneyCents(o.order.limitPrice), Math.max(0, moneyCents(o.order.estimatedFees) - (o.paidFeesCents ?? 0)));
    if (candidate) add(candidate, candidate.quantity, moneyCents(candidate.limitPrice), moneyCents(candidate.estimatedFees));
    requireThat(Number.isSafeInteger(cashReserved), 'OVERFLOW', '模拟占用金额超出范围。');
    requireThat(account.cashCents >= cashReserved, 'CASH_COVERAGE', '模拟现金不足以覆盖全部挂单及Put接货义务。', 409, { cash: dollar(account.cashCents), reserved: dollar(cashReserved) });
    for (const [symbol, count] of Object.entries(sharesReserved)) requireThat((account.positions[symbol]?.quantity ?? 0) >= count, 'SHARE_COVERAGE', '模拟股份不足或已被其他Call/卖单占用。', 409, { symbol, required: count });
  }
  confirm({ id, confirmationToken }) {
    this.enabled(); this.expireDayOrders();
    return this.store.transaction(() => {
      const draft = this.store.require('order', id);
      requireThat(typeof confirmationToken === 'string' && hash(confirmationToken) === draft.tokenHash, 'CONFIRMATION_REQUIRED', '确认凭证无效。', 403);
      this.requireActiveContract(draft.order);
      if (draft.status !== 'DRAFT') { requireThat(['OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED'].includes(draft.status), 'ORDER_STATE', '订单状态不允许确认。', 409); return { id, status: draft.status, repeated: true, synthetic: true }; }
      requireThat(Date.parse(draft.expiresAt) > this.now(), 'PREVIEW_EXPIRED', '预览已过期，请重新预览。', 409);
      const account = this.store.require('paperAccount', draft.order.accountId);
      requireThat(account.revision === draft.accountRevision, 'VERSION_CONFLICT', '账户在预览后已变化，请重新核对。', 409);
      this.coverage(account, draft.order);
      const position = account.positions[draft.order.symbol];
      const sameContract = value => JSON.stringify(value ?? null) === JSON.stringify(draft.order.contract);
      requireThat(!position || position.assetClass === draft.order.assetClass && sameContract(position.contract), 'CONTRACT_CONFLICT', '证券标识对应的合约信息不一致。', 409);
      const pending = this.store.paperOrders({ accountId: account.id, activeOnly: true }).filter(o => o.order.symbol === draft.order.symbol);
      requireThat(pending.every(o => o.order.assetClass === draft.order.assetClass && sameContract(o.order.contract) && o.order.side === draft.order.side && o.order.positionEffect === draft.order.positionEffect), 'ORDER_CONFLICT', '同一标的存在方向或合约不同的未完成订单，请先处理。', 409);
      if (draft.order.positionEffect === 'CLOSE') {
        const sign = draft.order.side === 'BUY' ? -1 : 1;
        const closing = pending.filter(o => o.order.positionEffect === 'CLOSE' && o.order.side === draft.order.side).reduce((n, o) => n + o.remainingQuantity, 0);
        requireThat(position && Math.sign(position.quantity) === sign && Math.abs(position.quantity) >= draft.order.quantity + closing, 'CLOSE_COVERAGE', '可平仓数量不足。', 409);
      } else {
        requireThat(draft.order.assetClass !== 'STOCK' || draft.order.side === 'BUY', 'NAKED_STOCK', '本地模拟不支持股票裸卖。');
        requireThat(!position || position.quantity === 0 || Math.sign(position.quantity) === (draft.order.side === 'BUY' ? 1 : -1), 'POSITION_EFFECT', '已有反向仓位，请先明确平仓。');
      }
      this.store.put('order', id, { ...draft, status: 'OPEN', remainingQuantity: draft.order.quantity, filledQuantity: 0, paidFeesCents: 0, acceptedAt: new Date(this.now()).toISOString(), acceptedSessionDate: sessionDate(this.now()) }, draft.revision);
      this.store.put('paperAccount', account.id, account, account.revision);
      this.store.append({ operation: 'paper.order.confirm', orderId: id, mode: 'LOCAL_PAPER' });
      return { id, status: 'OPEN', synthetic: true, message: '已进入本地模拟订单簿，未发往券商。' };
    });
  }
  cancel({ id, revision }) {
    this.enabled(); this.expireDayOrders(); return this.store.transaction(() => {
      const row = this.store.require('order', id);
      requireThat(row.revision === revision && ['OPEN', 'PARTIALLY_FILLED', 'DRAFT'].includes(row.status), 'ORDER_STATE', '订单已变化或无法撤销。', 409);
      const result = this.store.put('order', id, { ...row, status: 'CANCELLED' }, revision);
      if (row.order.accountId) { const a = this.store.require('paperAccount', row.order.accountId); this.store.put('paperAccount', a.id, a, a.revision); }
      const { tokenHash, ...safe } = result; return safe;
    });
  }
  /** Explicit manual simulation fill; caller-supplied prices are not market evidence or broker fills. */
  fill({ id, revision, quantity: count, price, fee, eventId }) {
    this.enabled(); this.expireDayOrders(); requireThat(typeof eventId === 'string' && eventId.length > 0 && eventId.length <= 120, 'EVENT_ID_REQUIRED', '模拟成交需要唯一事件ID。');
    return this.store.transaction(() => {
      const previous = this.store.get('paperFill', eventId);
      if (previous) { requireThat(previous.orderId === id && previous.quantity === Number(count) && previous.price === dollar(moneyCents(price)) && previous.fee === dollar(moneyCents(fee)), 'EVENT_CONFLICT', '成交ID已用于不同内容。', 409); return previous; }
      const row = this.store.require('order', id); const qty = quantity(count), px = moneyCents(price), fees = moneyCents(fee);
      requireThat(row.revision === revision && ['OPEN', 'PARTIALLY_FILLED'].includes(row.status) && qty <= row.remainingQuantity, 'ORDER_STATE', '成交数量或订单版本无效。', 409);
      this.requireActiveContract(row.order);
      const o = row.order; const a = this.store.require('paperAccount', o.accountId);
      requireThat(px > 0 && (o.side === 'BUY' ? px <= moneyCents(o.limitPrice) : px >= moneyCents(o.limitPrice)), 'LIMIT_VIOLATION', '模拟成交价格违反限价。');
      const mult = o.assetClass === 'OPTION' ? Number(o.contract.multiplier) : 1; const notional = qty * mult * px;
      requireThat(Number.isSafeInteger(notional), 'OVERFLOW', '模拟成交金额超出范围。');
      const prior = a.positions[o.symbol] ?? { symbol: o.symbol, assetClass: o.assetClass, contract: o.contract, quantity: 0 };
      const signed = o.side === 'BUY' ? qty : -qty;
      requireThat(prior.assetClass === o.assetClass && JSON.stringify(prior.contract ?? null) === JSON.stringify(o.contract), 'CONTRACT_CONFLICT', '模拟持仓合约信息不一致。', 409);
      if (o.positionEffect === 'CLOSE') requireThat(Math.sign(prior.quantity) === -Math.sign(signed) && Math.abs(prior.quantity) >= qty, 'CLOSE_COVERAGE', '当前仓位不足以平仓。', 409);
      else requireThat(prior.quantity === 0 || Math.sign(prior.quantity) === Math.sign(signed), 'POSITION_EFFECT', '模拟持仓方向已变化，请重新预览。', 409);
      a.cashCents += (o.side === 'BUY' ? -notional : notional) - fees;
      requireThat(Number.isSafeInteger(a.cashCents) && a.cashCents >= 0, 'CASH_OVERFLOW', '模拟现金不足或金额超出范围。', 409);
      a.positions[o.symbol] = { ...prior, quantity: prior.quantity + signed };
      const remaining = row.remainingQuantity - qty;
      this.store.put('order', id, { ...row, status: remaining ? 'PARTIALLY_FILLED' : 'FILLED', remainingQuantity: remaining, filledQuantity: row.filledQuantity + qty, paidFeesCents: (row.paidFeesCents ?? 0) + fees }, row.revision);
      this.coverage(a, null);
      this.store.put('paperAccount', a.id, a, a.revision);
      const fill = this.store.put('paperFill', eventId, { orderId: id, accountId: a.id, symbol: o.symbol, quantity: qty, price: dollar(px), fee: dollar(fees), synthetic: true, source: 'USER_SIMULATION_INPUT', occurredAt: new Date(this.now()).toISOString() }, 0);
      this.store.append({ operation: 'paper.fill', eventId, orderId: id, synthetic: true }); return fill;
    });
  }
  /** DAY is a local simulation session date, not an exchange calendar or a broker cancellation. */
  expireDayOrders() {
    if (this.config.execution.mode !== 'LOCAL_PAPER') return [];
    return this.store.transaction(() => {
      const expired = [], touched = new Set(); const today = sessionDate(this.now());
      for (const row of this.store.paperOrders({ activeOnly: true })) if (row.order.timeInForce === 'DAY' && sessionDate(row.acceptedAt) < today) {
        this.store.put('order', row.id, { ...row, status: 'EXPIRED', expiredAt: new Date(this.now()).toISOString() }, row.revision); expired.push(row.id); touched.add(row.order.accountId);
      }
      for (const id of touched) { const account = this.store.require('paperAccount', id); this.store.put('paperAccount', id, account, account.revision); }
      return expired;
    });
  }
}
