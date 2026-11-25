/** Entirely synthetic, offline example; temporary databases are removed on exit. */
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Ledger} from '../packages/ledger/ledger.js';
import {TradingService} from '../packages/trading/service.js';

const directory=mkdtempSync(join(tmpdir(),'trading-agent-reconciliation-'));
const ledger=new Ledger(join(directory,'ledger.sqlite'));
const service=new TradingService({path:join(directory,'business.sqlite'),ledger});
try {
  ledger.change({action:'savePosition',revision:0,requestId:'synthetic-opening',data:{symbol:'DEMO',shares:'100',nominalCost:'10000',openingNetPremium:'0',asOf:'2026-11-25'}});
  const snapshot=service.store.put('snapshot','synthetic-example',{
    immutable:true,accountId:'DU1',mode:'synthetic',inputAuthority:'SYNTHETIC_FIXTURE',source:'offline-example',receivedAt:new Date().toISOString(),asOf:null,
    data:{accountId:'DU1',positions:[{instrumentId:'123',symbol:'DEMO',assetClass:'STK',quantity:'101',currency:'USD'}],executions:[],coverage:{positionsComplete:true,executionsComplete:false}},
  },0);
  const report=await service.execute('reconcile.create',{snapshotId:snapshot.id,ledgerRevision:ledger.read().revision,accountScopeConfirmed:true,bindings:[{symbol:'DEMO',instrumentId:'123',currency:'USD'}]});
  console.log(JSON.stringify({example:'SYNTHETIC_OFFLINE',positions:report.positions,limitations:report.limitations,ledgerUpdated:report.ledgerUpdated},null,2));
} finally {service.close();ledger.close();rmSync(directory,{recursive:true,force:true});}
