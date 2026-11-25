/** Local conditional previews. A trigger creates a DRAFT, never an accepted order or fill. */
import { randomUUID, createHash } from 'node:crypto';
import { requireThat } from './errors.js';
import { moneyCents } from './paper.js';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const money = value => (value / 100).toFixed(2);
const object = (value, allowed, label) => { requireThat(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key)), 'INVALID_CONDITION', `${label}字段无效。`); };
const timestamp = (value, label) => { requireThat(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value)) && Number.isFinite(Date.parse(value.slice(0, 10))) && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10), 'INVALID_TIME', `${label}须为带时区的有效ISO时间。`); return Date.parse(value); };
const safePreview = ({ confirmationToken, ...preview }) => preview;

export class ConditionalPaper {
  constructor(store, paper, now = () => Date.now()) { this.store = store; this.paper = paper; this.now = now; }
  create(input) {
    object(input, ['name', 'kind', 'maxAgeMs', 'expiresAt', 'legs'], '条件规则');
    requireThat(typeof input.name === 'string' && input.name.trim() && input.name.length <= 200, 'INVALID_CONDITION', '条件规则名称无效。');
    requireThat(['SINGLE', 'OCO'].includes(input.kind), 'INVALID_CONDITION', '条件规则类型须为SINGLE或OCO。');
    requireThat(Number.isSafeInteger(input.maxAgeMs) && input.maxAgeMs >= 1 && input.maxAgeMs <= 86400000, 'INVALID_CONDITION', '请明确最大行情年龄，最多24小时。');
    requireThat(timestamp(input.expiresAt, '规则截止时间') > this.now(), 'CONDITION_EXPIRED', '规则截止时间必须在未来。');
    requireThat(Array.isArray(input.legs) && input.legs.length === (input.kind === 'OCO' ? 2 : 1), 'INVALID_CONDITION', '单条件须有1个分支，OCO须有2个分支。');
    const legs = input.legs.map((leg, index) => {
      object(leg, ['type', 'triggerPrice', 'order'], '条件分支');
      requireThat(['STOP_LIMIT', 'TAKE_PROFIT_LIMIT'].includes(leg.type), 'INVALID_CONDITION', '仅支持STOP_LIMIT和TAKE_PROFIT_LIMIT。');
      const triggerCents = moneyCents(leg.triggerPrice); requireThat(triggerCents > 0, 'INVALID_PRICE', '触发价必须大于零。');
      object(leg.order, ['accountId', 'symbol', 'assetClass', 'side', 'positionEffect', 'quantity', 'type', 'limitPrice', 'currency', 'timeInForce', 'session', 'estimatedFees', 'contract'], '预览订单');
      requireThat(typeof leg.order.quantity === 'number' && Number.isSafeInteger(leg.order.quantity), 'INVALID_QUANTITY', '条件订单数量须为明确整数。');
      if (leg.order.assetClass === 'OPTION') {
        object(leg.order.contract, ['right', 'underlying', 'multiplier', 'strike', 'expiration', 'standardDeliverableVerified'], '期权合约');
        requireThat(typeof leg.order.contract.multiplier === 'number' && Number.isSafeInteger(leg.order.contract.multiplier), 'UNVERIFIED_CONTRACT', '期权乘数须为明确整数。');
      }
      const order = this.paper.validateOrder(leg.order);
      if (order.accountId !== null) this.store.require('paperAccount', order.accountId);
      if (order.assetClass === 'OPTION') requireThat(Date.parse(input.expiresAt) <= Date.parse(order.contract.expiration), 'INVALID_CONDITION', '条件截止时间不能晚于合约本地保守截止日。');
      return { id: `leg-${index + 1}`, type: leg.type, triggerPrice: money(triggerCents), order, status: 'ARMED' };
    });
    if (input.kind === 'OCO') {
      requireThat(new Set(legs.map(leg => leg.type)).size === 2, 'INVALID_OCO', 'OCO须包含一个止损和一个止盈分支。');
      const [first, second] = legs;
      const identity = order => { const { limitPrice, estimatedFees, ...rest } = order; return rest; };
      requireThat(first.order.positionEffect === 'CLOSE' && hash(identity(first.order)) === hash(identity(second.order)), 'INVALID_OCO', 'OCO仅用于同一标的、账户、方向和数量的平仓计划。');
      const stop = legs.find(leg => leg.type === 'STOP_LIMIT'), take = legs.find(leg => leg.type === 'TAKE_PROFIT_LIMIT');
      requireThat(first.order.side === 'SELL' ? moneyCents(stop.triggerPrice) < moneyCents(take.triggerPrice) : moneyCents(take.triggerPrice) < moneyCents(stop.triggerPrice), 'INVALID_OCO', '止损和止盈触发区间不能重叠。');
    }
    return this.store.put('conditionOrder', randomUUID(), { name: input.name.trim(), kind: input.kind, maxAgeMs: input.maxAgeMs, expiresAt: new Date(input.expiresAt).toISOString(), symbol: legs[0].order.symbol, assetClass: legs[0].order.assetClass, currency: 'USD', priceUnit: legs[0].order.assetClass === 'OPTION' ? 'USD_PER_UNDERLYING_UNIT' : 'USD_PER_SHARE', accountId: legs[0].order.accountId, legs, status: 'ARMED', createdAt: new Date(this.now()).toISOString(), mode: 'LOCAL_CONDITIONAL_PREVIEW', reservesResources: false, submitsOrder: false, requiresHumanConfirmation: true }, 0);
  }
  list({ limit = 200, offset = 0 } = {}) { return this.store.list('conditionOrder', { limit, offset }); }
  get(id) { return this.store.require('conditionOrder', id); }
  cancel({ id, revision }) {
    return this.store.transaction(() => {
      const rule = this.get(id);
      requireThat(rule.revision === revision && rule.status === 'ARMED', 'CONDITION_STATE', '规则已变更或不能取消。', 409);
      return this.store.put('conditionOrder', id, { ...rule, status: 'CANCELLED', legs: rule.legs.map(leg => ({ ...leg, status: 'CANCELLED' })), cancelledAt: new Date(this.now()).toISOString() }, revision);
    });
  }
  evaluate(input) {
    object(input, ['id', 'revision', 'eventId', 'quote'], '条件检查');
    requireThat(typeof input.eventId === 'string' && input.eventId.trim() && input.eventId.length <= 120, 'EVENT_ID_REQUIRED', '条件检查须有唯一事件ID。');
    object(input.quote, ['symbol', 'assetClass', 'currency', 'priceUnit', 'contract', 'price', 'asOf', 'source', 'synthetic'], '行情');
    requireThat(typeof input.quote.source === 'string' && input.quote.source.trim() && input.quote.source.length <= 300 && typeof input.quote.synthetic === 'boolean', 'SOURCE_REQUIRED', '须明确行情来源和是否合成数据。');
    requireThat(typeof input.quote.symbol === 'string' && /^[A-Z0-9.\-]{1,40}$/.test(input.quote.symbol), 'INVALID_SYMBOL', '行情标的无效。');
    const quoteTime = timestamp(input.quote.asOf, '行情时间'), priceCents = moneyCents(input.quote.price); requireThat(priceCents > 0, 'INVALID_PRICE', '行情价格须为正数。');
    requireThat(['STOCK', 'OPTION'].includes(input.quote.assetClass) && input.quote.currency === 'USD' && input.quote.priceUnit === (input.quote.assetClass === 'OPTION' ? 'USD_PER_UNDERLYING_UNIT' : 'USD_PER_SHARE'), 'UNKNOWN_PRICE_BASIS', '须明确报价资产类型、USD币种及股票/期权权利金单位。');
    let contract = null;
    if (input.quote.assetClass === 'OPTION') {
      object(input.quote.contract, ['right', 'underlying', 'multiplier', 'strike', 'expiration', 'standardDeliverableVerified'], '报价期权合约');
      const supplied = input.quote.contract;
      requireThat(typeof supplied.multiplier === 'number' && Number.isSafeInteger(supplied.multiplier), 'UNVERIFIED_CONTRACT', '报价期权乘数须为明确整数。');
      contract = { right: supplied.right, underlying: supplied.underlying, multiplier: supplied.multiplier, strike: money(moneyCents(supplied.strike)), expiration: supplied.expiration, standardDeliverableVerified: supplied.standardDeliverableVerified };
    } else requireThat(input.quote.contract === undefined || input.quote.contract === null, 'CONTRACT_MISMATCH', '股票报价不能附带期权合约。');
    const quote = { symbol: input.quote.symbol, assetClass: input.quote.assetClass, currency: input.quote.currency, priceUnit: input.quote.priceUnit, contract, price: money(priceCents), asOf: new Date(quoteTime).toISOString(), source: input.quote.source, synthetic: input.quote.synthetic };
    const eventKey = hash([input.id, input.eventId]), inputHash = hash([input.id, input.eventId, quote]);
    return this.store.transaction(() => {
      const previous = this.store.get('conditionEvaluation', eventKey);
      if (previous) { requireThat(previous.inputHash === inputHash, 'EVENT_CONFLICT', '条件事件ID已用于不同内容。', 409); return { ...previous.result, repeated: true, confirmationTokenAvailable: false }; }
      const rule = this.get(input.id);
      requireThat(rule.revision === input.revision && rule.status === 'ARMED', 'CONDITION_STATE', '规则已变更或不再等待触发。', 409);
      requireThat(rule.symbol === quote.symbol, 'SYMBOL_MISMATCH', '行情标的与规则不一致。');
      requireThat(rule.legs[0].order.assetClass === quote.assetClass && hash(rule.legs[0].order.contract) === hash(quote.contract), 'CONTRACT_MISMATCH', '报价必须对应规则的同一资产类型及完整期权合约。');
      requireThat(quoteTime <= this.now() && this.now() - quoteTime <= rule.maxAgeMs, 'STALE_CONDITION_DATA', '行情是未来或已过期；本次未触发。');
      requireThat(!rule.lastQuote || Date.parse(rule.lastQuote.asOf) <= quoteTime, 'OUT_OF_ORDER_QUOTE', '行情早于上次检查；本次未触发。');
      let result;
      if (Date.parse(rule.expiresAt) <= this.now()) {
        const expired = this.store.put('conditionOrder', rule.id, { ...rule, status: 'EXPIRED', legs: rule.legs.map(leg => ({ ...leg, status: 'EXPIRED' })), expiredAt: new Date(this.now()).toISOString() }, rule.revision);
        result = { condition: expired, matched: false, reason: 'EXPIRED', orderSubmitted: false };
      } else {
        const match = rule.legs.find(leg => {
          const trigger = moneyCents(leg.triggerPrice), rising = leg.type === 'STOP_LIMIT' ? leg.order.side === 'BUY' : leg.order.side === 'SELL';
          return rising ? priceCents >= trigger : priceCents <= trigger;
        });
        if (match) {
          const preview = this.paper.preview(match.order);
          const updated = this.store.put('conditionOrder', rule.id, { ...rule, status: 'TRIGGERED', legs: rule.legs.map(leg => ({ ...leg, status: leg.id === match.id ? 'TRIGGERED' : 'CANCELLED_BY_OCO' })), triggeredLegId: match.id, triggeredAt: new Date(this.now()).toISOString(), triggerQuote: quote, lastEventId: input.eventId, draftId: preview.id }, rule.revision);
          result = { condition: updated, matched: true, draft: preview, orderSubmitted: false, requiresHumanConfirmation: true, quoteAuthority: quote.synthetic ? 'SYNTHETIC_SCENARIO' : 'USER_REPORTED_QUOTE_UNVERIFIED' };
        } else {
          const updated = this.store.put('conditionOrder', rule.id, { ...rule, lastCheckedAt: new Date(this.now()).toISOString(), lastQuote: quote, lastEventId: input.eventId }, rule.revision);
          result = { condition: updated, matched: false, orderSubmitted: false, quoteAuthority: quote.synthetic ? 'SYNTHETIC_SCENARIO' : 'USER_REPORTED_QUOTE_UNVERIFIED' };
        }
      }
      const safeResult = result.draft ? { ...result, draft: safePreview(result.draft) } : result;
      this.store.put('conditionEvaluation', eventKey, { inputHash, eventId: input.eventId, conditionId: rule.id, result: safeResult }, 0);
      this.store.append({ operation: 'condition.evaluate', conditionId: rule.id, matched: result.matched, eventId: input.eventId, synthetic: quote.synthetic, orderSubmitted: false });
      return result;
    });
  }
  /** Explicit human operation if a previous response was lost or the prior draft expired. */
  previewTriggered({ id, revision }) {
    return this.store.transaction(() => {
      const rule = this.get(id); requireThat(rule.revision === revision && rule.status === 'TRIGGERED', 'CONDITION_STATE', '规则版本已变化或尚未触发。', 409);
      const leg = rule.legs.find(item => item.id === rule.triggeredLegId);
      const prior = this.store.require('order', rule.draftId);
      requireThat(prior.status === 'DRAFT' || prior.status === 'CANCELLED' && !prior.acceptedAt, 'CONDITION_ALREADY_ACCEPTED', '之前的草稿已被接受，不能再次创建同一触发预览。', 409);
      const preview = this.paper.preview(leg.order);
      // Supersede a lost draft so two confirmation tokens cannot both remain usable.
      if (prior.status === 'DRAFT') this.store.put('order', prior.id, { ...prior, status: 'CANCELLED', supersededBy: preview.id }, prior.revision);
      const condition = this.store.put('conditionOrder', id, { ...rule, draftId: preview.id }, rule.revision);
      return { condition, draft: preview, requiresHumanConfirmation: true, orderSubmitted: false };
    });
  }
}
