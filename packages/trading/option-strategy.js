/** Expiry payoff for same-underlying, same-expiry standard option combinations. */
import { priceOption } from './quant.js';
import { requireThat } from './errors.js';

const numeric = (value, name, min, max) => {
  requireThat(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max, 'INVALID_STRATEGY', `${name}超出支持范围。`);
  return value;
};
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
const round = value => Number(value.toFixed(8));
export function analyzeOptionStrategy(input) {
  requireThat(input.currency === 'USD' && typeof input.underlying === 'string' && /^[A-Z0-9.-]{1,24}$/.test(input.underlying), 'INVALID_STRATEGY', '须明确美元标的。');
  requireThat(Array.isArray(input.legs) && input.legs.length >= 1 && input.legs.length <= 16, 'INVALID_STRATEGY', '组合须有1至16腿。');
  const fees = numeric(input.totalFees, '总费用', 0, 1e8);
  const expiries = new Set();
  const legs = input.legs.map((leg, index) => {
    requireThat(leg && typeof leg === 'object' && Object.keys(leg).every(k => ['assetClass','side','quantity','entryPrice','right','strike','expiration','multiplier','standardDeliverableVerified','volatility'].includes(k)), 'INVALID_STRATEGY', '腿字段无效。');
    requireThat(['STOCK','OPTION'].includes(leg.assetClass) && ['BUY','SELL'].includes(leg.side), 'INVALID_STRATEGY', '资产类型或方向无效。');
    const quantity = numeric(leg.quantity, '数量', 1, 1000000); requireThat(Number.isSafeInteger(quantity), 'INVALID_STRATEGY', '数量须为整数。');
    const entryPrice = numeric(leg.entryPrice, '建仓价格', 0, 1e6);
    if (leg.assetClass === 'OPTION') {
      requireThat(['CALL','PUT'].includes(leg.right) && day(leg.expiration) && leg.standardDeliverableVerified === true, 'UNVERIFIED_CONTRACT', '须明确期权方向、到期日并核对标准交割。');
      numeric(leg.strike, '执行价', 0.0001, 1e6);
      numeric(leg.multiplier, '乘数', 1, 10000); requireThat(Number.isSafeInteger(leg.multiplier), 'INVALID_STRATEGY', '乘数须为整数。');
      expiries.add(leg.expiration);
      if (leg.volatility !== undefined) numeric(leg.volatility, '波动率', 0, 5);
    } else requireThat(['right','strike','expiration','multiplier','volatility','standardDeliverableVerified'].every(k => leg[k] === undefined), 'INVALID_STRATEGY', '股票腿不能带期权字段。');
    return {...leg, quantity, entryPrice, multiplier: leg.assetClass === 'OPTION' ? leg.multiplier : 1, id:index+1};
  });
  requireThat(expiries.size === 1, 'UNSUPPORTED_EXPIRY', '到期损益仅支持同一到期日，跨期组合需独立情景模型。');
  const factor = leg => (leg.side === 'BUY' ? 1 : -1) * leg.quantity * leg.multiplier;
  const payoff = spot => legs.reduce((sum, leg) => sum + factor(leg) * ((leg.assetClass === 'STOCK' ? spot : Math.max(leg.right === 'CALL' ? spot-leg.strike : leg.strike-spot,0)) - leg.entryPrice), -fees);
  const knots = [...new Set([0,...legs.filter(l=>l.assetClass==='OPTION').map(l=>l.strike)])].sort((a,b)=>a-b);
  const breakEven = [], zeroIntervals = [];
  const addRoot = value => { const x=round(value); if(!breakEven.includes(x))breakEven.push(x); };
  for(let i=0;i<knots.length-1;i++) {
    const a=knots[i], b=knots[i+1], pa=payoff(a), pb=payoff(b);
    if(Math.abs(pa)<1e-8 && Math.abs(pb)<1e-8) zeroIntervals.push({from:a,to:b});
    else { if(Math.abs(pa)<1e-8)addRoot(a); if(Math.abs(pb)<1e-8)addRoot(b); if(pa*pb<0)addRoot(a-pa*(b-a)/(pb-pa)); }
  }
  const end=knots.at(-1), endValue=payoff(end), slope=legs.reduce((n,l)=>n+(l.assetClass==='STOCK'||l.right==='CALL'?factor(l):0),0);
  if(slope===0 && Math.abs(endValue)<1e-8)zeroIntervals.push({from:end,to:null});
  else if(slope!==0 && end-endValue/slope>=end)addRoot(end-endValue/slope);
  const values=knots.map(payoff), low=Math.min(...values), high=Math.max(...values);
  const maxProfit=slope>0?null:round(Math.max(0,high)), maxLoss=slope<0?null:round(Math.max(0,-low));
  let greeks=null; const missing=[];
  if(input.valuation) {
    const v=input.valuation;
    requireThat(v && typeof v==='object' && Object.keys(v).every(k=>['model','spot','timeYears','rate','dividendYield','steps'].includes(k)), 'INVALID_STRATEGY', '估值字段无效。');
    if(v.model==='CRR')numeric(v.steps,'组合CRR步数',3,200);
    const names=['delta','gamma','thetaPerDay','vegaPerPercentagePoint','rhoPerPercentagePoint'];
    greeks=Object.fromEntries(names.map(n=>[n,0]));
    for(const leg of legs) {
      if(leg.assetClass==='STOCK') { greeks.delta+=factor(leg); continue; }
      if(leg.volatility===undefined){missing.push(`leg_${leg.id}_volatility`);greeks=null;break;}
      const result=priceOption({...v,right:leg.right,strike:leg.strike,volatility:leg.volatility});
      for(const key of names)greeks[key]=greeks[key]===null||result.greeks[key]===null?null:greeks[key]+factor(leg)*result.greeks[key];
    }
  } else missing.push('valuation_inputs_and_greeks');
  const maxSpot=input.maxSpot===undefined?Math.max(end*1.5,1):numeric(input.maxSpot,'曲线价格上界',end,1e7);
  const points=[...new Set([...knots,...breakEven.filter(x=>x<=maxSpot),...Array.from({length:81},(_,i)=>round(maxSpot*i/80))])].sort((a,b)=>a-b);
  return {underlying:input.underlying,expiration:[...expiries][0],currency:'USD',legs,totalFees:fees,netEntryCashFlow:round(-legs.reduce((n,l)=>n+factor(l)*l.entryPrice,0)-fees),maxProfit,maxLoss,unboundedProfit:slope>0,unboundedLoss:slope<0,breakEven:breakEven.sort((a,b)=>a-b),zeroProfitIntervals:zeroIntervals,payoffCurve:points.map(spot=>({spot,profit:round(payoff(spot))})),greeks,greekUnits:'USD portfolio sensitivity; delta per $1, theta per day, vega/rho per percentage point',missing,assumptions:['Same underlying and expiry; standard unadjusted deliverables','Expiry intrinsic value only; no early assignment, exercise cash needs, dividends, borrow or financing costs','Greeks are theoretical estimates at supplied valuation inputs; not broker margin'],orderSubmissionEnabled:false};
}
