import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradingService} from '../service.js';
import {Ledger} from '../../ledger/ledger.js';
import {resolveConfig} from '../config.js';

function fixture(t,overrides={}) {
  const dir=mkdtempSync(join(tmpdir(),'trading-reconcile-test-'));
  const ledger=new Ledger(join(dir,'ledger.sqlite'));
  ledger.change({action:'savePosition',revision:0,requestId:'synthetic-position',data:{symbol:'AAPL',shares:'100.000001',nominalCost:'10000',openingNetPremium:'0',asOf:'2026-11-25',note:'Synthetic test data'}});
  let time=Date.parse('2026-11-25T02:00:00Z'),calls=0;
  const state={receipt:{orderId:'101',status:'Submitted',filledQuantity:0,remainingQuantity:2,snapshot:true,avgPrice:null,observedAt:new Date(time).toISOString()}};
  const gateway={find:async()=>{calls++;return state.receipt;},submit:()=>assert.fail('monitor must never submit'),cancel:()=>assert.fail('monitor must never cancel')};
  const config={execution:{mode:'IBKR_PAPER',ibkr:{baseUrl:'http://127.0.0.1:59999/v1/api',allowInsecureLocal:true,environment:'PAPER',accountIds:['DU1']}},...overrides};
  const service=new TradingService({path:join(dir,'state.sqlite'),ledger,config,gateway,now:()=>time});
  const order=service.store.put('tradeIntent','intent',{status:'ACKNOWLEDGED',fields:{accountId:'DU1',symbol:'AAPL',conid:265598,assetClass:'STOCK',currency:'USD',side:'BUY',quantity:2},clientOrderId:'synthetic-ref',brokerOrderId:'101',receipt:state.receipt,approval:null},0);
  const execution={executionId:'e1',accountId:'DU1',orderRef:'synthetic-ref',instrumentId:'265598',side:'B',quantity:'1',price:'99.50',commission:'0.10',netAmount:'-99.60',currency:'USD',asOf:new Date(time).toISOString()};
  const snapshot=patch=>service.store.put('snapshot',crypto.randomUUID(),{immutable:true,accountId:'DU1',mode:'synthetic',inputAuthority:'SYNTHETIC_FIXTURE',source:'explicit-test-fixture',receivedAt:new Date(time).toISOString(),asOf:null,missing:[],data:{accountId:'DU1',positions:[{instrumentId:'265598',symbol:'AAPL',assetClass:'STK',currency:'USD',quantity:'100.000002'}],executions:[execution],coverage:{positionsComplete:true,executionsComplete:false},...patch}},0);
  const run=(name,args={},context)=>service.execute(name,args,context);
  const report=(patch,args={})=>run('reconcile.create',{snapshotId:snapshot(patch).id,ledgerRevision:ledger.read().revision,accountScopeConfirmed:true,bindings:[{symbol:'AAPL',instrumentId:'265598',currency:'USD'}],...args});
  const watch=()=>run('trade.watch',{id:order.id,revision:0,enabled:true});
  t.after(()=>{service.close();ledger.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,service,ledger,state,gateway,config,order,execution,run,report,snapshot,watch,calls:()=>calls,advance:ms=>{time+=ms;}};
}

test('saved reconciliation uses exact decimal quantity and never changes ledger or order authorization',async t=>{
  const f=fixture(t),before=f.ledger.read(),order=f.service.store.require('tradeIntent','intent');
  const report=await f.report();assert.equal(report.positions[0].difference,'0.000001');assert.equal(report.positions[0].status,'DIFFERENCE');
  assert.equal(report.executions[0].status,'LINKED');assert.equal(report.orderFills[0].visibleQuantity,'1');assert.equal(report.orderFills[0].knownCommission,'0.1');
  assert.equal(report.status,'REVIEW_REQUIRED');assert.equal(report.ledgerUpdated,false);assert.equal(report.orderSubmissionEnabled,false);
  assert.deepEqual(f.ledger.read(),before);assert.deepEqual(f.service.store.require('tradeIntent','intent'),order);
  assert(report.limitations.includes('SYNTHETIC_INPUT_NOT_ACCOUNT_EVIDENCE'));assert(report.limitations.includes('NO_ATOMIC_AS_OF_TIME'));assert.equal(f.calls(),0);
});
test('mapping requires explicit account confirmation and current ledger revision; no symbol fallback',async t=>{
  const f=fixture(t);await assert.rejects(f.report({}, {accountScopeConfirmed:false}),{code:'ACCOUNT_SCOPE_REQUIRED'});
  await assert.rejects(f.report({}, {ledgerRevision:0}),{code:'VERSION_CONFLICT'});
  await assert.rejects(f.report({}, {bindings:[{symbol:'AAPL',instrumentId:'265598',currency:'EUR'}]}),{code:'INVALID_BINDINGS'});
  const report=await f.report({}, {bindings:[]});assert.equal(report.positions.length,2);assert(report.positions.every(row=>row.status.startsWith('UNMAPPED')));
});
test('missing positions count as zero only when the position list is complete',async t=>{
  const f=fixture(t);const complete=await f.report({positions:[]});assert.equal(complete.positions[0].brokerQuantity,'0');
  const incomplete=await f.report({positions:[],coverage:{positionsComplete:false}});assert.equal(incomplete.positions[0].brokerQuantity,null);assert.equal(incomplete.positions[0].status,'UNRESOLVED');
});
test('currency, asset type and duplicate contract ambiguity remain unresolved',async t=>{
  const f=fixture(t),base={instrumentId:'265598',symbol:'AAPL',assetClass:'STK',currency:'USD',quantity:'100.000001'};
  for(const positions of [[{...base,currency:'EUR'}],[{...base,assetClass:'OPT'}],[base,base]]) assert.equal((await f.report({positions})).positions[0].status,'UNRESOLVED');
});
test('identical executions are counted once; conflicting execution IDs are not aggregated',async t=>{
  const f=fixture(t),row=f.execution;
  const duplicate=await f.report({executions:[row,{...row}]});assert.equal(duplicate.executions[0].occurrences,2);assert.equal(duplicate.orderFills[0].visibleQuantity,'1');
  const conflict=await f.report({executions:[row,{...row,quantity:'2'}]});assert.equal(conflict.executions[0].status,'CONFLICTING_DUPLICATES');assert.equal(conflict.orderFills[0].visibleQuantity,'0');
});
test('executions require exact account, order reference, contract, currency and side',async t=>{
  const f=fixture(t);
  for(const [patch,status] of [[{accountId:'DU2'},'ACCOUNT_MISMATCH'],[{orderRef:null},'UNLINKED_ORDER_REF'],[{instrumentId:'999'},'IDENTITY_MISMATCH'],[{side:'S'},'IDENTITY_MISMATCH'],[{currency:'EUR'},'IDENTITY_MISMATCH'],[{quantity:'-1'},'INVALID_EXECUTION_AMOUNT']]) {
    const report=await f.report({executions:[{...f.execution,...patch}]});assert.equal(report.executions[0].status,status);assert.equal(report.orderFills[0].executionCount,0);
  }
});
test('partial execution window and unknown fees are retained instead of inventing complete cash flow',async t=>{
  const f=fixture(t),row=f.service.store.require('tradeIntent','intent');f.service.store.put('tradeIntent',row.id,{...row,receipt:{...row.receipt,filledQuantity:2}},row.revision);
  const report=await f.report({executions:[{...f.execution,commission:null}]});assert.equal(report.orderFills[0].status,'VISIBLE_WINDOW_GAP');assert.equal(report.orderFills[0].commissionComplete,false);
  const missing=await f.report({executions:null});assert(missing.limitations.includes('EXECUTIONS_UNAVAILABLE'));assert.equal(missing.orderFills[0].visibleQuantity,'0');
});
test('review records human notes and becomes stale after a ledger or relevant order change',async t=>{
  const f=fixture(t),report=await f.report();
  const reviewed=await f.run('reconcile.review',{id:report.id,revision:report.revision,note:'Synthetic review, difference still requires investigation.'});assert.equal(reviewed.status,'REVIEWED');assert.equal(f.ledger.read().revision,1);
  await assert.rejects(f.run('reconcile.review',{id:reviewed.id,revision:reviewed.revision,note:'again'}),{code:'ALREADY_REVIEWED'});
  const next=await f.report(),order=f.service.store.require('tradeIntent','intent');f.service.store.put('tradeIntent',order.id,{...order,receipt:{...order.receipt,filledQuantity:1}},order.revision);
  assert.equal((await f.run('reconcile.get',{id:next.id})).stale,true);await assert.rejects(f.run('reconcile.review',{id:next.id,revision:next.revision,note:'stale'}),{code:'REPORT_STALE'});
});
test('reconciliation model reads require broker, ledger and trade grants together; mutations remain human',async t=>{
  const f=fixture(t),report=await f.report(),all={actor:'model',allowedScopes:['broker','ledger','trade']};
  for(const allowedScopes of [['broker'],['broker','ledger'],['broker','trade']]) {
    await assert.rejects(f.run('reconcile.get',{id:report.id},{actor:'model',allowedScopes}),{code:'SCOPE_DENIED'});
    assert.equal(f.service.modelTools(allowedScopes).some(tool=>tool.name==='reconcile_get'),false);
  }
  assert.equal((await f.run('reconcile.get',{id:report.id},all)).id,report.id);
  await assert.rejects(f.run('reconcile.review',{id:report.id,revision:report.revision,note:'model'},all),{code:'HUMAN_REQUIRED'});
});
test('orders beyond the UI list limit are included in reconciliation and stale detection',async t=>{
  const f=fixture(t);
  for(let i=0;i<205;i++)f.service.store.put('tradeIntent',`extra-${i}`,{...f.order,clientOrderId:`ref-${i}`},0);
  const report=await f.report();assert.equal(report.orderFills.length,206);
  f.service.store.put('tradeIntent','last-added',{...f.order,clientOrderId:'new'},0);assert.equal(f.service.reconciliation.get(report.id).stale,true);
});
test('monitoring is per-order opt-in, human-only and independent of the disabled alert scheduler',async t=>{
  const f=fixture(t);assert.equal(f.service.config.scheduler.enabled,false);await f.service.backgroundTick();assert.equal(f.calls(),0);
  await assert.rejects(f.run('trade.watch',{id:'intent',revision:0,enabled:true},{actor:'model',allowedScopes:['trade']}),{code:'HUMAN_REQUIRED'});
  await f.watch();await f.service.backgroundTick();assert.equal(f.calls(),1);assert.equal(f.service.orderMonitor.status({id:'intent'}).failures,0);
  await f.service.backgroundTick();assert.equal(f.calls(),1);
});
test('unchanged polls preserve order revision and a pending human cancellation confirmation',async t=>{
  const f=fixture(t);await f.watch();const reviewed=f.service.trades.review({id:'intent',revision:1,action:'CANCEL'});
  f.state.receipt={...f.state.receipt,observedAt:'2030-01-01T00:00:00Z'};await f.service.backgroundTick();
  const row=f.service.store.require('tradeIntent','intent');assert.equal(row.revision,reviewed.revision);assert(row.approval);assert.equal(f.service.store.list('notification').length,0);
});
test('partial fills notify once, invalidate old confirmation and terminal fills stop the watch',async t=>{
  const f=fixture(t);await f.watch();f.service.trades.review({id:'intent',revision:1,action:'CANCEL'});
  f.state.receipt={...f.state.receipt,filledQuantity:1,remainingQuantity:1};await f.service.backgroundTick();
  assert.equal(f.service.store.require('tradeIntent','intent').approval,null);assert.equal(f.service.store.list('notification').length,1);
  f.advance(30000);await f.service.backgroundTick();assert.equal(f.service.store.list('notification').length,1);
  f.advance(30000);f.state.receipt={...f.state.receipt,status:'Filled',filledQuantity:2,remainingQuantity:0};await f.service.backgroundTick();
  assert.equal(f.service.orderMonitor.status({id:'intent'}).enabled,false);assert.equal(f.service.orderMonitor.status({id:'intent'}).stoppedReason,'BROKER_TERMINAL');assert.equal(f.service.trades.get('intent').executionResultIsFill,true);
});
test('not-found orders back off and pause without submitting or treating absence as failure',async t=>{
  const f=fixture(t,{orderMonitoring:{maxFailures:2}});await f.watch();f.state.receipt=null;
  await f.service.backgroundTick();let watch=f.service.orderMonitor.status({id:'intent'});assert.equal(watch.lastError.code,'ORDER_NOT_VISIBLE');assert.equal(watch.enabled,true);
  f.advance(30000);await f.service.backgroundTick();assert.equal(f.calls(),1);f.advance(30000);await f.service.backgroundTick();
  watch=f.service.orderMonitor.status({id:'intent'});assert.equal(watch.enabled,false);assert.equal(watch.stoppedReason,'FAILURE_LIMIT');assert.equal(f.service.trades.get('intent').status,'ACKNOWLEDGED');assert.equal(f.calls(),2);
});
test('pausing a watch invalidates delayed responses before any intent or notification write',async t=>{
  const f=fixture(t);await f.watch();let resolve;f.gateway.find=()=>new Promise(r=>{resolve=r;});const poll=f.service.backgroundTick();
  const watch=f.service.orderMonitor.status({id:'intent'});await f.run('trade.watch',{id:'intent',revision:watch.revision,enabled:false});
  resolve({...f.state.receipt,status:'Filled',filledQuantity:2,remainingQuantity:0});await poll;
  assert.equal(f.service.trades.get('intent').receipt.status,'Submitted');assert.equal(f.service.store.list('notification').length,0);assert.equal(f.service.orderMonitor.status({id:'intent'}).enabled,false);
});
test('persisted leases exclude concurrent workers and allow recovery after expiry',async t=>{
  const f=fixture(t);await f.watch();const claimed=f.service.orderMonitor.claim('intent');assert(claimed);assert.equal(f.service.orderMonitor.claim('intent'),null);
  const other=new TradingService({path:join(f.dir,'state.sqlite'),config:f.config,gateway:f.gateway,now:()=>Date.parse('2026-11-25T02:00:00Z')});
  await other.backgroundTick();assert.equal(f.calls(),0);other.close();
  f.advance(120001);await f.service.backgroundTick();assert.equal(f.calls(),1);assert.equal(f.service.orderMonitor.status({id:'intent'}).failures,0);
});
test('trade notifications do not leak through portfolio-only model tools',async t=>{
  const f=fixture(t);await f.watch();f.state.receipt=null;await f.service.backgroundTick();
  assert.equal((await f.run('notifications.list',{}, {actor:'model',allowedScopes:['portfolio']})).length,0);
  assert.equal((await f.run('notifications.list',{}, {actor:'model',allowedScopes:['portfolio','trade']})).length,1);
});
test('readonly and deployment-disabled monitors cannot be enabled; invalid timing is rejected',async t=>{
  const f=fixture(t,{execution:{mode:'READ_ONLY'}});await assert.rejects(f.watch(),{code:'EXECUTION_DISABLED'});
  const disabled=fixture(t,{orderMonitoring:{enabled:false}});await assert.rejects(disabled.watch(),{code:'MONITOR_DISABLED'});
  assert.throws(()=>resolveConfig({orderMonitoring:{intervalMs:1000}}),{code:'INVALID_CONFIG'});
});
test('cancellation remains pending until a terminal broker observation; non-snapshot fills are not verified',async t=>{
  const f=fixture(t),row=f.service.store.require('tradeIntent','intent');f.service.store.put('tradeIntent',row.id,{...row,status:'CANCEL_PENDING'},row.revision);
  await f.watch();await f.service.backgroundTick();assert.equal(f.service.trades.get('intent').status,'CANCEL_PENDING');
  f.advance(30000);f.state.receipt={...f.state.receipt,status:'Filled',filledQuantity:2,remainingQuantity:0,snapshot:false};await f.service.backgroundTick();
  assert.equal(f.service.orderMonitor.status({id:'intent'}).enabled,true);assert.equal(f.service.trades.get('intent').executionResultIsFill,false);
  f.advance(30000);f.state.receipt={...f.state.receipt,status:'Cancelled',snapshot:true};await f.service.backgroundTick();assert.equal(f.service.orderMonitor.status({id:'intent'}).enabled,false);
});
