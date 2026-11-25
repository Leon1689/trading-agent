/** Persisted, leased research jobs. They never submit or accept orders. */
import {randomUUID} from 'node:crypto';
import {requireThat} from './errors.js';
const safe=({runId,leaseUntil,...row})=>row;
export class AssistantJobs {
  constructor(service){this.service=service;this.store=service.store;this.now=service.now;}
  configure(args){
    const prior=args.id?this.store.require('assistantJob',args.id):null;
    if(prior)requireThat(prior.revision===args.revision,'VERSION_CONFLICT','任务版本已变化。',409);
    if(prior)requireThat(args.kind===prior.kind&&(args.accountId===undefined||args.accountId===prior.accountId)&&(args.conditionId===undefined||args.conditionId===prior.conditionId),'INVALID_JOB','现有任务不能换绑账户或规则；请创建新任务。');
    const kind=prior?.kind??args.kind;
    requireThat(['HOLDINGS_BRIEF','CONDITION'].includes(kind),'INVALID_JOB','任务类型无效。');
    const intervalMs=args.intervalMs??prior?.intervalMs;
    requireThat(Number.isSafeInteger(intervalMs)&&intervalMs>=this.service.config.scheduler.minIntervalMs&&intervalMs<=30*86400000,'INVALID_INTERVAL','任务周期必须符合调度器的最小间隔，最长30天。');
    let accountId=prior?.accountId??args.accountId??null,conditionId=prior?.conditionId??args.conditionId??null;
    if(kind==='HOLDINGS_BRIEF')requireThat(typeof accountId==='string'&&/^[A-Za-z0-9-]{1,40}$/.test(accountId)&&this.service.config.providers.ibkr?.accountIds.includes(accountId),'ACCOUNT_SCOPE','请选择已配置的券商只读账户。',403);
    else {const rule=this.service.conditions.get(conditionId);if(args.enabled)requireThat(rule.status==='ARMED','CONDITION_STATE','条件规则不再等待触发。',409);accountId=null;}
    requireThat(typeof args.enabled==='boolean','INVALID_JOB','须明确启停状态。');
    return safe(this.store.put('assistantJob',prior?.id??randomUUID(),{...prior,kind,accountId,conditionId,intervalMs,enabled:args.enabled,nextRunAt:this.now(),runId:null,leaseUntil:0,failures:0,lastError:null,requiredScopes:kind==='HOLDINGS_BRIEF'?['broker','portfolio','market']:['portfolio','market'],orderSubmitted:false},prior?.revision??0));
  }
  current(claim){const row=this.store.require('assistantJob',claim.id);requireThat(row.enabled&&row.runId===claim.runId&&row.revision===claim.revision&&row.leaseUntil>this.now(),'JOB_SUPERSEDED','任务已暂停或本次结果已过期。',409);return row;}
  claim(id,manual=false){return this.store.transaction(()=>{
    const row=this.store.require('assistantJob',id);if(!row.enabled||row.leaseUntil>this.now()||!manual&&row.nextRunAt>this.now())return null;
    return this.store.put('assistantJob',id,{...row,runId:randomUUID(),leaseUntil:this.now()+180000},row.revision);
  });}
  async quote(rule,signal){
    const order=rule.legs[0].order,option=order.assetClass==='OPTION';
    const data=await this.service.providers.request(option?'market.options':'market.quote',option?{symbol:order.contract.underlying,from:order.contract.expiration,to:order.contract.expiration,right:order.contract.right,limit:100}:{symbol:order.symbol},{signal});
    requireThat(Array.isArray(data.data),'QUOTE_UNAVAILABLE','未取得有效报价。');
    let matches;
    if(option)matches=data.data.filter(q=>q.contract===order.symbol&&q.underlying===order.contract.underlying&&q.expiration===order.contract.expiration&&q.right===order.contract.right&&Number(q.strike)===Number(order.contract.strike));
    else matches=data.data.filter(q=>q.symbol===order.symbol&&q.currency==='USD');
    requireThat(matches.length===1,'QUOTE_IDENTITY','行情标的或币种不能唯一核对。');
    const q=matches[0],rawPrice=option?(order.side==='SELL'?q.bid:q.ask):q.price;
    requireThat((typeof rawPrice==='string'||typeof rawPrice==='number')&&Number.isFinite(Number(rawPrice))&&Number(rawPrice)>0&&Number(rawPrice)<=1e9,'QUOTE_UNAVAILABLE','报价缺失。');
    const cents=Number(rawPrice)*100;requireThat(Math.abs(cents-Math.round(cents))<1e-6,'QUOTE_PRECISION','本地条件仅支持美分精度，不能静默舍入行情。');
    return {symbol:order.symbol,assetClass:order.assetClass,currency:'USD',priceUnit:option?'USD_PER_UNDERLYING_UNIT':'USD_PER_SHARE',...(option?{contract:order.contract}:{}),price:Number(rawPrice).toFixed(2),asOf:q.asOf,source:data.source,synthetic:data.mode==='synthetic'};
  }
  async run(id,signal,manual=false){
    const claim=this.claim(id,manual);if(!claim)return {id,skipped:true};
    const timeout=AbortSignal.timeout(90000),combined=signal?AbortSignal.any([timeout,signal]):timeout;
    try{
      let snapshot,report,quote,rule;
      if(claim.kind==='HOLDINGS_BRIEF'){
        const data=await this.service.providers.request('broker.snapshot',{accountId:claim.accountId},{signal:combined});this.current(claim);
        requireThat(data.data?.accountId===claim.accountId,'ACCOUNT_SCOPE','快照账户不匹配。');
        snapshot={...data,id:randomUUID(),immutable:true,accountId:claim.accountId,inputAuthority:data.mode==='synthetic'?'SYNTHETIC_FIXTURE':'BROKER_REPORTED',strategyLedgerUpdated:false};
        report=await this.service.assistant.researchHoldings(this.service.assistant.analyzeSnapshot(snapshot),{actor:'human',signal:combined});
      }else{
        rule=this.service.conditions.get(claim.conditionId);
        requireThat(rule.status==='ARMED','CONDITION_STATE','规则已触发或取消。',409);
        if(Date.parse(rule.expiresAt)>this.now())quote=await this.quote(rule,combined);
      }
      combined.throwIfAborted();this.current(claim);
      // ConditionalPaper owns its transaction; no await occurs between the lease check and evaluation.
      let result;
      if(claim.kind==='CONDITION'){
        if(!quote){const current=this.service.conditions.get(rule.id);requireThat(current.revision===rule.revision,'CONDITION_STATE','规则已更新。',409);this.store.put('conditionOrder',rule.id,{...current,status:'EXPIRED',legs:current.legs.map(l=>({...l,status:'EXPIRED'}))},current.revision);result={matched:false,expired:true};}
        else {result=this.service.conditions.evaluate({id:rule.id,revision:rule.revision,eventId:claim.runId,quote});if(result.draft){const {confirmationToken,...draft}=result.draft;result={...result,draft};}}
      }
      return this.store.transaction(()=>{
        const current=this.current(claim),finished=result?.matched||result?.expired;
        let reportId=null;
        if(snapshot){this.store.put('snapshot',snapshot.id,snapshot,0);const saved=this.store.put('holdingsReport',randomUUID(),{...report,requiredScopes:['broker','portfolio','market'],immutable:true},0);reportId=saved.id;}
        const next=this.store.put('assistantJob',id,{...current,enabled:!finished,runId:null,leaseUntil:0,failures:0,lastError:null,lastRunAt:new Date(this.now()).toISOString(),nextRunAt:this.now()+current.intervalMs,reportId:reportId??current.reportId??null,lastResult:result??null},current.revision);
        if(reportId||finished)this.store.put('notification',randomUUID(),{kind:claim.kind,jobId:id,reportId,conditionId:claim.conditionId,requiredScopes:claim.requiredScopes,read:false,createdAt:new Date(this.now()).toISOString(),message:reportId?'持仓研究简报已生成。':result.matched?'条件已触发，生成本地待确认草稿。':'条件规则已过期。'},0);
        this.store.append({operation:'assistant.job',actor:'scheduler',status:'OK',jobId:id,orderSubmitted:false});return safe(next);
      });
    }catch(error){
      try{this.current(claim);}catch{return {id,discarded:true};}
      const current=this.current(claim),failures=current.failures+1,code=timeout.aborted?'JOB_TIMEOUT':signal?.aborted?'JOB_ABORTED':error.code??'JOB_UNAVAILABLE';
      const next=this.store.put('assistantJob',id,{...current,enabled:failures<5,runId:null,leaseUntil:0,failures,lastError:{code,message:'本次任务未完成，未自动提交订单。'},nextRunAt:this.now()+Math.min(86400000,current.intervalMs*2**Math.min(failures,10))},current.revision);
      if(failures===1||failures===5)this.store.put('notification',randomUUID(),{kind:'ASSISTANT_JOB_ERROR',jobId:id,requiredScopes:claim.requiredScopes,read:false,createdAt:new Date(this.now()).toISOString(),code,paused:failures===5},0);
      return safe(next);
    }
  }
  async tick(signal){const results=[];for(const row of this.store.dueRecords('assistantJob',this.now(),this.service.config.limits.listLimit)){signal?.throwIfAborted();results.push(await this.run(row.id,signal));}return results;}
  list(){return {backgroundEnabled:this.service.config.scheduler.enabled,requiresRunningServer:true,items:this.store.list('assistantJob').map(safe)};}
}
