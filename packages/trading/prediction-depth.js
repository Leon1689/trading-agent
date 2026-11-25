/** Normalize public order books without manufacturing source timestamps or executable quotes. */
import { requireThat } from './errors.js';
const scalar=(value,max)=>{requireThat((typeof value==='number'||typeof value==='string')&&String(value).trim()!==''&&Number.isFinite(Number(value))&&Number(value)>=0&&Number(value)<=max,'UPSTREAM_SCHEMA','预测市场深度数值无效。',502);return Number(value);};
function levels(rows,ascending){
  requireThat(Array.isArray(rows)&&rows.length<=10000,'UPSTREAM_SCHEMA','预测市场深度格式或大小无效。',502);
  const seen=new Set();
  return rows.map(row=>{
    const price=scalar(row.price,1), quantity=scalar(row.quantity,1e12);
    requireThat(!seen.has(price),'UPSTREAM_SCHEMA','预测市场深度含重复价格。',502);seen.add(price);
    return {price:String(price),quantity:String(quantity)};
  }).filter(row=>Number(row.quantity)>0).sort((a,b)=>(ascending?1:-1)*(Number(a.price)-Number(b.price)));
}
function shape(bids,asks){
  bids=levels(bids,false);asks=levels(asks,true);
  requireThat(!bids.length||!asks.length||Number(bids[0].price)<=Number(asks[0].price),'UPSTREAM_SCHEMA','预测市场深度交叉，不能使用。',502);
  return {bids,asks,bestBid:bids[0]?.price??null,bestAsk:asks[0]?.price??null,spread:bids.length&&asks.length?String(Number((Number(asks[0].price)-Number(bids[0].price)).toFixed(12))):null};
}
export function kalshiDepth(raw,outcomeIndex){
  requireThat(raw?.orderbook_fp&&[0,1].includes(outcomeIndex),'UPSTREAM_SCHEMA','缺少固定小数美元盘口。',502);
  const parse=value=>{requireThat(Array.isArray(value),'UPSTREAM_SCHEMA','盘口分支缺失。',502);return value.map(row=>{requireThat(Array.isArray(row)&&row.length===2,'UPSTREAM_SCHEMA','盘口价阶无效。',502);return {price:row[0],quantity:row[1]};});};
  const yes=parse(raw.orderbook_fp.yes_dollars),no=parse(raw.orderbook_fp.no_dollars);
  // Validate both original bid books before applying the binary complement identity.
  const own=levels(outcomeIndex===0?yes:no,false),opposite=levels(outcomeIndex===0?no:yes,false);
  return {...shape(own,opposite.map(row=>({...row,price:String(Number((1-Number(row.price)).toFixed(12)))}))),asOf:null,askBasis:'BINARY_COMPLEMENT_OF_OPPOSITE_BID',missing:['source_timestamp_not_supplied','fees_not_included']};
}
export function polymarketDepth(raw,tokenId,conditionId){
  requireThat(raw&&String(raw.asset_id)===tokenId&&typeof conditionId==='string'&&raw.market===conditionId,'UPSTREAM_SCHEMA','盘口标的与查询市场不匹配。',502);
  const parse=value=>{requireThat(Array.isArray(value),'UPSTREAM_SCHEMA','盘口价阶缺失。',502);return value.map(row=>({price:row.price,quantity:row.size}));};
  const ms=typeof raw.timestamp==='string'&&/^\d{13}$/.test(raw.timestamp)?Number(raw.timestamp):null;
  return {...shape(parse(raw.bids),parse(raw.asks)),asOf:ms!==null&&Number.isFinite(ms)?new Date(ms).toISOString():null,askBasis:'EXPLICIT_SELL_BOOK',missing:[...(ms===null?['source_timestamp_unknown_units']:[]),'fees_not_included'],minOrderSize:raw.min_order_size??null,tickSize:raw.tick_size??null};
}
