import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TradingService} from '../../../packages/trading/service.js';
import {renderableChildren,formValues,visibleResult,historyScopeRequirements,missingScopes,canConfirmOrder,chartSeries,operationAvailable,formatNumber,safeExternalURL,downloadPayload,newsCategory} from '../web/ui-model.js';
import {translate} from '../web/copy.js';

test('standalone form preserves decimal strings, zero and explicit false while rejecting malformed fields',()=>{
 const schema={type:'object',required:['cash','quantity','enabled'],properties:{cash:{type:'string'},quantity:{type:'number'},enabled:{type:'boolean'},rows:{type:'array'},weights:{type:'object'}}};
 assert.deepEqual(formValues(schema,{cash:'0.10',quantity:'0',enabled:'false',rows:'[]',weights:'{"A":1}'}),{cash:'0.10',quantity:0,enabled:false,rows:[],weights:{A:1}});
 assert.throws(()=>formValues(schema,{cash:'0.10',quantity:' ',enabled:'false'}));
 assert.throws(()=>formValues(schema,{cash:'0.10',quantity:'1',enabled:'maybe'}));
 assert.throws(()=>formValues(schema,{cash:'0.10',quantity:'1',enabled:'true',rows:'{}'}));
});

test('standalone form calls the actual deterministic service and keeps readonly confirmation disabled',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'pi-ui-contract-'));const s=new TradingService({path:join(directory,'state.sqlite')});t.after(()=>{s.close();rmSync(directory,{recursive:true,force:true})});
 const boot=s.bootstrap(),pricing=boot.catalog.find(o=>o.operation==='quant.price');
 const args=formValues(pricing.inputSchema,Object.fromEntries(Object.entries(pricing.example).map(([k,v])=>[k,String(v)])));
 const value=await s.execute('quant.price',args);assert.ok(Math.abs(value.price-2.4933768194037285)<1e-10);assert.equal(formatNumber(value.price,'en'),'2.49337682');
 const order=boot.catalog.find(o=>o.operation==='order.preview');const preview=await s.execute(order.operation,formValues(order.inputSchema,order.example));
 assert.equal(canConfirmOrder(preview),false);assert.equal(visibleResult(preview).confirmationToken,undefined);
 assert.equal(operationAvailable('market.quote',boot.capabilities),false);assert.equal(operationAvailable('research.stock',boot.capabilities),false);assert.equal(operationAvailable('quant.price',boot.capabilities),true);
});

test('copy and export omit nested confirmation credentials and internal histories without changing numeric values',()=>{
 const raw={price:2.4933768194037285,tokenHash:'hidden',draft:{confirmationToken:'secret',order:{symbol:'A'}},list:[{apiKey:'secret',price:'0.10'}],piMessages:[{role:'user'}]};
 assert.deepEqual(visibleResult(raw),{price:raw.price,draft:{order:{symbol:'A'}},list:[{price:'0.10'}]});
 assert.equal(raw.draft.confirmationToken,'secret');
});

test('order confirmation requires enabled simulation, an account, an unexpired preview and credential',()=>{
 const now=Date.parse('2026-11-21T10:00:00Z'),p={id:'draft',confirmationToken:'c',order:{accountId:'local'},executionEnabled:true,expiresAt:'2026-11-21T10:05:00Z'};
 assert.equal(canConfirmOrder(p,now),true);assert.equal(canConfirmOrder({...p,executionEnabled:false},now),false);assert.equal(canConfirmOrder({...p,order:{}},now),false);assert.equal(canConfirmOrder(p,now+300000),false);
});

test('history scopes include older granted private data and are never automatically selected',()=>{
 const chat={historyScopes:['broker','localRead','localWrite','shell'],messages:[{allowedScopes:['market','files','ledger']},{allowedScopes:['compute','portfolio','files']}]};
 assert.deepEqual(historyScopeRequirements(chat),['broker','files','ledger','localRead','localWrite','portfolio','shell']);assert.deepEqual(missingScopes(chat,['market','compute','predict']),['broker','files','ledger','localRead','localWrite','portfolio','shell']);assert.deepEqual(missingScopes(chat,['market','broker','files','ledger','portfolio','localRead','localWrite','shell']),[]);
});

test('financial chart switches numeric metrics and leaves missing series uncharted',()=>{
 const rows=[{date:'2026-09-30',revenue:'200',netIncome:20},{date:'2026-06-30',revenue:'100',netIncome:10}];
 const result=chartSeries(rows);assert.deepEqual(result.keys,['revenue','netIncome']);assert.equal(result.rows[0].date,'2026-06-30');assert.equal(rows[0].date,'2026-09-30');assert.equal(chartSeries([{date:'1',revenue:null},{date:'2',revenue:200}]),null);
});

test('source links reject executable schemes and saved text downloads preserve exact content',()=>{
 assert.equal(safeExternalURL('javascript:alert(1)'),null);assert.equal(safeExternalURL('https://name:secret@example.com'),null);assert.equal(newsCategory({title:'an event',category:'UNCLASSIFIED'}),'unclassified');assert.equal(safeExternalURL('https://example.com/news'),'https://example.com/news');assert.equal(newsCategory({title:'Federal Reserve inflation outlook'}),'macro');
 const content='\uFEFFa,b\r\n1,2\r\n';assert.deepEqual(downloadPayload({name:'records.csv',mimeType:'text/csv',content}),{name:'records.csv',mime:'text/csv',content});assert.throws(()=>downloadPayload({name:'missing'}));
});

test('standalone navigation and permission guidance have explicit Traditional and English copy',()=>{
 assert.equal(translate('options','zh-TW'),'期權與規則');assert.equal(translate('conversations','en'),'Trading conversations');assert.notEqual(translate('historyScope','zh-TW'),translate('historyScope','zh'));assert.ok(translate('shareHelp','en').includes('local-only'));
});


test('conditional children omit boolean and nullish values while preserving zero and empty text',()=>{
 const node={tag:'span'};assert.deepEqual(renderableChildren(false,null,undefined,true,[node,0,'',['visible']]),[node,0,'','visible']);
});
