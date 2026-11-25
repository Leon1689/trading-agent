import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {TradingService} from '../../../packages/trading/service.js';
import {Ledger} from '../../../packages/ledger/ledger.js';
import {locales} from '../../../packages/trading/locales.js';

/** A small DOM event harness; requests run through the actual local service and ledger. */
class Element {
 constructor(tag,root=false){this.tagName=tag;this.children=[];this.attributes={};this.listeners={};this.parentNode=null;this.value='';this.disabled=false;this.checked=false;this.root=root;this.nodeText='';}
 get isConnected(){return this.root||!!this.parentNode?.isConnected;}
 get textContent(){return this.nodeText+this.children.map(n=>n.textContent).join('');}
 set textContent(value){this.nodeText=String(value);this.children=[];}
 setAttribute(key,value){this.attributes[key]=String(value);if(key==='class')this.className=String(value);if(key==='id')this.id=String(value);}
 append(...values){for(const value of values.flat(Infinity)){const n=value instanceof Element?value:Object.assign(new Element('#text'),{nodeText:String(value)});n.parentNode=this;this.children.push(n);if(this.tagName==='select'&&this.children.length===1)this.value=n.value;}}
 prepend(...values){const previous=this.children;this.children=[];this.append(...values);this.children.push(...previous);}
 replaceChildren(...values){for(const child of this.children)child.parentNode=null;this.children=[];this.nodeText='';this.append(...values);}
 remove(){if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}
 addEventListener(name,fn){(this.listeners[name]??=[]).push(fn);}
 async event(name,extra={}){for(const fn of this.listeners[name]??[])await fn({target:this,preventDefault(){},...extra});}
 async click(){assert.equal(this.disabled,false,'Attempted disabled control');await this.event('click');}
 scrollIntoView(){}
 querySelector(selector){return all(this).find(n=>selector.startsWith('.')?n.className?.split(' ').includes(selector.slice(1)):selector.startsWith('#')?n.id===selector.slice(1):n.tagName===selector)??null;}
}
function all(node){return [node,...node.children.flatMap(all)];}
async function mount(t,{model=false,images=false,config:overrides={},gateway}={}){
 const dir=mkdtempSync(join(tmpdir(),'pi-native-ui-dom-')),ledger=new Ledger(join(dir,'ledger.sqlite'));
 const runner=Object.assign(async()=>({answer:'Synthetic fixture answer; no external model was called.',messages:[],usage:null}),{supportsImages:images});
 const service=new TradingService({path:join(dir,'workbench.sqlite'),ledger,config:{...(model?{pi:{enabled:true,provider:'test',model:'test',apiKeyEnv:'UI_TEST_NO_REAL_KEY'}}:{}),...overrides},gateway,runner});
 const body=new Element('body',true),app=new Element('div');app.id='app';body.append(app);const requests=[],errors=[],pending=new Set(),originals=new Map();
 const document={body,documentElement:new Element('html'),createElement:tag=>new Element(tag),createTextNode:text=>Object.assign(new Element('#text'),{nodeText:String(text)}),createElementNS:(_,tag)=>new Element(tag),getElementById:id=>all(body).find(n=>n.id===id),querySelector:selector=>body.querySelector(selector)};
 const replace=(key,value)=>{originals.set(key,Object.getOwnPropertyDescriptor(globalThis,key));Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});};
 replace('Node',Element);replace('document',document);replace('window',{addEventListener(){},scrollTo(){}});replace('location',{origin:'http://127.0.0.1:3092'});replace('localStorage',{getItem:()=>null,setItem(){}});replace('navigator',{clipboard:{writeText:async()=>{}}});
 replace('FileReader',class{readAsDataURL(file){this.result=`data:${file.type};base64,${file.dataBase64}`;this.onload();}});
 replace('fetch',(url,options={})=>{const promise=(async()=>{try{let data;if(options.method==='POST'){assert.equal(options.headers['x-pi-trader'],'1');const command=JSON.parse(options.body);requests.push(command);data=url==='/api/ledger'?ledger.change(command):await service.execute(command.operation,command.args,{signal:options.signal});}else if(url==='/api/ledger')data=ledger.view();else data={...service.bootstrap(),locales,runtime:{framework:'pi-coding-agent',version:'1.6.0',standalone:true}};return{ok:true,status:200,json:async()=>url==='/api/ledger'?data:{ok:true,data}};}catch(error){errors.push(error);return{ok:false,status:error.status??400,json:async()=>({ok:false,error:{code:error.code,message:error.message}})};}})();pending.add(promise);promise.finally(()=>pending.delete(promise));return promise;});
 t.after(()=>{for(const[key,descriptor]of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}service.close();ledger.close();rmSync(dir,{recursive:true,force:true});});
 const settle=async()=>{for(let i=0;i<10;i++){await Promise.all([...pending]);await new Promise(resolve=>setImmediate(resolve));if(!pending.size)break;}};
 await import(`../web/app.js?dom-test=${crypto.randomUUID()}`);await settle();
 const find=(tag,text)=>all(body).find(n=>n.tagName===tag&&n.textContent===text);
 const click=async(tag,text)=>{const node=find(tag,text);assert(node,`Missing ${tag}: ${text}`);await node.click();await settle();};
 const input=name=>all(body).find(n=>n.attributes['aria-label']===name);
 const setField=async(name,value)=>{const node=all(body).find(n=>n.attributes.name===name);assert(node,`Missing field ${name}`);node.value=value;await node.event('input');};
 return{body,app,service,ledger,requests,errors,find,click,input,setField,settle};
}

test('standalone navigation, quant calculation and readonly preview operate against the actual service',async t=>{
 const ui=await mount(t);assert.match(ui.app.textContent,/trading agent/);assert(ui.app.textContent.includes(String(ui.service.bootstrap().catalog.length)));assert.equal(ui.requests.length,0);
 for(const name of ['◉市场研究','Δ期权与规则','◫组合与回测','◇预测市场','⇄模拟订单','≋成交与持仓对账','◷提醒与简报','▤资料与报告','◌交易对话','▦期权账本','⚙能力与设置'])await ui.click('button',name);
 assert.equal(ui.errors.length,0);assert.equal(ui.requests.some(c=>c.operation?.startsWith('broker.')),false);
 await ui.click('button','Δ期权与规则');const operation=ui.input('选择操作');operation.value='quant.price';await operation.event('change');const controlText=ui.app.querySelector('.workspace-grid').children[0].textContent;assert.doesNotMatch(controlText,/false|null|undefined/);await ui.click('button','运行');assert.match(ui.app.textContent,/2\.49337682/);
 await ui.click('button','⇄模拟订单');await ui.click('button','预览');assert.match(ui.app.textContent,/当前只读，不能确认订单/);assert.equal(ui.requests.some(c=>c.operation==='order.confirm'),false);
 await ui.click('button','◉市场研究');const research=ui.input('选择操作');research.value='research.events';await research.event('change');await ui.click('button','运行');assert.ok(all(ui.body).some(n=>n.className==='news-card'));assert.match(ui.app.textContent,/synthetic-example/);assert.equal(ui.errors.length,0);
});

test('standalone ledger persists original cents and refreshes revision after explicit edits',async t=>{
 const ui=await mount(t);await ui.click('button','▦期权账本');await ui.click('button','录入 / 调整持仓');await ui.setField('symbol','AAPL');await ui.setField('shares','100');await ui.setField('nominalCost','10000.01');await ui.click('button','保存');assert.equal(ui.ledger.read().positions.AAPL.nominalCostCents,1000001);assert.equal(ui.ledger.read().revision,1);assert.match(ui.app.textContent,/AAPL/);assert.equal(ui.errors.length,0);
});

test('reconciliation page requires explicit mapping and records a human review without ledger changes',async t=>{
 const ui=await mount(t);
 ui.ledger.change({action:'savePosition',revision:0,data:{symbol:'AAPL',shares:100,nominalCost:10000,openingNetPremium:0,asOf:'2026-11-25'},requestId:'ui-fixture-position'});
 ui.service.store.put('snapshot','synthetic-snapshot',{immutable:true,accountId:'DU1',inputAuthority:'SYNTHETIC_FIXTURE',mode:'synthetic',source:'browser-dom-test',receivedAt:new Date().toISOString(),data:{accountId:'DU1',positions:[{instrumentId:'265598',symbol:'AAPL',assetClass:'STK',quantity:'101',currency:'USD'}],executions:[],coverage:{positionsComplete:true}}},0);
 await ui.click('button','≋成交与持仓对账');await ui.click('button','读取快照与账本');
 await ui.click('button','生成对账报告');assert.equal(ui.service.store.list('reconciliation').length,0);
 ui.input('AAPL conid').value='265598';ui.input('已核对账户与合约映射').checked=true;
 await ui.click('button','生成对账报告');assert.match(ui.app.textContent,/DIFFERENCE/);assert.match(ui.app.textContent,/SYNTHETIC_INPUT_NOT_ACCOUNT_EVIDENCE/);
 ui.input('对账复核意见').value='合成测试差异；未修改账本。';await ui.click('button','记录人工复核');
 assert.equal(ui.service.store.list('reconciliation')[0].status,'REVIEWED');assert.equal(ui.ledger.read().revision,1);assert.equal(ui.errors.length,0);
});

test('order cards enable and pause only read-only monitoring',async t=>{
 const config={execution:{mode:'IBKR_PAPER',ibkr:{baseUrl:'http://127.0.0.1:59999/v1/api',allowInsecureLocal:true,environment:'PAPER',accountIds:['DU1']}}};
 const receipt={orderId:'101',status:'Submitted',filledQuantity:0,remainingQuantity:2,snapshot:true};
 const ui=await mount(t,{config,gateway:{find:async()=>receipt,submit:()=>assert.fail('No submission from watch')}});
 ui.service.store.put('tradeIntent','ui-order',{status:'ACKNOWLEDGED',fields:{accountId:'DU1',symbol:'AAPL',conid:265598,assetClass:'STOCK',currency:'USD',side:'BUY',quantity:2},brokerOrderId:'101',clientOrderId:'ui-fixture',receipt},0);
 await ui.click('button','⇄模拟订单');await ui.click('button','启用自动查单');assert.equal(ui.service.orderMonitor.status({id:'ui-order'}).enabled,true);
 await ui.service.backgroundTick();await ui.click('button','刷新交易卡');assert.match(ui.app.textContent,/上次查询 20/);
 await ui.click('button','暂停自动查单');assert.equal(ui.service.orderMonitor.status({id:'ui-order'}).enabled,false);
 assert.equal(ui.requests.some(row=>row.operation==='trade.confirm'),false);assert.equal(ui.errors.length,0);
});

test('standalone trading chat never auto-enables private history and sends only selected scopes',async t=>{
 const ui=await mount(t,{model:true});await ui.click('button','◌交易对话');await ui.click('button','+');let input=ui.input('输入研究问题');input.value='Fixture question';await input.event('input');await ui.click('button','发送');assert.match(ui.app.textContent,/Synthetic fixture answer/);const sent=ui.requests.find(c=>c.operation==='chat.send');assert.deepEqual(sent.args.allowedScopes,['market','compute','predict']);
 const record=ui.service.store.require('chat',sent.args.id);ui.service.store.put('chat',record.id,{...record,historyScopes:['files']},record.revision);
 await ui.click('button','⌂总览');await ui.click('button','◌交易对话');input=ui.input('输入研究问题');input.value='Continue';await input.event('input');assert.equal(ui.find('button','发送').disabled,true);const filesScope=all(ui.body).find(n=>n.tagName==='label'&&n.textContent==='已导入资料').children[0];assert.equal(filesScope.checked,false);filesScope.checked=true;await filesScope.event('change');await ui.click('button','发送');assert.deepEqual(ui.requests.filter(c=>c.operation==='chat.send').at(-1).args.allowedScopes,['market','compute','predict','files']);assert.equal(ui.errors.length,0);
});


test('image attachments require an explicit files selection and the next turn requires renewed history permission',async t=>{
 const ui=await mount(t,{model:true,images:true});await ui.click('button','◌交易对话');const message=ui.input('输入研究问题');message.value='Inspect the explicitly attached synthetic one-pixel image';await message.event('input');
 const picker=ui.input('附加图片');picker.files=[{name:'fixture.png',type:'image/png',size:68,dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6VhcAAAAASUVORK5CYII='}];await picker.event('change');
 let filesScope=all(ui.body).find(n=>n.tagName==='label'&&n.textContent==='已导入资料').children[0];assert.equal(filesScope.checked,false);assert.equal(ui.find('button','发送').disabled,true);assert.match(ui.app.textContent,/后续继续此会话需要再次选择文件范围/);assert.equal(ui.requests.some(c=>c.operation==='chat.send'),false);
 await ui.click('button','移除');assert.equal(ui.find('button','发送').disabled,false);await picker.event('change');assert.equal(ui.find('button','发送').disabled,true);
 filesScope.checked=true;await filesScope.event('change');await ui.click('button','发送');const sent=ui.requests.find(c=>c.operation==='chat.send');assert.deepEqual(sent.args.allowedScopes,['market','compute','predict','files']);assert.equal(sent.args.attachments[0].name,'fixture.png');const saved=ui.service.store.require('chat',sent.args.id);assert.deepEqual(saved.historyScopes,['files']);assert.equal(saved.messages[0].attachments.length,1);
 filesScope=all(ui.body).find(n=>n.tagName==='label'&&n.textContent==='已导入资料').children[0];assert.equal(filesScope.checked,false);const next=ui.input('输入研究问题');next.value='Continue';await next.event('input');assert.equal(ui.find('button','发送').disabled,true);assert.equal(ui.errors.length,0);
});


test('broker order card requires review plus an unchecked human checkbox before submitting',async t=>{
 let submits=0;
 const config={execution:{mode:'IBKR_PAPER',ibkr:{baseUrl:'http://127.0.0.1:59999/v1/api',environment:'PAPER',accountIds:['DU1']}}};
 const gateway={preview:async()=>({instrument:{symbol:'SYNTHETIC'},whatIf:{amount:{amount:'200 USD'},warn:'Synthetic browser fixture'}}),session:async()=>({isPaper:true}),positionEffect:async()=>({position:0}),submit:async()=>{submits++;return[{order_id:'101',order_status:'Submitted'}];}};
 const ui=await mount(t,{config,gateway});
 const fields={accountId:'DU1',symbol:'AAPL',assetClass:'STOCK',side:'BUY',positionEffect:'OPEN',quantity:2,type:'LIMIT',limitPrice:'100.00',currency:'USD',timeInForce:'DAY',session:'REGULAR',conid:265598};
 let row=await ui.service.execute('trade.intent',{fields});row=await ui.service.execute('trade.prepare',{id:row.id,revision:row.revision});
 await ui.click('button','⇄模拟订单');assert.match(ui.app.textContent,/IBKR模拟 · 人工确认/);assert.equal(submits,0);
 await ui.click('button','核对并准备提交');assert.equal(submits,0);assert.equal(ui.find('button','确认发送至IBKR模拟账户').disabled,true);
 const check=ui.input('我已核对以上订单及券商警告');assert.equal(check.checked,false);check.checked=true;await check.event('change');await ui.click('button','确认发送至IBKR模拟账户');
 assert.equal(submits,1);assert.match(ui.app.textContent,/已取得券商回执/);assert.match(ui.app.textContent,/Submitted/);assert.equal(ui.errors.length,0);
});

test('multi-leg payoff renders a chart and investment plan acceptance requires a separate checkbox',async t=>{
 const ui=await mount(t);await ui.click('button','Δ期权与规则');let select=ui.input('选择操作');select.value='options.strategy';await select.event('change');await ui.click('button','运行');assert.match(ui.app.textContent,/104\.02/);assert(all(ui.app).some(n=>n.tagName==='svg'));
 await ui.click('button','◫组合与回测');select=ui.input('选择操作');select.value='plan.draft';await select.event('change');
 await ui.setField('fields',JSON.stringify({name:'Test plan',objective:'Diversification',riskTolerance:'MODERATE',horizonMonths:36,budget:10000,maxPositionWeight:0.6,weights:{A:0.5,B:0.5}}));await ui.click('button','保存');
 const accept=ui.find('button','确认保存这个研究组合');assert(accept);assert.equal(accept.disabled,true);assert.equal(ui.service.store.list('portfolio').length,0);
 const checkbox=all(ui.app).find(n=>n.tagName==='input'&&n.attributes.type==='checkbox');checkbox.checked=true;await checkbox.event('change');await accept.click();await ui.settle();assert.equal(ui.service.store.list('portfolio').length,1);assert.equal(ui.service.store.list('tradeIntent').length,0);
});
