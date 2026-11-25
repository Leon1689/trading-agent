/** Personal research state. Draft investment plans never authorize broker actions. */
import { randomUUID } from 'node:crypto';
import { requireThat } from './errors.js';

const number = value => (typeof value==='number'||typeof value==='string') && String(value).trim()!=='' && Number.isFinite(Number(value)) ? Number(value) : null;
const symbol = value => typeof value==='string' && /^[A-Z0-9.-]{1,24}$/.test(value);
const boundedText = (value,max=2000) => typeof value==='string' && value.trim().length>0 && value.length<=max;
const questions={name:'这个投资计划叫什么？',objective:'希望实现什么投资目标？',riskTolerance:'可接受的风险是保守、中等还是进取？',horizonMonths:'计划持有多少个月？',budget:'计划使用多少美元预算？',maxPositionWeight:'单一标的权重上限是多少（0到1）？',weights:'准备配置哪些标的及权重？'};
const planKeys=[...Object.keys(questions),'excludedSymbols','note'];
const privateScopes=['portfolio','broker','ledger','trade','files','localRead','localWrite','shell','resources'];
export class InvestmentAssistant {
  constructor(service){this.service=service;this.store=service.store;this.now=service.now;}
  allowed(row,context){return context.actor!=='model'||(row.requiredScopes??['portfolio']).every(scope=>context.allowedScopes.includes(scope));}
  getPlan(id,context){const row=this.store.require('investmentPlan',id);requireThat(this.allowed(row,context),'SCOPE_DENIED','计划包含本轮未授权的私人资料。',403);return row;}
  plan(input,context){
    const prior=input.id?this.getPlan(input.id,context):null;
    if(prior) requireThat(prior.revision===input.revision && prior.status!=='ACCEPTED','PLAN_STATE','计划已确认或版本已变更；已确认计划请创建新计划。',409);
    requireThat(input.fields && typeof input.fields==='object' && !Array.isArray(input.fields) && Object.keys(input.fields).every(k=>planKeys.includes(k)),'INVALID_PLAN','投资计划字段无效。');
    requireThat(input.clear===undefined||Array.isArray(input.clear)&&input.clear.every(k=>planKeys.includes(k)),'INVALID_PLAN','清空字段无效。');
    const fields={...prior?.fields,...input.fields}; for(const key of input.clear??[])delete fields[key];
    for(const key of ['name','objective','note'])if(fields[key]!==undefined)requireThat(boundedText(fields[key],key==='name'?120:2000),'INVALID_PLAN',`${key}格式无效。`);
    if(fields.riskTolerance!==undefined)requireThat(['CONSERVATIVE','MODERATE','AGGRESSIVE'].includes(fields.riskTolerance),'INVALID_PLAN','风险偏好无效。');
    if(fields.horizonMonths!==undefined)requireThat(Number.isSafeInteger(fields.horizonMonths)&&fields.horizonMonths>=1&&fields.horizonMonths<=600,'INVALID_PLAN','期限须为1到600个月。');
    if(fields.budget!==undefined)requireThat(typeof fields.budget==='number'&&Number.isFinite(fields.budget)&&fields.budget>0&&fields.budget<=1e9,'INVALID_PLAN','美元预算无效。');
    if(fields.maxPositionWeight!==undefined)requireThat(typeof fields.maxPositionWeight==='number'&&fields.maxPositionWeight>0&&fields.maxPositionWeight<=1,'INVALID_PLAN','单一权重上限无效。');
    if(fields.excludedSymbols!==undefined)requireThat(Array.isArray(fields.excludedSymbols)&&fields.excludedSymbols.length<=100&&fields.excludedSymbols.every(symbol),'INVALID_PLAN','排除标的无效。');
    if(fields.weights!==undefined){
      requireThat(fields.weights && typeof fields.weights==='object'&&!Array.isArray(fields.weights),'INVALID_PLAN','权重须为对象。');
      const entries=Object.entries(fields.weights);
      requireThat(entries.length>=1&&entries.length<=30&&entries.every(([s,w])=>symbol(s)&&typeof w==='number'&&Number.isFinite(w)&&w>0&&w<=1)&&Math.abs(entries.reduce((n,[,w])=>n+w,0)-1)<=1e-9,'INVALID_PLAN','研究组合权重须为正，合计为1。');
    }
    const missing=Object.keys(questions).filter(k=>fields[k]===undefined), violations=[];
    for(const [s,w] of Object.entries(fields.weights??{})){
      if(fields.excludedSymbols?.includes(s))violations.push(`${s}:EXCLUDED`);
      if(fields.maxPositionWeight!==undefined&&w>fields.maxPositionWeight+1e-9)violations.push(`${s}:WEIGHT_LIMIT`);
    }
    if(input.sourceText!==undefined)requireThat(boundedText(input.sourceText,10000),'INVALID_PLAN','需求原文无效。');
    const requiredScopes=[...new Set(['portfolio',...(prior?.requiredScopes??[]),...(context.actor==='model'?context.allowedScopes.filter(scope=>privateScopes.includes(scope)):[])])];
    return this.store.put('investmentPlan',prior?.id??randomUUID(),{fields,missing,questions:missing.map(field=>({field,question:questions[field]})),violations,status:missing.length||violations.length?'NEEDS_INPUT':'READY',currency:'USD',type:'RESEARCH_ONLY',requiredScopes,createdBy:prior?.createdBy??context.actor,chatId:prior?.chatId??context.chatId??null,sourceMessage:context.sourceMessage??input.sourceText??prior?.sourceMessage??null,allocationAuthority:'PROPOSED_UNTIL_HUMAN_ACCEPTANCE',orderSubmitted:false},prior?.revision??0);
  }
  accept({id,revision}){
    return this.store.transaction(()=>{
      const row=this.store.require('investmentPlan',id);requireThat(row.revision===revision&&row.status==='READY','PLAN_STATE','计划尚未完整或版本已变化。',409);
      const portfolio=this.store.put('portfolio',randomUUID(),{name:row.fields.name,weights:row.fields.weights,note:row.fields.objective,type:'RESEARCH_ONLY',requiredScopes:row.requiredScopes,investmentPlanId:id,investmentPlanRevision:revision},0);
      return this.store.put('investmentPlan',id,{...row,status:'ACCEPTED',acceptedAt:new Date(this.now()).toISOString(),portfolioId:portfolio.id,allocationAuthority:'HUMAN_ACCEPTED_RESEARCH_PLAN',orderSubmitted:false},revision);
    });
  }
  holdings({snapshotId}){
    return this.analyzeSnapshot(this.store.require('snapshot',snapshotId));
  }
  analyzeSnapshot(snapshot){
    const snapshotId=snapshot.id, data=snapshot.data;
    requireThat(snapshot.immutable===true&&data&&Array.isArray(data.positions)&&Array.isArray(data.cash),'INVALID_SNAPSHOT','须使用已保存的券商快照。');
    const buckets=new Map(), missing=[...(snapshot.missing??[])];
    const bucket=currency=>{if(!buckets.has(currency))buckets.set(currency,{currency,reportedCash:0,netPositionValue:0,grossPositionValue:0,positions:[],missingCash:true,missingPositionValue:false});return buckets.get(currency);};
    const seen=new Set(), positions=data.positions.map((p,index)=>{
      const identity=p.instrumentId??`unknown-${index}`;requireThat(!seen.has(identity),'INVALID_SNAPSHOT','快照含重复合约，无法安全统计。');seen.add(identity);
      const currency=typeof p.currency==='string'&&/^[A-Z]{3}$/.test(p.currency)?p.currency:'UNKNOWN', value=number(p.marketValue), quantity=number(p.quantity);
      const b=bucket(currency);if(value===null){b.missingPositionValue=true;missing.push(`position_${identity}_marketValue`);}else{b.netPositionValue+=value;b.grossPositionValue+=Math.abs(value);}
      if(quantity===null)missing.push(`position_${identity}_quantity`);
      const row={instrumentId:p.instrumentId,symbol:p.symbol,currency,assetClass:p.assetClass,quantity,marketValue:value,brokerCostBasis:p.brokerCostBasis,costBasisUnit:p.costBasisUnit,portfolioGreeks:null};b.positions.push(row);return row;
    });
    const cashCurrencies=new Set();
    for(const cash of data.cash){const currency=typeof cash.currency==='string'&&/^[A-Z]{3}$/.test(cash.currency)?cash.currency:'UNKNOWN';requireThat(!cashCurrencies.has(currency),'INVALID_SNAPSHOT','快照含重复币种现金，无法安全统计。');cashCurrencies.add(currency);const b=bucket(currency),value=number(cash.cash);b.missingCash=value===null;if(value!==null)b.reportedCash=value;}
    const currencies=[...buckets.values()].map(b=>({...b,reportedCash:b.missingCash?null:b.reportedCash,netAssetValue:b.missingCash||b.missingPositionValue||b.currency==='UNKNOWN'?null:b.reportedCash+b.netPositionValue,positions:b.positions.map(p=>({...p,grossWeight:p.marketValue===null||b.missingPositionValue||b.grossPositionValue===0||data.coverage?.positionsComplete!==true?null:Math.abs(p.marketValue)/b.grossPositionValue})).sort((a,b)=>(b.grossWeight??-1)-(a.grossWeight??-1))}));
    const symbols=[...new Set(positions.filter(p=>['STK','STOCK'].includes(p.assetClass)&&p.quantity!==0&&symbol(p.symbol)).map(p=>p.symbol))];
    return {snapshotId,accountId:data.accountId??snapshot.accountId,source:snapshot.source,asOf:snapshot.asOf,receivedAt:snapshot.receivedAt,mode:snapshot.mode,currencies,positions,researchSymbols:symbols,missing:[...new Set([...missing,'no_cross_currency_total_without_fx','options_greeks_require_contract_valuation_inputs','broker_cost_is_not_Wheel_cost',...(snapshot.asOf?[]:['snapshot_source_time_unknown'])])],positionsComplete:data.coverage?.positionsComplete===true,valuationComplete:data.coverage?.positionsComplete===true&&!currencies.some(c=>c.missingPositionValue||c.missingCash||c.currency==='UNKNOWN'),complete:false,atomic:false,strategyLedgerUpdated:false};
  }
  async brief(args,context){
    return this.researchHoldings(this.holdings(args),context);
  }
  async researchHoldings(analysis,context){
    const symbols=analysis.researchSymbols.slice(0,8);
    const research=symbols.length?await this.service.execute('research.brief',{symbols},{...context}):null;
    context.signal?.throwIfAborted();
    return {holdings:analysis,research,omittedSymbols:analysis.researchSymbols.slice(8),missing:analysis.positions.some(p=>['OPT','OPTION'].includes(p.assetClass))?['option_underlying_mapping_not_inferred']:[],generatedAt:new Date(this.now()).toISOString(),requiredScopes:['broker','portfolio','market'],orderSubmitted:false};
  }
  async opportunities({category='active',limit=10},context){
    const result=await this.service.providers.request('market.screen',{category,limit},{signal:context.signal});
    requireThat(Array.isArray(result.data),'INVALID_MARKET_DATA','榜单数据格式无效。');
    return {...result,ranking:'PROVIDER_SCREEN_ORDER',proprietaryHotScore:false,data:result.data.map(row=>({...row,researchPrompt:`研究 ${row.symbol??row.ticker??''}：核对价格和时点、财报与新闻，解释机会与反例，再询问我的期限、预算及风险偏好；所有交易先生成待我确认的草稿。`}))};
  }
  async predictionBoard(args,context){
    const result=await this.service.providers.request('predict.markets',{platform:args.platform,limit:args.limit??100},{signal:context.signal});
    requireThat(Array.isArray(result.data),'INVALID_MARKET_DATA','预测市场数据格式无效。');
    const rows=result.data.map(row=>({...row,displayPrice:number(row.outcomes?.[0]?.price),volume24hValue:number(row.volume24h),priceChange24hValue:number(row.priceChange24h)}));
    const key={volume:'volume24hValue',lowPrice:'displayPrice',movers:'priceChange24hValue'}[args.ranking];requireThat(key,'INVALID_RANKING','榜单类型无效。');
    const ranked=rows.filter(r=>r[key]!==null).sort((a,b)=>args.ranking==='lowPrice'?a[key]-b[key]:args.ranking==='movers'?Math.abs(b[key])-Math.abs(a[key]):b[key]-a[key]);
    return {...result,data:ranked,ranking:args.ranking,coverage:'RETURNED_PAGE_ONLY',excludedMissing:rows.length-ranked.length,missing:[...(result.missing??[]),'not_a_global_market_ranking','no_subjective_probability_or_expected_return_inferred']};
  }
  async execute(operation,args,context){
    switch(operation){
      case 'plan.draft':return this.plan(args,context);
      case 'plan.get':return this.getPlan(args.id,context);
      case 'plan.list':return this.store.list('investmentPlan',args).filter(row=>this.allowed(row,context));
      case 'plan.accept':return this.accept(args);
      case 'holdings.analyze':return this.holdings(args);
      case 'holdings.brief':return this.brief(args,context);
      case 'research.opportunities':return this.opportunities(args,context);
      case 'predict.board':return this.predictionBoard(args,context);
    }
  }
}
