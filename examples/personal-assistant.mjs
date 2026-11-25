/** Explicit synthetic scenario: no model, credentials, market queries or broker orders. */
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {TradingService} from '../packages/trading/service.js';
import {catalog} from '../packages/trading/catalog.js';
const home=mkdtempSync(join(tmpdir(),'trading-personal-example-')),service=new TradingService({path:join(home,'workspace.sqlite')});
try{
 const model={actor:'model',allowedScopes:['portfolio']};
 let plan=await service.execute('plan.draft',{fields:{name:'Synthetic research plan',objective:'Discuss diversification'}},model);
 console.log('Missing inputs:',plan.missing);
 plan=await service.execute('plan.draft',{id:plan.id,revision:plan.revision,fields:{riskTolerance:'MODERATE',horizonMonths:36,budget:10000,maxPositionWeight:0.6,weights:{AAA:0.5,BBB:0.5}}},model);
 const accepted=await service.execute('plan.accept',{id:plan.id,revision:plan.revision});
 const result=await service.execute('options.strategy',catalog.find(row=>row.operation==='options.strategy').example);
 console.log(JSON.stringify({authority:'SYNTHETIC_SCENARIO',plan:accepted.status,maxLoss:result.maxLoss,maxProfit:result.maxProfit,breakEven:result.breakEven,greeks:result.greeks,orders:service.store.list('tradeIntent').length},null,2));
}finally{service.close();rmSync(home,{recursive:true,force:true});}
