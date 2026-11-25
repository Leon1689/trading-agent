import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TradingService} from '../service.js';
import {IbkrPaperGateway} from '../ibkr-execution.js';
import {resolveConfig} from '../config.js';
const config={execution:{mode:'IBKR_PAPER',ibkr:{baseUrl:'http://127.0.0.1:59999/v1/api',environment:'PAPER',accountIds:['DU1']}}};
export const stock={accountId:'DU1',symbol:'AAPL',assetClass:'STOCK',side:'BUY',positionEffect:'OPEN',quantity:2,type:'LIMIT',limitPrice:'100.00',currency:'USD',timeInForce:'DAY',session:'REGULAR',conid:265598};
function fixture(t){
 const dir=mkdtempSync(join(tmpdir(),'pi-trade-flow-'));let time=Date.parse('2026-11-23T00:00:00Z');const state={isPaper:true,selectedAccount:'DU1',posts:[],reply:[],orders:[],positions:[],throwSubmit:false,next:[{order_id:'101',order_status:'Submitted'}],contract:{con_id:265598,symbol:'AAPL',currency:'USD',instrument_type:'STK',local_symbol:'AAPL'}};
 const gateway=new IbkrPaperGateway(config.execution.ibkr,{pacing:false,now:()=>time,fetchImpl:async(url,init)=>{
  const path=url.pathname.replace('/v1/api','');let data;
  if(path==='/portfolio/accounts')data=[{accountId:'DU1'}];
  else if(path.includes('/positions/'))data=state.positions;
  else if(path==='/iserver/accounts')data={accounts:['DU1'],selectedAccount:state.selectedAccount,isPaper:state.isPaper};
  else if(path.includes('/info-and-rules'))data=state.contract;
  else if(path==='/iserver/marketdata/snapshot')data=[{conid:265598,'31':'100','84':'99','86':'101'}];
  else if(path.endsWith('/whatif'))data={amount:{amount:'200 USD',commission:'1 USD'},warn:'Fixture preview; no real broker contacted'};
  else if(path==='/iserver/account/DU1/orders'){state.posts.push(JSON.parse(init.body));if(state.throwSubmit)throw Error('unknown');data=state.next;}
  else if(path.startsWith('/iserver/reply/')){state.reply.push(JSON.parse(init.body));data=state.next;}
  else if(path==='/iserver/account/orders')data={orders:state.orders,snapshot:true};
  else if(init.method==='DELETE')data={msg:'Request was submitted'};
  else if(path==='/iserver/secdef/search')data=[{conid:265598,symbol:'AAPL',sections:[{secType:'OPT',months:'DEC26'}]}];
  else throw Error('unexpected '+path);
  return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
 }});
 const service=new TradingService({path:join(dir,'s.sqlite'),config,gateway,now:()=>time});
 t.after(()=>{service.close();rmSync(dir,{recursive:true,force:true});});
 const run=(name,args={},ctx)=>service.execute(name,args,ctx);
 const model={actor:'model',allowedScopes:['trade']};
 const intent=fields=>run('trade.intent',{fields},model);
 const ready=async(fields=stock)=>{const x=await intent(fields);return run('trade.prepare',{id:x.id,revision:x.revision},model);};
 const review=(x,action='SUBMIT',more={})=>run('trade.review',{id:x.id,revision:x.revision,action,...more});
 const confirm=x=>run('trade.confirm',{id:x.id,revision:x.revision,confirmationToken:x.confirmationToken});
 return{service,state,run,model,intent,ready,review,confirm,advance:ms=>{time+=ms;},gateway};
}
test('conversation intent collects partial fields, asks deterministic questions and preserves amendments',async t=>{
 const f=fixture(t);const x=await f.intent({symbol:'AAPL',side:'BUY'});assert.equal(x.status,'NEEDS_INPUT');assert.ok(x.missing.some(v=>v.field==='quantity'));assert.equal(f.state.posts.length,0);
 const y=await f.run('trade.intent',{id:x.id,revision:x.revision,fields:stock},f.model);assert.equal(y.status,'READY');
 await assert.rejects(f.run('trade.intent',{id:x.id,revision:x.revision,fields:{quantity:3}},f.model),{code:'INTENT_STATE'});
 const z=await f.run('trade.intent',{id:y.id,revision:y.revision,fields:{symbol:'MSFT'}},f.model);assert.ok(z.missing.some(v=>v.field==='conid'));assert.equal(z.fields.quantity,2);
});
test('model scopes, actor, forged tokens and review calls cannot authorize broker writes',async t=>{
 const f=fixture(t);await assert.rejects(f.run('trade.intent',{fields:stock},{actor:'model',allowedScopes:['broker']}),{code:'SCOPE_DENIED'});
 const x=await f.ready();assert.equal(f.state.posts.length,0);
 await assert.rejects(f.run('trade.review',{id:x.id,revision:x.revision,action:'SUBMIT'},f.model),{code:'HUMAN_REQUIRED'});
 await assert.rejects(f.run('trade.confirm',{id:x.id,revision:x.revision,confirmationToken:'fake'},f.model),{code:'HUMAN_REQUIRED'});
 await assert.rejects(f.run('trade.confirm',{id:x.id,revision:x.revision,confirmationToken:'fake'}),{code:'CONFIRMATION_REQUIRED'});
 const a=await f.review(x);assert.ok(a.confirmationToken);assert.equal(JSON.stringify(await f.run('trade.get',{id:x.id},f.model)).includes(a.confirmationToken),false);
 assert.equal(JSON.stringify(f.service.trades.get(x.id)).includes('tokenHash'),false);assert.equal(f.service.modelTools(['trade']).some(x=>/confirm|review/.test(x.name)),false);
 const out=await f.confirm(a);assert.equal(out.status,'ACKNOWLEDGED');assert.equal(out.executionResultIsFill,false);assert.equal(f.state.posts.length,1);assert.equal(f.state.posts[0].orders[0].acctId,'DU1');
 await assert.rejects(f.confirm(a));assert.equal(f.state.posts.length,1);
});
test('modification, expiry and concurrent clicks invalidate approval and prevent duplicate submission',async t=>{
 const f=fixture(t);let x=await f.ready(),a=await f.review(x);await f.run('trade.intent',{id:a.id,revision:a.revision,fields:{quantity:3}},f.model);await assert.rejects(f.confirm(a));
 x=await f.ready();a=await f.review(x);f.advance(121000);await assert.rejects(f.confirm(a),{code:'CONFIRMATION_REQUIRED'});assert.equal(f.state.posts.length,0);
 x=await f.ready();a=await f.review(x);const results=await Promise.allSettled([f.confirm(a),f.confirm(a)]);assert.equal(results.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.state.posts.length,1);
});
test('live or wrong selected account is rejected at both preview and submission',async t=>{
 const f=fixture(t);f.state.isPaper=false;await assert.rejects(f.ready(),{code:'IBKR_PAPER_SESSION_REQUIRED'});f.state.isPaper=true;let x=await f.ready();const a=await f.review(x);f.state.selectedAccount='DU2';await assert.rejects(f.confirm(a),{code:'IBKR_PAPER_SESSION_REQUIRED'});assert.equal(f.state.posts.length,0);
 assert.throws(()=>resolveConfig({execution:{mode:'IBKR_LIVE'}}));assert.throws(()=>resolveConfig({execution:{...config.execution,ibkr:{...config.execution.ibkr,accountIds:['U1']}}}));
});
test('IBKR warnings require a fresh human confirmation for each reply and block competing orders',async t=>{
 const f=fixture(t);f.state.next=[{id:'warning-1',message:['Verify limit price']}];let x=await f.confirm(await f.review(await f.ready()));assert.equal(x.status,'AWAITING_BROKER_REPLY');assert.equal(f.state.reply.length,0);
 const other=await f.review(await f.ready());await assert.rejects(f.confirm(other),{code:'BROKER_PENDING'});
 f.state.next=[{id:'warning-2',message:['Second warning']}];x=await f.confirm(await f.review(x,'REPLY'));assert.equal(x.status,'AWAITING_BROKER_REPLY');assert.equal(f.state.reply.length,1);
 f.state.next=[{order_id:'101',order_status:'Submitted'}];x=await f.confirm(await f.review(x,'REPLY'));assert.equal(x.status,'ACKNOWLEDGED');assert.deepEqual(f.state.reply,[{confirmed:true},{confirmed:true}]);
});
test('uncertain network result is persisted, never retried, and reconciled by exact account and client ID',async t=>{
 const f=fixture(t);f.state.throwSubmit=true;const x=await f.confirm(await f.review(await f.ready()));assert.equal(x.status,'UNKNOWN');assert.equal(f.state.posts.length,1);
 const absent=await f.run('trade.refresh',{id:x.id},f.model);assert.equal(absent.reconciliation,'NOT_FOUND_NOT_PROOF_OF_FAILURE');assert.equal(absent.status,'UNKNOWN');
 f.state.orders=[{account:'DU2',conid:stock.conid,order_ref:x.clientOrderId,orderId:101,status:'Filled',side:'BUY',totalSize:2}];assert.equal((await f.run('trade.refresh',{id:x.id})).status,'UNKNOWN');
 f.state.orders=[{account:'DU1',conid:stock.conid,order_ref:x.clientOrderId,orderId:101,status:'Filled',side:'BUY',totalSize:2,filledQuantity:2,remainingQuantity:0,avgPrice:'99'}];
 const out=await f.run('trade.refresh',{id:x.id},f.model);assert.equal(out.receipt.status,'Filled');assert.equal(out.executionResultIsFill,true);assert.equal(f.state.posts.length,1);
});
test('accepted is distinct from rejected, cancellation pending and cancellation reported',async t=>{
 const f=fixture(t);f.state.next={error:'Fixture rejected'};let x=await f.confirm(await f.review(await f.ready()));assert.equal(x.status,'REJECTED');
 f.state.next=[{order_id:'101',order_status:'Submitted'}];x=await f.confirm(await f.review(await f.ready()));x=await f.confirm(await f.review(x,'CANCEL'));assert.equal(x.status,'CANCEL_PENDING');assert.equal(x.receipt.status,'Submitted');
 f.state.orders=[{account:'DU1',conid:stock.conid,orderId:101,status:'Cancelled',side:'BUY',totalSize:2,filledQuantity:0,remainingQuantity:2}];x=await f.run('trade.refresh',{id:x.id});assert.equal(x.receipt.status,'Cancelled');await assert.rejects(f.review(x,'CANCEL'));
});
test('short option opening requires human Wheel evidence matching this exact order and strict C rule',async t=>{
 const f=fixture(t);const option={...stock,assetClass:'OPTION',side:'SELL',quantity:1,conid:123,expiration:'2026-12-18',right:'CALL',strike:'110',multiplier:100,limitPrice:'1.00'};
 f.state.contract={con_id:123,symbol:'AAPL',currency:'USD',instrument_type:'OPT',local_symbol:'AAPL  261218C00110000',multiplier:'100'};
 const x=await f.ready(option);await assert.rejects(f.review(x),{code:'WHEEL_EVIDENCE_REQUIRED'});
 const evidence={strategy:'CC',symbol:'AAPL',currency:'USD',position:{shares:'100',nominalCost:'10000',netPremium:'0',confirmed:true},existingObligations:[],stockReservations:[],candidates:[{id:'this',strategy:'CC',symbol:'AAPL',currency:'USD',contracts:1,multiplier:100,strike:'110',standardDeliverableVerified:true}],dataQuality:{fresh:true,reconciled:true,complete:true},riskChecks:{willingToTakeAssignment:true,batchPolicyConfirmed:true,liquidity:'PASS',eventRisk:'PASS',concentration:'PASS'}};
 const a=await f.review(x,'SUBMIT',{wheelEvidence:evidence});assert.ok(a.confirmationToken);
 const current=await f.run('trade.get',{id:x.id});await assert.rejects(f.review(current,'SUBMIT',{wheelEvidence:{...evidence,position:{...evidence.position,nominalCost:'11000'}}}),{code:'WHEEL_BLOCKED'});
 await assert.rejects(f.review(current,'SUBMIT',{wheelEvidence:{...evidence,candidates:[{...evidence.candidates[0],contracts:2}]}}),{code:'WHEEL_ORDER_MISMATCH'});
});
test('mismatched option identity cannot produce executable preview',async t=>{
 const f=fixture(t);f.state.contract={con_id:123,symbol:'AAPL',currency:'USD',instrument_type:'OPT',local_symbol:'AAPL  261218P00110000',multiplier:'100'};
 await assert.rejects(f.ready({...stock,assetClass:'OPTION',conid:123,expiration:'2026-12-18',right:'CALL',strike:'110',multiplier:100}),{code:'CONTRACT_MISMATCH'});
});
test('readonly mode can collect intents but cannot issue broker preview or submission',async t=>{
 const f=fixture(t);f.service.config.execution.mode='READ_ONLY';const x=await f.intent(stock);await assert.rejects(f.run('trade.prepare',{id:x.id,revision:x.revision}),{code:'EXECUTION_DISABLED'});assert.equal(f.state.posts.length,0);
});

test('broker position and pending-order checks enforce explicit opening and closing semantics',async t=>{
 const f=fixture(t);await assert.rejects(f.ready({...stock,side:'SELL',positionEffect:'CLOSE'}),{code:'CLOSE_COVERAGE'});
 f.state.positions=[{acctId:'DU1',conid:265598,position:3}];const x=await f.ready({...stock,side:'SELL',positionEffect:'CLOSE'});const a=await f.review(x);
 f.state.positions=[];await assert.rejects(f.confirm(a),{code:'CLOSE_COVERAGE'});assert.equal(f.state.posts.length,0);
 f.state.orders=[{account:'DU1',conid:265598,status:'Submitted'}];await assert.rejects(f.ready(),{code:'POSITION_ORDER_CONFLICT'});
});

test('pending submission is recoverable after restart without resending and stale previews never authorize',async t=>{
 const f=fixture(t);let x=await f.ready();f.advance(301000);await assert.rejects(f.review(x),{code:'PREVIEW_EXPIRED'});
 x=await f.ready();const row=f.service.store.require('tradeIntent',x.id);f.service.store.put('tradeIntent',x.id,{...row,status:'SUBMITTING',submissionStartedAt:new Date(Date.parse('2026-11-23T00:05:01Z')).toISOString()},row.revision);
 await assert.rejects(f.run('trade.refresh',{id:x.id}),{code:'BROKER_BUSY'});f.advance(31000);
 const absent=await f.run('trade.refresh',{id:x.id});assert.equal(absent.reconciliation,'NOT_FOUND_NOT_PROOF_OF_FAILURE');assert.equal(f.state.posts.length,0);
});
test('transport rejects redirects and oversize responses, uses fixed gateway paths and never disables TLS checks',async()=>{
 assert.throws(()=>new IbkrPaperGateway({...config.execution.ibkr,baseUrl:'https://evil.example/v1/api'}));
 let calls=0;const gateway=new IbkrPaperGateway(config.execution.ibkr,{pacing:false,fetchImpl:async(_url,init)=>{calls++;assert.equal(init.redirect,'error');return new Response('x'.repeat(2*1024*1024+1));}});
 await assert.rejects(gateway.session('DU1'),{code:'IBKR_RESPONSE_LIMIT'});assert.equal(calls,1);
});
