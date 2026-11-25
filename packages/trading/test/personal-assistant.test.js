import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradingService} from '../service.js';
import {analyzeOptionStrategy} from '../option-strategy.js';
import {createProviders} from '../providers.js';
import {kalshiDepth,polymarketDepth} from '../prediction-depth.js';
const leg=(side,strike,entryPrice,right='CALL')=>({assetClass:'OPTION',side,quantity:1,strike,entryPrice,right,multiplier:100,expiration:'2027-01-15',standardDeliverableVerified:true,volatility:0.2});
const strategy=legs=>({underlying:'TEST',currency:'USD',legs,totalFees:0});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'personal-assistant-'));let time=Date.parse('2026-11-25T10:00:00Z');const calls=[];
  const state={pause:null,quote:{symbol:'TEST',currency:'USD',price:'90.00',asOf:new Date(time).toISOString()},snapshot:{accountId:'DU1',positions:[{instrumentId:'1',symbol:'TEST',assetClass:'STK',currency:'USD',quantity:'10',marketValue:'900',brokerCostBasis:'100',costBasisUnit:'broker_avgCost_native'}],cash:[{currency:'USD',cash:'1000'}],coverage:{positionsComplete:true}}};
  const providers={capabilities:()=>[],request:async(operation,args)=>{calls.push({operation,args});if(state.pause)await state.pause;return {mode:'synthetic',source:'explicit-fixture',asOf:state.quote.asOf,receivedAt:new Date(time).toISOString(),missing:['synthetic'],data:operation==='broker.snapshot'?state.snapshot:operation==='market.quote'?[state.quote]:operation==='market.news'?[]:[{symbol:'TEST',outcomes:[{price:'0.1'}],volume24h:'12',priceChange24h:null}]};}};
  const service=new TradingService({path:join(dir,'workbench.sqlite'),providers,now:()=>time,config:{providers:{ibkr:{baseUrl:'https://localhost:5000/v1/api',accountIds:['DU1']}},scheduler:{enabled:true,minIntervalMs:60000,pollMs:30000}}});
  t.after(()=>{service.close();rmSync(dir,{recursive:true,force:true});});
  const run=(operation,args={},context)=>service.execute(operation,args,context);
  const snapshot=()=>service.store.put('snapshot',crypto.randomUUID(),{immutable:true,mode:'synthetic',source:'fixture',asOf:null,data:structuredClone(state.snapshot)},0);
  return {service,run,state,calls,snapshot,advance:ms=>{time+=ms;}};
}
test('vertical call spread derives exact global risk, fees and break-even rather than sampled bounds',()=>{
  const result=analyzeOptionStrategy({...strategy([leg('BUY',100,6),leg('SELL',110,2)]),totalFees:2,maxSpot:110});
  assert.equal(result.maxLoss,402);assert.equal(result.maxProfit,598);assert.deepEqual(result.breakEven,[104.02]);assert.equal(result.netEntryCashFlow,-402);assert.equal(result.unboundedLoss,false);
});
test('naked calls, short puts, covered calls and protective puts have correct tail risk',()=>{
  const naked=analyzeOptionStrategy(strategy([leg('SELL',100,5)]));assert.equal(naked.maxLoss,null);assert.equal(naked.unboundedLoss,true);assert.equal(naked.maxProfit,500);
  const put=analyzeOptionStrategy(strategy([leg('SELL',100,5,'PUT')]));assert.equal(put.maxLoss,9500);assert.deepEqual(put.breakEven,[95]);
  const stock={assetClass:'STOCK',side:'BUY',quantity:100,entryPrice:100};
  const cc=analyzeOptionStrategy(strategy([stock,leg('SELL',110,3)]));assert.equal(cc.maxProfit,1300);assert.equal(cc.maxLoss,9700);assert.deepEqual(cc.breakEven,[97]);
  const pp=analyzeOptionStrategy(strategy([stock,leg('BUY',95,2,'PUT')]));assert.equal(pp.maxLoss,700);assert.equal(pp.unboundedProfit,true);assert.deepEqual(pp.breakEven,[102]);
});
test('straddles, condors and zero-payoff intervals are represented without missing roots',()=>{
  const straddle=analyzeOptionStrategy(strategy([leg('BUY',100,5),leg('BUY',100,4,'PUT')]));assert.deepEqual(straddle.breakEven,[91,109]);assert.equal(straddle.maxLoss,900);
  const condor=analyzeOptionStrategy(strategy([leg('BUY',90,1,'PUT'),leg('SELL',95,2,'PUT'),leg('SELL',105,2),leg('BUY',110,1)]));assert.deepEqual(condor.breakEven,[93,107]);assert.equal(condor.maxProfit,200);assert.equal(condor.maxLoss,300);
  const zero=analyzeOptionStrategy(strategy([leg('BUY',100,0)]));assert.deepEqual(zero.zeroProfitIntervals,[{from:0,to:100}]);assert.equal(zero.maxLoss,0);
});
test('aggregate Greeks respect contract quantities, unknown IV and supported expiry/work bounds',()=>{
  const valuation={model:'BLACK_SCHOLES',spot:100,timeYears:0.2,rate:0.04,dividendYield:0};
  const neutral=analyzeOptionStrategy({...strategy([leg('BUY',100,5),leg('SELL',100,5)]),valuation});assert.equal(neutral.greeks.delta,0);assert.equal(neutral.greeks.vegaPerPercentagePoint,0);
  const noIV=leg('BUY',100,5);delete noIV.volatility;assert.equal(analyzeOptionStrategy({...strategy([noIV]),valuation}).greeks,null);
  assert.throws(()=>analyzeOptionStrategy(strategy([leg('BUY',100,5),{...leg('SELL',110,3),expiration:'2027-02-19'}])),{code:'UNSUPPORTED_EXPIRY'});
  assert.throws(()=>analyzeOptionStrategy({...strategy([leg('BUY',100,5)]),valuation:{...valuation,model:'CRR',steps:2000}}),{code:'INVALID_STRATEGY'});
});
const fields={name:'Personal plan',objective:'Diversification',riskTolerance:'MODERATE',horizonMonths:36,budget:10000,maxPositionWeight:0.6,weights:{A:0.5,B:0.5}};
test('multi-turn investment plans ask for absent inputs and require a separate human acceptance',async t=>{
  const f=fixture(t),model={actor:'model',allowedScopes:['portfolio']};
  let row=await f.run('plan.draft',{fields:{name:fields.name}},model);assert(row.missing.includes('budget'));assert.equal(row.status,'NEEDS_INPUT');
  await assert.rejects(f.run('plan.accept',{id:row.id,revision:row.revision}),{code:'PLAN_STATE'});
  row=await f.run('plan.draft',{id:row.id,revision:row.revision,fields},model);assert.equal(row.status,'READY');
  await assert.rejects(f.run('plan.accept',{id:row.id,revision:row.revision},model),{code:'HUMAN_REQUIRED'});
  const accepted=await f.run('plan.accept',{id:row.id,revision:row.revision});assert.equal(accepted.status,'ACCEPTED');assert.deepEqual((await f.run('portfolio.get',{id:accepted.portfolioId},model)).weights,fields.weights);
  assert.equal(f.calls.length,0);assert.equal(f.service.store.list('tradeIntent').length,0);
  await assert.rejects(f.run('plan.draft',{id:row.id,revision:accepted.revision,fields:{}},model),{code:'PLAN_STATE'});
});
test('plans reject incompatible constraints and preserve scopes through accepted portfolios',async t=>{
  const f=fixture(t),context={actor:'model',allowedScopes:['portfolio','broker']};
  let row=await f.run('plan.draft',{fields:{...fields,maxPositionWeight:0.4,excludedSymbols:['A']}},context);assert.equal(row.violations.length,3);
  row=await f.run('plan.draft',{id:row.id,revision:row.revision,fields:{maxPositionWeight:0.6},clear:['excludedSymbols']},context);
  await assert.rejects(f.run('plan.get',{id:row.id},{actor:'model',allowedScopes:['portfolio']}),{code:'SCOPE_DENIED'});
  assert.deepEqual(await f.run('plan.list',{}, {actor:'model',allowedScopes:['portfolio']}),[]);
  const accepted=await f.run('plan.accept',{id:row.id,revision:row.revision});
  await assert.rejects(f.run('portfolio.get',{id:accepted.portfolioId},{actor:'model',allowedScopes:['portfolio']}),{code:'SCOPE_DENIED'});
  assert.deepEqual(await f.run('portfolio.list',{}, {actor:'model',allowedScopes:['portfolio']}),[]);
});
test('holdings stay per currency and preserve unknown prices, source time and strategy cost',async t=>{
  const f=fixture(t);f.state.snapshot.positions.push({instrumentId:'2',symbol:'EU',currency:'EUR',marketValue:'200',quantity:'2',assetClass:'STK'},{instrumentId:'3',currency:'USD',marketValue:null,quantity:'1',assetClass:'OPT'});
  const snapshot=f.snapshot(),scopes={actor:'model',allowedScopes:['broker','portfolio']};
  await assert.rejects(f.run('holdings.analyze',{snapshotId:snapshot.id},{actor:'model',allowedScopes:['portfolio']}),{code:'SCOPE_DENIED'});
  const report=await f.run('holdings.analyze',{snapshotId:snapshot.id},scopes);assert.equal(report.currencies.length,2);assert.equal(report.currencies.find(x=>x.currency==='USD').netAssetValue,null);assert.equal(report.complete,false);assert(report.missing.includes('snapshot_source_time_unknown'));assert.equal(report.strategyLedgerUpdated,false);
  assert.deepEqual(f.service.store.require('snapshot',snapshot.id),snapshot);
});
test('personalized brief queries held stocks, with combined broker, portfolio and market grants',async t=>{
  const f=fixture(t),snapshot=f.snapshot();await assert.rejects(f.run('holdings.brief',{snapshotId:snapshot.id},{actor:'model',allowedScopes:['broker','portfolio']}),{code:'SCOPE_DENIED'});
  const report=await f.run('holdings.brief',{snapshotId:snapshot.id},{actor:'model',allowedScopes:['broker','portfolio','market']});assert(report.research);assert(f.calls.every(x=>x.args.symbol==='TEST'));assert.equal(report.orderSubmitted,false);
});
test('prediction boards disclose sample coverage and omit unavailable price changes',async t=>{
  const f=fixture(t);const board=await f.run('predict.board',{platform:'kalshi',ranking:'movers'});assert.equal(board.data.length,0);assert.equal(board.excludedMissing,1);assert.equal(board.coverage,'RETURNED_PAGE_ONLY');
});
test('Kalshi fixed-point books derive asks from opposite bids with no invented timestamp',()=>{
  const result=kalshiDepth({orderbook_fp:{yes_dollars:[['0.42','12.5'],['0.40','20']],no_dollars:[['0.55','5']]}},0);
  assert.equal(result.bestBid,'0.42');assert.equal(result.bestAsk,'0.45');assert.equal(result.bids[0].quantity,'12.5');assert.equal(result.asOf,null);
  assert.throws(()=>kalshiDepth({orderbook_fp:{yes_dollars:[['0.6','1']],no_dollars:[['0.6','1']]}},0),{code:'UPSTREAM_SCHEMA'});
});
test('Polymarket books verify market and token identity, reject malformed and duplicate depth',()=>{
  const book={asset_id:'123',market:'0xabc',timestamp:'1795600800000',bids:[{price:'0.4',size:'2'}],asks:[{price:'0.5',size:'3'}]};
  assert.equal(polymarketDepth(book,'123','0xabc').spread,'0.1');
  assert.throws(()=>polymarketDepth(book,'124','0xabc'),{code:'UPSTREAM_SCHEMA'});
  assert.throws(()=>polymarketDepth({...book,bids:[...book.bids,...book.bids]},'123','0xabc'),{code:'UPSTREAM_SCHEMA'});
});
test('live depth transport resolves outcome tokens from canonical market metadata and uses only fixed-host GETs',async()=>{
  const calls=[];const p=createProviders({predict:{enabled:true},limits:{minIntervalMs:0}},{fetchImpl:async(url,init)=>{calls.push({url,init});return Response.json(url.hostname==='gamma-api.polymarket.com'?{id:'1',conditionId:'0xabc',outcomes:'["Yes","No"]',outcomePrices:'["0.4","0.6"]',clobTokenIds:'["123","456"]'}:{asset_id:'456',market:'0xabc',timestamp:'1795600800000',bids:[{price:'0.5',size:'2'}],asks:[{price:'0.6',size:'3'}]});}});
  const result=await p.request('predict.orderbook',{platform:'polymarket',id:'1',outcomeIndex:1});assert.equal(result.data.bestAsk,'0.6');assert.equal(calls[1].url.origin,'https://clob.polymarket.com');assert.equal(calls[1].url.searchParams.get('token_id'),'456');assert(calls.every(c=>c.init.method==='GET'));
  await assert.rejects(p.request('predict.orderbook',{platform:'polymarket',id:'1',outcomeIndex:2}),{code:'INVALID_INPUT'});
});
const conditionInput={name:'Stop preview',kind:'SINGLE',maxAgeMs:300000,expiresAt:'2027-01-01T00:00:00Z',legs:[{type:'STOP_LIMIT',triggerPrice:'95.00',order:{symbol:'TEST',assetClass:'STOCK',side:'SELL',positionEffect:'CLOSE',quantity:1,type:'LIMIT',limitPrice:'94.00',currency:'USD',timeInForce:'GTC',session:'REGULAR',estimatedFees:'0.00'}}]};
test('condition worker fires once, saves a draft and notification, never accepts or submits it',async t=>{
  const f=fixture(t),rule=await f.run('conditions.create',conditionInput),job=await f.run('jobs.configure',{kind:'CONDITION',conditionId:rule.id,intervalMs:60000,enabled:true});
  await f.service.backgroundTick();const row=f.service.store.require('assistantJob',job.id);assert.equal(row.enabled,false);assert.equal(row.lastResult.matched,true);assert.equal(row.lastResult.draft.confirmationToken,undefined);assert.equal(f.service.store.list('order')[0].status,'DRAFT');
  await f.service.backgroundTick();assert.equal(f.service.store.list('order').length,1);assert.equal(f.service.store.list('tradeIntent').length,0);assert(f.calls.every(c=>c.operation==='market.quote'));
});
test('stale or ambiguous quotes cannot trigger a condition',async t=>{
  const f=fixture(t),rule=await f.run('conditions.create',conditionInput),job=await f.run('jobs.configure',{kind:'CONDITION',conditionId:rule.id,intervalMs:60000,enabled:true});
  f.advance(600000);let result=await f.run('jobs.run',{id:job.id});assert.equal(result.lastError.code,'STALE_CONDITION_DATA');assert.equal(f.service.conditions.get(rule.id).status,'ARMED');
  f.state.quote.currency=null;result=await f.run('jobs.run',{id:job.id});assert.equal(result.lastError.code,'QUOTE_IDENTITY');assert.equal(f.service.store.list('order').length,0);
});
test('pausing a job invalidates in-flight work and cross-worker leases prevent duplicates',async t=>{
  const f=fixture(t),rule=await f.run('conditions.create',conditionInput),job=await f.run('jobs.configure',{kind:'CONDITION',conditionId:rule.id,intervalMs:60000,enabled:true});
  let release;f.state.pause=new Promise(resolve=>{release=resolve;});const pending=f.run('jobs.run',{id:job.id});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await f.run('jobs.run',{id:job.id})).skipped,true);
  const current=f.service.store.require('assistantJob',job.id);await f.run('jobs.configure',{id:job.id,revision:current.revision,kind:'CONDITION',enabled:false,intervalMs:60000});release();assert.equal((await pending).discarded,true);assert.equal(f.service.store.list('order').length,0);
});
test('holdings schedules persist private reports and notifications without leaking through portfolio-only tools',async t=>{
  const f=fixture(t),job=await f.run('jobs.configure',{kind:'HOLDINGS_BRIEF',accountId:'DU1',enabled:true,intervalMs:60000});
  const result=await f.run('jobs.run',{id:job.id});assert(result.reportId);assert.equal(f.service.store.list('snapshot').length,1);
  await assert.rejects(f.run('holdings.report',{id:result.reportId},{actor:'model',allowedScopes:['portfolio']}),{code:'SCOPE_DENIED'});
  assert.deepEqual(await f.run('notifications.list',{}, {actor:'model',allowedScopes:['portfolio']}),[]);assert.equal(f.service.store.list('file').length,0);
});
test('missing or duplicate currency cash is never treated as an available zero balance',async t=>{
 const f=fixture(t);f.state.snapshot.cash=[];const row=await f.run('holdings.analyze',{snapshotId:f.snapshot().id});assert.equal(row.currencies[0].reportedCash,null);assert.equal(row.currencies[0].netAssetValue,null);assert.equal(row.valuationComplete,false);
 f.state.snapshot.cash=[{currency:'USD',cash:'1'},{currency:'USD',cash:'1'}];await assert.rejects(f.run('holdings.analyze',{snapshotId:f.snapshot().id}),{code:'INVALID_SNAPSHOT'});
});
