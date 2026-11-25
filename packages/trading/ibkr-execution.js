/** Fixed IBKR paper gateway transport. No arbitrary HTTP, credentials, warning suppression or POST retry. */
import {requireThat,TradingError} from './errors.js';
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const assertObject=x=>{requireThat(object(x),'IBKR_SCHEMA','券商响应格式不符。',502);return x;};
const text=x=>typeof x==='string'?x.slice(0,4000):null;
export function ibkrExecutionConfig(input){
 if(!input)return null;
 let u;try{u=new URL(input.baseUrl);}catch{throw new TradingError('INVALID_CONFIG','执行网关需要本机/v1/api地址。');}
 requireThat(['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&['http:','https:'].includes(u.protocol)&&u.pathname.replace(/\/$/,'')==='/v1/api'&&!u.username&&!u.password&&!u.search&&!u.hash,'INVALID_CONFIG','执行网关仅允许本机/v1/api地址。');
 requireThat(input.environment==='PAPER'&&Array.isArray(input.accountIds)&&input.accountIds.length>0&&input.accountIds.every(id=>/^DU\d{1,18}$/.test(id)),'INVALID_CONFIG','仅支持明确PAPER环境及DU模拟账户白名单。');
 return{baseUrl:u.href.replace(/\/$/,''),environment:'PAPER',accountIds:[...new Set(input.accountIds)]};
}
export class IbkrPaperGateway{
 constructor(config,{fetchImpl=fetch,now=()=>Date.now(),pacing=true}={}){this.config=ibkrExecutionConfig(config);this.fetch=fetchImpl;this.now=now;this.pacing=pacing;this.next=new Map();this.queue=Promise.resolve();}
 async request(method,path,{query={},body,signal}={}){
  requireThat(this.config,'IBKR_EXECUTION_UNCONFIGURED','请先配置IBKR模拟执行网关及账户白名单。',503);
  const prior=this.queue;let release;this.queue=new Promise(r=>{release=r;});await prior;
  try{
   signal?.throwIfAborted();const rate=path==='/iserver/accounts'||path==='/iserver/account/orders'?5000:250;
   const delay=(this.next.get(path)??0)-this.now();if(this.pacing&&delay>0)await new Promise((resolve,reject)=>{const stop=()=>{clearTimeout(timer);reject(signal.reason);};const timer=setTimeout(()=>{signal?.removeEventListener('abort',stop);resolve();},delay);signal?.addEventListener('abort',stop,{once:true});});
   signal?.throwIfAborted();this.next.set(path,this.now()+rate);
   const url=new URL(this.config.baseUrl+path);for(const[k,v]of Object.entries(query))if(v!==undefined)url.searchParams.set(k,String(v));
   const combined=AbortSignal.any([AbortSignal.timeout(15000),...(signal?[signal]:[])]);
   let response;try{response=await this.fetch(url,{method,headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:combined});}catch{throw new TradingError('IBKR_TRANSPORT','券商请求未取得明确结果；写入请求不得自动重试。',502);}
   requireThat(response.ok,'IBKR_HTTP','券商请求未取得成功响应。',502);
   let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;requireThat(size<=2*1024*1024,'IBKR_RESPONSE_LIMIT','券商响应过大。',502);chunks.push(chunk);}
   try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new TradingError('IBKR_SCHEMA','券商响应不是有效JSON。',502);}
  }finally{release();}
 }
 async session(accountId,signal){
  requireThat(this.config?.accountIds.includes(accountId),'EXECUTION_ACCOUNT_DENIED','账户不在独立的模拟执行白名单。',403);
  const a=assertObject(await this.request('GET','/iserver/accounts',{signal}));
  requireThat(a.isPaper===true&&Array.isArray(a.accounts)&&a.accounts.includes(accountId)&&a.selectedAccount===accountId,'IBKR_PAPER_SESSION_REQUIRED','必须登录并选中指定的IBKR模拟账户；实盘、未知环境或其他账户拒绝提交。',403);
  return{accountId,isPaper:true,checkedAt:new Date(this.now()).toISOString()};
 }
 async search(symbol,signal){requireThat(/^[A-Z][A-Z0-9.\-]{0,23}$/.test(symbol),'INVALID_SYMBOL','请提供精确标的代码。');const rows=await this.request('GET','/iserver/secdef/search',{query:{symbol,secType:'STK'},signal});requireThat(Array.isArray(rows),'IBKR_SCHEMA','合约搜索响应无效。',502);return rows.slice(0,100).map(x=>({conid:x.conid,symbol:x.symbol,description:x.description,companyName:x.companyName,sections:x.sections}));}
 async options(a,signal){
  requireThat(Number.isSafeInteger(a.underlyingConid)&&a.underlyingConid>0&&/^[A-Z]{3}\d{2}$/.test(a.month),'INVALID_CONTRACT','标的合约及月份无效。');
  const candidates=await this.search(a.symbol,signal);requireThat(candidates.some(x=>Number(x.conid)===a.underlyingConid&&x.symbol===a.symbol),'CONTRACT_MISMATCH','标的合约不匹配。');
  const query={conid:a.underlyingConid,secType:'OPT',month:a.month,exchange:'SMART'};
  const strikes=await this.request('GET','/iserver/secdef/strikes',{query,signal});
  if(a.strike===undefined)return{strikes};
  requireThat(['CALL','PUT'].includes(a.right)&&/^\d+(\.\d{1,4})?$/.test(a.strike)&&Number(a.strike)>0,'INVALID_CONTRACT','需要明确期权方向及行权价。');
  const rows=await this.request('GET','/iserver/secdef/info',{query:{...query,strike:a.strike,right:a.right==='CALL'?'C':'P'},signal});requireThat(Array.isArray(rows),'IBKR_SCHEMA','期权合约响应无效。',502);
  return{contracts:rows.map(x=>({conid:x.conid,symbol:x.symbol,secType:x.secType,maturityDate:x.maturityDate,right:x.right,strike:x.strike,multiplier:x.multiplier,currency:x.currency,tradingClass:x.tradingClass}))};
 }
 async instrument(f,signal){
  const x=assertObject(await this.request('GET',`/iserver/contract/${f.conid}/info-and-rules`,{query:{isBuy:f.side==='BUY'},signal}));
  requireThat(Number(x.con_id)===f.conid&&x.symbol===f.symbol&&x.currency===f.currency&&x.instrument_type===(f.assetClass==='STOCK'?'STK':'OPT'),'CONTRACT_MISMATCH','券商合约与需求的标的、类型或币种不一致。',409);
  if(f.assetClass==='OPTION'){
   // OCC symbol independently binds expiry/right/strike; multiplier comes from broker metadata.
   const occ=String(x.local_symbol??'').match(/^([A-Z0-9. ]{1,6})\s*(\d{6})([CP])(\d{8})$/);
   requireThat(occ&&`20${occ[2].slice(0,2)}-${occ[2].slice(2,4)}-${occ[2].slice(4,6)}`===f.expiration&&occ[3]===(f.right==='CALL'?'C':'P')&&Number(occ[4])/1000===Number(f.strike)&&Number(x.multiplier)===f.multiplier,'CONTRACT_MISMATCH','期权日期、方向、行权价或乘数无法与券商合约核对。',409);
  }
  return{conid:f.conid,symbol:x.symbol,localSymbol:x.local_symbol,assetClass:f.assetClass,currency:x.currency,multiplier:f.assetClass==='STOCK'?1:Number(x.multiplier),description:x.company_name,brokerMetadata:true};
 }
 payload(f,clientOrderId){return{acctId:f.accountId,conid:f.conid,secType:`${f.conid}:${f.assetClass==='STOCK'?'STK':'OPT'}`,cOID:clientOrderId,orderType:'LMT',side:f.side,tif:f.timeInForce,quantity:f.quantity,price:Number(f.limitPrice),outsideRTH:false};}
 async positionEffect(f,signal){
  // Position effect is local intent: IBKR nets quantities, so check it explicitly before writing.
  const accounts=await this.request('GET','/portfolio/accounts',{signal});
  requireThat(Array.isArray(accounts)&&accounts.some(a=>a.accountId===f.accountId||a.id===f.accountId),'IBKR_POSITION_UNAVAILABLE','无法核对账户持仓范围。',409);
  let positions=[],complete=false;
  for(let page=0;page<100;page++){
   const part=await this.request('GET',`/portfolio/${f.accountId}/positions/${page}`,{signal});
   requireThat(Array.isArray(part)&&part.every(x=>!x.acctId||x.acctId===f.accountId),'IBKR_POSITION_UNAVAILABLE','持仓分页格式或账户不符。',409);positions.push(...part);if(part.length<100){complete=true;break;}
  }
  requireThat(complete,'IBKR_POSITION_UNAVAILABLE','持仓不完整，不能验证开平仓。',409);
  const rows=positions.filter(x=>Number(x.conid)===f.conid);requireThat(rows.length<=1,'IBKR_POSITION_UNAVAILABLE','合约持仓存在重复。',409);
  const qty=rows.length?Number(rows[0].position):0;requireThat(Number.isFinite(qty),'IBKR_POSITION_UNAVAILABLE','持仓数量未知。',409);
  const orders=assertObject(await this.request('GET','/iserver/account/orders',{query:{accountId:f.accountId,force:true},signal}));
  requireThat(orders.snapshot===true&&Array.isArray(orders.orders)&&orders.orders.every(o=>(o.account??o.acct)),'IBKR_POSITION_UNAVAILABLE','当前挂单快照不完整。',409);
  requireThat(!orders.orders.some(o=>(o.account??o.acct)===f.accountId&&Number(o.conid)===f.conid&&!['Filled','Cancelled','Canceled','Inactive'].includes(o.status)),'POSITION_ORDER_CONFLICT','同合约已有挂单，请先核对，避免重复占用。',409);
  const sign=f.side==='BUY'?1:-1;
  if(f.positionEffect==='CLOSE')requireThat(qty*sign<0&&Math.abs(qty)>=f.quantity,'CLOSE_COVERAGE','券商可见持仓无法覆盖本次平仓数量。',409);
  else requireThat(qty===0||qty*sign>0,'POSITION_EFFECT','已有反向持仓，请明确平仓；不能把净额操作误标为开仓。',409);
  return{position:qty,observedAt:new Date(this.now()).toISOString(),atomic:false};
 }
 async preview(f,clientOrderId,signal){
  const session=await this.session(f.accountId,signal),instrument=await this.instrument(f,signal),position=await this.positionEffect(f,signal);
  const quote=await this.request('GET','/iserver/marketdata/snapshot',{query:{conids:f.conid,fields:'31,84,86,6509'},signal});
  requireThat(Array.isArray(quote),'IBKR_SCHEMA','行情快照格式不符。',502);
  const whatIf=assertObject(await this.request('POST',`/iserver/account/${f.accountId}/orders/whatif`,{body:{orders:[this.payload(f,clientOrderId)]},signal}));
  requireThat(!whatIf.error&&object(whatIf.amount),'IBKR_PREVIEW_REJECTED','IBKR未返回可用订单预览，请核对账户、权限及订单。',409);
  return{session,instrument,position,quote:quote.map(x=>({conid:x.conid,last:x['31'],bid:x['84'],ask:x['86'],marketDataAvailability:x['6509'],updated:x._updated})),whatIf:{amount:whatIf.amount,initial:whatIf.initial,maintenance:whatIf.maintenance,equity:whatIf.equity,position:whatIf.position,warn:text(whatIf.warn)},receivedAt:new Date(this.now()).toISOString()};
 }
 submit(f,id,signal){return this.request('POST',`/iserver/account/${f.accountId}/orders`,{body:{orders:[this.payload(f,id)]},signal});}
 reply(id,confirmed,signal){requireThat(/^[A-Za-z0-9-]{1,100}$/.test(id),'IBKR_SCHEMA','券商警告编号无效。');return this.request('POST',`/iserver/reply/${id}`,{body:{confirmed},signal});}
 cancel(accountId,id,signal){requireThat(/^\d{1,30}$/.test(String(id)),'IBKR_SCHEMA','券商订单编号无效。');return this.request('DELETE',`/iserver/account/${accountId}/order/${id}`,{signal});}
 async find(f,clientOrderId,brokerOrderId,signal){
  await this.session(f.accountId,signal);
  const x=assertObject(await this.request('GET','/iserver/account/orders',{query:{accountId:f.accountId,force:true},signal}));
  requireThat(Array.isArray(x.orders),'IBKR_SCHEMA','券商订单簿响应无效。',502);
  const rows=x.orders.filter(o=>(o.account??o.acct)===f.accountId&&(brokerOrderId?String(o.orderId)===String(brokerOrderId):o.order_ref===clientOrderId));
  requireThat(rows.length<=1,'IBKR_RECONCILIATION','发现多个相同订单标识，需人工核对。',409);
  if(!rows.length)return null;const o=rows[0];
  requireThat(Number(o.conid)===f.conid&&o.side===f.side&&Number(o.totalSize)===f.quantity,'IBKR_RECONCILIATION','券商订单与保存需求不匹配。',409);
  return{orderId:String(o.orderId),status:o.status,filledQuantity:o.filledQuantity,remainingQuantity:o.remainingQuantity,avgPrice:o.avgPrice,snapshot:x.snapshot===true,observedAt:new Date(this.now()).toISOString()};
 }
}
