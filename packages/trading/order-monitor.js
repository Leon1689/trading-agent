/** Per-order opt-in monitoring. This worker only calls TradeFlow.refresh (broker GETs). */
import {randomUUID,createHash} from 'node:crypto';
import {requireThat} from './errors.js';

export const receiptFingerprint = receipt => createHash('sha256').update(JSON.stringify(
  ['orderId','status','filledQuantity','remainingQuantity','avgPrice','snapshot'].map(key=>receipt?.[key]??null)
)).digest('hex');
export function terminalReceipt(receipt,quantity) {
  if(receipt?.snapshot!==true) return false;
  if(['Cancelled','Canceled'].includes(receipt.status))return true;
  return receipt.status==='Filled' && Number(receipt.filledQuantity)===quantity && Number(receipt.remainingQuantity)===0;
}
const eligible = ['ACKNOWLEDGED','CANCEL_PENDING','UNKNOWN','SUBMITTING'];
const safe = ({runId,leaseUntil,...row}) => row;

export class OrderMonitor {
  constructor(service) { this.service=service;this.store=service.store;this.now=service.now;this.config=service.config.orderMonitoring; }
  status({id}={}) {
    if(id) {this.store.require('tradeIntent',id);return safe(this.store.get('tradeWatch',id)??{id,revision:0,enabled:false,lastCheckedAt:null});}
    return this.store.list('tradeWatch',{limit:this.service.config.limits.listLimit}).map(safe);
  }
  watch({id,revision,enabled,intervalMs}) {
    const order=this.store.require('tradeIntent',id), previous=this.store.get('tradeWatch',id);
    if(enabled) {
      this.service.trades.enabled();
      requireThat(this.config.enabled,'MONITOR_DISABLED','部署配置尚未启用后台订单跟踪。',403);
      requireThat(eligible.includes(order.status)&&!terminalReceipt(order.receipt,order.fields.quantity),'INTENT_STATE','只能跟踪已提交且未终结的订单。',409);
    }
    const interval=intervalMs??previous?.intervalMs??this.config.intervalMs;
    requireThat(Number.isSafeInteger(interval)&&interval>=15000&&interval<=3600000,'INVALID_INTERVAL','跟踪间隔为15000至3600000毫秒。');
    return safe(this.store.put('tradeWatch',id,{
      ...previous,enabled,intervalMs:interval,nextRunAt:this.now(),runId:null,leaseUntil:0,
      failures:0,lastError:null,stoppedReason:enabled?null:'HUMAN_PAUSED',
      fingerprint:previous?.fingerprint??receiptFingerprint(order.receipt),lastCheckedAt:previous?.lastCheckedAt??null,
    },revision));
  }
  notify(id,event,details) {
    this.store.put('notification',randomUUID(),{kind:'ORDER_MONITOR',intentId:id,event,details,requiredScopes:['trade'],read:false,createdAt:new Date(this.now()).toISOString()},0);
  }
  claim(id) {
    return this.store.transaction(()=>{
      const row=this.store.require('tradeWatch',id);
      if(!row.enabled||row.nextRunAt>this.now()||row.leaseUntil>this.now())return null;
      return this.store.put('tradeWatch',id,{...row,runId:randomUUID(),leaseUntil:this.now()+120000},row.revision);
    });
  }
  current(claim) {
    const row=this.store.require('tradeWatch',claim.id);
    requireThat(row.enabled&&row.runId===claim.runId&&row.revision===claim.revision&&row.leaseUntil>this.now(),'MONITOR_SUPERSEDED','跟踪已暂停或本次查询已失效。',409);
    return row;
  }
  async poll(claim,signal) {
    const timeout=AbortSignal.timeout(45000), combined=signal?AbortSignal.any([signal,timeout]):timeout;
    try {
      const order=await this.service.trades.refresh({id:claim.id},combined,()=>this.current(claim));
      combined.throwIfAborted();this.current(claim);
      if(order.reconciliation) { const error=new Error();error.code='ORDER_NOT_VISIBLE';throw error; }
      const fingerprint=receiptFingerprint(order.receipt),terminal=terminalReceipt(order.receipt,order.fields.quantity);
      return this.store.transaction(()=>{
        const row=this.current(claim),changed=fingerprint!==row.fingerprint;
        const next=this.store.put('tradeWatch',claim.id,{...row,enabled:!terminal,nextRunAt:this.now()+row.intervalMs,runId:null,leaseUntil:0,failures:0,lastError:null,lastCheckedAt:new Date(this.now()).toISOString(),fingerprint,stoppedReason:terminal?'BROKER_TERMINAL':null},row.revision);
        if(changed)this.notify(claim.id,'STATUS_CHANGED',{status:order.receipt.status,filledQuantity:order.receipt.filledQuantity??null,remainingQuantity:order.receipt.remainingQuantity??null});
        this.store.append({operation:'trade.monitor',actor:'scheduler',status:'OK',intentId:claim.id,changed,terminal});
        return safe(next);
      });
    } catch(error) {
      if(signal?.aborted)throw error;
      // Pausing or replacing a watch invalidates the in-flight response and every subsequent write.
      try {this.current(claim);} catch {return {id:claim.id,discarded:true};}
      const known=['ORDER_NOT_VISIBLE','IBKR_PAPER_SESSION_REQUIRED','IBKR_RECONCILIATION','IBKR_SCHEMA','VERSION_CONFLICT','EXECUTION_DISABLED','BROKER_BUSY','INTENT_STATE'];
      const code=known.includes(error.code)?error.code:timeout.aborted?'MONITOR_TIMEOUT':'MONITOR_UNAVAILABLE';
      return this.store.transaction(()=>{
        const row=this.current(claim), failures=row.failures+1,paused=failures>=this.config.maxFailures;
        const next=this.store.put('tradeWatch',claim.id,{...row,failures,enabled:!paused,runId:null,leaseUntil:0,lastCheckedAt:new Date(this.now()).toISOString(),lastError:{code,message:'查询未确认最新状态；不会重新提交订单。'},nextRunAt:this.now()+Math.min(3600000,row.intervalMs*2**Math.min(failures,10)),stoppedReason:paused?'FAILURE_LIMIT':null},row.revision);
        if(failures===1||paused)this.notify(claim.id,paused?'MONITOR_PAUSED':'MONITOR_ERROR',{code,failures});
        this.store.append({operation:'trade.monitor',actor:'scheduler',status:'ERROR',intentId:claim.id,code});
        return safe(next);
      });
    }
  }
  async tick(signal) {
    if(!this.config.enabled||this.service.config.execution.mode!=='IBKR_PAPER')return [];
    const rows=this.store.db.prepare("SELECT id FROM records WHERE kind='tradeWatch' AND json_extract(body,'$.enabled')=1 AND json_extract(body,'$.nextRunAt')<=? AND COALESCE(json_extract(body,'$.leaseUntil'),0)<=? ORDER BY json_extract(body,'$.nextRunAt'),id LIMIT 10").all(this.now(),this.now());
    const results=[];
    for(const {id} of rows) {signal?.throwIfAborted();const claim=this.claim(id);if(claim)results.push(await this.poll(claim,signal));}
    return results;
  }
}
