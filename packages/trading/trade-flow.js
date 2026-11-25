/** Persistent conversation -> intent -> immutable preview -> human authorization -> broker receipt. */
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {requireThat} from './errors.js';
import {INTENT_FIELDS} from './trade-catalog.js';
import {analyzeWheel} from './quant.js';
import {IbkrPaperGateway} from './ibkr-execution.js';
const hash=x=>createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x)).digest('hex');
const missingNames={accountId:'模拟账户',symbol:'标的代码',assetClass:'股票或期权',side:'买入或卖出',positionEffect:'开仓或平仓',quantity:'数量',type:'订单类型',limitPrice:'限价',currency:'币种',timeInForce:'有效期',session:'交易时段',conid:'IBKR唯一合约',expiration:'到期日',right:'Call或Put',strike:'行权价',multiplier:'合约乘数'};
const required=['accountId','symbol','assetClass','side','positionEffect','quantity','type','limitPrice','currency','timeInForce','session','conid'];
const mutable=['NEEDS_INPUT','READY','PREVIEWED'];
const publicRow=row=>{const{approval,...safe}=row;return{...safe,requiresHumanConfirmation:true,mode:'IBKR_PAPER',synthetic:false,executionResultIsFill:row.receipt?.status==='Filled'};};
export class TradeFlow{
 constructor(store,config,{gateway,now=()=>Date.now()}={}){this.store=store;this.config=config;this.now=now;this.gateway=gateway??new IbkrPaperGateway(config.execution.ibkr);}
 enabled(){requireThat(this.config.execution.mode==='IBKR_PAPER'&&this.config.execution.ibkr,'EXECUTION_DISABLED','IBKR模拟执行尚未配置启用；需求可先保存，尚未下单。',403);}
 fields(input){
  requireThat(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>Object.hasOwn(INTENT_FIELDS,k)),'INVALID_INTENT','交易需求字段无效。');
  const f={...input};for(const[k,v]of Object.entries(f)){
   const spec=INTENT_FIELDS[k];requireThat(typeof v===spec.type&&(!spec.enum||spec.enum.includes(v)),'INVALID_INTENT',`${missingNames[k]}格式无效。`);
   if(typeof v==='string')requireThat(v.length>0&&v.length<=100,'INVALID_INTENT','需求文本过长或为空。');
  }
  if(f.symbol!==undefined){f.symbol=f.symbol.toUpperCase();requireThat(/^[A-Z][A-Z0-9.\-]{0,23}$/.test(f.symbol),'INVALID_SYMBOL','标的代码无效。');}
  if(f.accountId!==undefined)requireThat(/^DU\d{1,18}$/.test(f.accountId),'PAPER_ONLY','仅接受IBKR的DU模拟账户。');
  for(const k of ['quantity','conid','multiplier'])if(f[k]!==undefined)requireThat(Number.isSafeInteger(f[k])&&f[k]>0&&f[k]<=(k==='conid'?1e12:1000000),'INVALID_INTENT',`${missingNames[k]}必须是有效正整数。`);
  for(const k of ['limitPrice','strike'])if(f[k]!==undefined)requireThat(/^\d{1,8}(\.\d{1,4})?$/.test(f[k])&&Number(f[k])>0,'INVALID_PRICE','价格须为正的十进制字符串，最多4位小数。');
  if(f.expiration!==undefined)requireThat(/^\d{4}-\d{2}-\d{2}$/.test(f.expiration)&&Number.isFinite(Date.parse(f.expiration))&&new Date(f.expiration).toISOString().slice(0,10)===f.expiration,'INVALID_EXPIRATION','到期日无效。');
  if(f.assetClass==='STOCK')for(const k of ['expiration','right','strike','multiplier'])delete f[k];
  return f;
 }
 completeness(f){const keys=[...required,...(f.assetClass==='OPTION'?['expiration','right','strike','multiplier']:[])];return keys.filter(k=>f[k]===undefined).map(field=>({field,question:`请明确${missingNames[field]}。`}));}
 get(id){return publicRow(this.store.require('tradeIntent',id));}
 list({chatId}={}){return this.store.db.prepare("SELECT id FROM records WHERE kind='tradeIntent' AND (? IS NULL OR json_extract(body,'$.chatId')=?) ORDER BY updated_at DESC LIMIT 200").all(chatId??null,chatId??null).map(x=>this.get(x.id));}
 upsert({id,revision,fields,clear=[]},context){
  const row=id?this.store.require('tradeIntent',id):null;
  if(row){requireThat(row.revision===revision&&mutable.includes(row.status),'INTENT_STATE','需求版本已改变或已提交，请刷新；已提交订单不能当草稿改写。',409);if(context.chatId)requireThat(row.chatId===context.chatId,'CHAT_MISMATCH','此交易需求不属于当前会话。',403);}
  requireThat(clear.every(k=>Object.hasOwn(INTENT_FIELDS,k)),'INVALID_INTENT','清空字段无效。');
  const previous={...row?.fields};for(const k of clear)delete previous[k];
  // A different instrument invalidates its broker identity; a new option leg must be resolved again.
  if(row&&['symbol','assetClass','expiration','right','strike'].some(k=>fields[k]!==undefined&&fields[k]!==previous[k])){delete previous.conid;delete previous.multiplier;}
  const f=this.fields({...previous,...fields}),missing=this.completeness(f);
  return publicRow(this.store.put('tradeIntent',id??randomUUID(),{fields:f,missing,status:missing.length?'NEEDS_INPUT':'READY',chatId:row?.chatId??context.chatId??null,sources:[...(row?.sources??[]),{actor:context.actor,message:context.sourceMessage??null,at:new Date(this.now()).toISOString()}].slice(-50),clientOrderId:'pi'+randomBytes(10).toString('hex'),approval:null,preview:null,receipt:null},row?.revision??0));
 }
 async prepare({id,revision},signal){
  this.enabled();const row=this.store.require('tradeIntent',id);requireThat(row.revision===revision&&mutable.includes(row.status),'INTENT_STATE','需求已改变或已提交。',409);
  requireThat(this.completeness(row.fields).length===0,'INTENT_INCOMPLETE','请先在对话中补齐所列参数。');this.activeContract(row.fields);
  const preview=await this.gateway.preview(row.fields,row.clientOrderId,signal);signal?.throwIfAborted();
  return publicRow(this.store.put('tradeIntent',id,{...row,status:'PREVIEWED',preview,previewHash:hash({fields:row.fields,preview}),expiresAt:new Date(this.now()+this.config.limits.orderPreviewTtlMs).toISOString(),approval:null},revision));
 }
 activeContract(f){if(f.assetClass==='OPTION')requireThat(Date.parse(f.expiration)>this.now(),'CONTRACT_EXPIRED','期权已过本系统保守截止时刻（到期日UTC零时），请核对。',409);}
 fresh(row){requireThat(Date.parse(row.expiresAt)>this.now(),'PREVIEW_EXPIRED','预览已过期，请重新预览并核对。',409);this.activeContract(row.fields);}
 wheel(row,input){
  const f=row.fields;if(f.assetClass!=='OPTION'||f.side!=='SELL'||f.positionEffect!=='OPEN')return null;
  requireThat(input,'WHEEL_EVIDENCE_REQUIRED','卖出开仓期权需要你在确认卡填写已核对的Wheel证据，模型不能替你确认。',409);
  requireThat(input.strategy===(f.right==='CALL'?'CC':'CSP')&&input.symbol===f.symbol&&input.currency===f.currency&&input.candidates?.length===1,'WHEEL_ORDER_MISMATCH','Wheel检查必须对应当前这一笔订单。');
  const c=input.candidates[0];requireThat(c.strategy===input.strategy&&c.symbol===f.symbol&&c.currency===f.currency&&c.contracts===f.quantity&&c.multiplier===f.multiplier&&Number(c.strike)===Number(f.strike),'WHEEL_ORDER_MISMATCH','Wheel候选与订单不一致。');
  const result=analyzeWheel(input);requireThat(result.decision==='ALLOW','WHEEL_BLOCKED','Wheel硬约束未全部通过，请处理阻断或未决项。',409);
  return{input,result,authority:'HUMAN_RECONCILED_INPUT',checkedAt:new Date(this.now()).toISOString()};
 }
 review({id,revision,action,wheelEvidence}){
  this.enabled();const row=this.store.require('tradeIntent',id);requireThat(row.revision===revision,'VERSION_CONFLICT','订单已变化，请刷新。',409);
  let wheel=null;
  if(action==='SUBMIT'){requireThat(row.status==='PREVIEWED','INTENT_STATE','请先取得券商预览。',409);this.fresh(row);wheel=this.wheel(row,wheelEvidence);}
  else if(['REPLY','DECLINE'].includes(action)){requireThat(row.status==='AWAITING_BROKER_REPLY','INTENT_STATE','没有待确认的券商警告。',409);if(action==='REPLY')this.fresh(row);}
  else requireThat(action==='CANCEL'&&row.status==='ACKNOWLEDGED'&&row.brokerOrderId&&!['Filled','Cancelled','Canceled','Inactive'].includes(row.receipt?.status),'INTENT_STATE','当前状态不可请求撤单。',409);
  const confirmationToken=randomBytes(32).toString('hex');
  const next=this.store.put('tradeIntent',id,{...row,approval:{tokenHash:hash(confirmationToken),action,expiresAt:this.now()+120000,previewHash:row.previewHash,wheel:wheel??row.wheel??null}},revision);
  return{...publicRow(next),confirmationToken,confirmAction:action,confirmationExpiresAt:new Date(next.approval.expiresAt).toISOString()};
 }
 reserve(id,revision,token){return this.store.transaction(()=>{
  const row=this.store.require('tradeIntent',id),a=row.approval;
  requireThat(row.revision===revision&&a&&a.tokenHash===hash(token)&&a.expiresAt>this.now()&&a.previewHash===row.previewHash,'CONFIRMATION_REQUIRED','确认凭证无效、过期或订单已改变，请重新核对。',409);
  if(['SUBMIT','REPLY'].includes(a.action))this.fresh(row);
  const pending=this.store.db.prepare("SELECT id FROM records WHERE kind='tradeIntent' AND json_extract(body,'$.status') IN ('SUBMITTING','UNKNOWN','AWAITING_BROKER_REPLY') AND id<>?").all(id);
  requireThat(!pending.length,'BROKER_PENDING','前一笔订单尚有警告或结果未知，请先核对，禁止继续提交。',409);
  const permitted=a.action==='SUBMIT'?row.status==='PREVIEWED':['REPLY','DECLINE'].includes(a.action)?row.status==='AWAITING_BROKER_REPLY':row.status==='ACKNOWLEDGED';
  requireThat(permitted,'INTENT_STATE','状态不允许该确认。',409);
  return this.store.put('tradeIntent',id,{...row,status:'SUBMITTING',pendingAction:a.action,approval:null,wheel:a.wheel,submissionStartedAt:new Date(this.now()).toISOString()},revision);
 });}
 async confirm(args,signal){
  this.enabled();let row=this.store.require('tradeIntent',args.id);
  // Validate the browser capability before any network action, then revalidate under the SQLite lock.
  requireThat(row.revision===args.revision&&row.approval?.tokenHash===hash(args.confirmationToken),'CONFIRMATION_REQUIRED','需要当前订单的人工确认凭证。',403);
  await this.gateway.session(row.fields.accountId,signal);
  if(row.approval.action==='SUBMIT')await this.gateway.positionEffect(row.fields,signal);
  signal?.throwIfAborted();
  row=this.reserve(args.id,args.revision,args.confirmationToken);
  try{
   let response;
   if(row.pendingAction==='SUBMIT')response=await this.gateway.submit(row.fields,row.clientOrderId,signal);
   else if(row.pendingAction==='CANCEL')response=await this.gateway.cancel(row.fields.accountId,row.brokerOrderId,signal);
   else response=await this.gateway.reply(row.replyId,row.pendingAction==='REPLY',signal);
   const result=this.classify(response,row);
   row=this.store.put('tradeIntent',row.id,{...row,...result,pendingAction:null},row.revision);
   return publicRow(row);
  }catch{
   return publicRow(this.store.put('tradeIntent',row.id,{...row,status:'UNKNOWN',approval:null,lastError:'请求可能已送达券商；禁止自动重发，请刷新查单或到IBKR核对。'},row.revision));
  }
 }
 classify(response,row){
  if(response?.error||Array.isArray(response)&&response[0]?.error)return{status:'REJECTED',receipt:{error:String(response.error??response[0].error).slice(0,4000)}};
  if(row.pendingAction==='CANCEL'){requireThat(response&&typeof response==='object','IBKR_SCHEMA','撤单响应不明确。');return{status:'CANCEL_PENDING',receipt:{...row.receipt,cancellationRequested:true}};}
  if(row.pendingAction==='DECLINE'){requireThat(response&&typeof response==='object','IBKR_SCHEMA','拒绝警告响应不明确。');return{status:'DECLINED',receipt:{warningDeclined:true}};}
  requireThat(Array.isArray(response)&&response.length===1,'IBKR_SCHEMA','券商返回不明确，需查单。');const x=response[0];
  if(x.id&&Array.isArray(x.message)&&x.message.length&&x.message.every(m=>typeof m==='string'))return{status:'AWAITING_BROKER_REPLY',replyId:String(x.id),warnings:x.message.map(m=>m.slice(0,4000)),receipt:null};
  requireThat(/^\d{1,30}$/.test(String(x.order_id))&&typeof x.order_status==='string','IBKR_SCHEMA','券商未返回可核对的订单编号。');
  return{status:'ACKNOWLEDGED',brokerOrderId:String(x.order_id),replyId:null,warnings:[],receipt:{orderId:String(x.order_id),status:x.order_status}};
 }
 async refresh({id},signal){
  this.enabled();const row=this.store.require('tradeIntent',id);
  requireThat(row.status!=='SUBMITTING'||this.now()-Date.parse(row.submissionStartedAt)>30000,'BROKER_BUSY','提交仍在进行，请稍后查单。',409);
  requireThat(['SUBMITTING','UNKNOWN','ACKNOWLEDGED','CANCEL_PENDING'].includes(row.status),'INTENT_STATE','该状态尚无可查的已提交订单。',409);
  const receipt=await this.gateway.find(row.fields,row.clientOrderId,row.brokerOrderId,signal);signal?.throwIfAborted();
  if(!receipt)return{...publicRow(row),reconciliation:'NOT_FOUND_NOT_PROOF_OF_FAILURE',message:'当前券商会话未找到。不能据此断言下单失败或重新提交；请在IBKR核对。'};
  return publicRow(this.store.put('tradeIntent',id,{...row,status:'ACKNOWLEDGED',brokerOrderId:receipt.orderId,receipt,approval:null,pendingAction:null,lastError:null},row.revision));
 }
 discard({id,revision}){const row=this.store.require('tradeIntent',id);requireThat(row.revision===revision&&mutable.includes(row.status),'INTENT_STATE','仅可放弃未提交需求。',409);return publicRow(this.store.put('tradeIntent',id,{...row,status:'DISCARDED',approval:null},revision));}
}
