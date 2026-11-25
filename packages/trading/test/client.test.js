import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TradingService } from '../service.js';
import { locales } from '../locales.js';
import { catalog } from '../catalog.js';

/** Exercise the shipped module's event handlers against the real service without a model or browser. */
async function mount(t, { modelEnabled = false } = {}) {
  const dir=mkdtempSync(join(tmpdir(),'trading-client-'));
  const service=new TradingService({path:join(dir,'workbench.sqlite'),config:modelEnabled?{pi:{enabled:true,provider:'test',model:'test',apiKeyEnv:'TEST_MODEL_KEY'}}:{},runner:async()=>({answer:'Synthetic runner response',messages:[],usage:null})});
  t.after(()=>{service.close();rmSync(dir,{recursive:true,force:true})});
  const calls=[],registrations=[],states=new Map(),refs=new Map();let plugin,current='',index=0,refIndex=0,nodes=[];
  const React={Fragment:Symbol('fragment'),createElement:(type,props,...children)=>({type,props:{...props,children}}),useEffect:()=>{},useState:initial=>{const name=current,i=index++;if(!states.has(name))states.set(name,[]);const values=states.get(name);if(!(i in values))values[i]=typeof initial==='function'?initial():initial;return [values[i],next=>{values[i]=typeof next==='function'?next(values[i]):next}]},useRef:initial=>{const name=current,i=refIndex++;if(!refs.has(name))refs.set(name,[]);const values=refs.get(name);if(!(i in values))values[i]={current:initial};return values[i]}};
  const context = {
    window: { __ModuleLoader__: { load: registration => {
      plugin = registration.factory(name => { assert.equal(name, 'react'); return React; });
    } }, confirm: () => true },
    document: { baseURI: 'http://localhost:3091/', createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} } },
    URL, AbortController, AbortSignal, Intl, Date, setTimeout, Blob, console,
    fetch: async (url, options = {}) => {
      const command = options.method === 'POST' ? JSON.parse(options.body) : null;
      calls.push(command || { operation: 'bootstrap' });
      try {
        const data = command ? await service.execute(command.operation, command.args) : { ...service.bootstrap(), locales };
        return { ok: true, status: 200, json: async () => ({ ok: true, data, traceId: 'test-trace' }) };
      } catch (error) {
        return { ok: false, status: error.status || 400, json: async () => ({ ok: false, error: { code: error.code, message: error.message } }) };
      }
    }
  };
  vm.runInNewContext(readFileSync(new URL('../client.js',import.meta.url),'utf8'),context);
  await plugin.apply({effect:fn=>fn(),locale:{register:()=>()=>{},bind:()=>key=>locales.zh[key]},layout:{selectPanel(){}},slots:{inject:(name,fn)=>fn(),register:(descriptor,Component)=>{registrations.push({descriptor,Component});return()=>{}}}});
  const main=registrations.find(x=>x.descriptor.name==='main');
  function renderNode(node){if(node===null||node===undefined||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(renderNode).join('');if(typeof node==='string'||typeof node==='number')return String(node);if(typeof node.type==='function'){const previous=[current,index,refIndex];current=node.type.name+(node.props.key?':'+node.props.key:'');index=refIndex=0;const result=node.type(node.props);[current,index,refIndex]=previous;return renderNode(result)}const text=renderNode(node.props?.children);nodes.push({...node,text});return text}
  const render=()=>{nodes=[];current='Workbench';index=refIndex=0;return renderNode(main.Component(main.descriptor.inject()))};
  const find=(type,text)=>nodes.find(n=>n.type===type&&n.text===text);
  const click=async(type,text)=>{const n=find(type,text);assert(n,`Missing ${type} ${text}`);assert(!n.props.disabled,`Disabled ${text}`);await n.props.onClick();render()};
  const group=async label=>click('button',label);
  render();return{service,calls,registrations,render,find,click,group,nodes:()=>nodes};
}

test('native plugin registers one panel and sidebar, with matching bilingual dictionaries',async t=>{
  const ui=await mount(t);assert.equal(ui.calls.filter(c=>c.operation==='bootstrap').length,1);assert.equal(ui.registrations.length,2);
  assert.deepEqual(Object.keys(locales.zh).sort(),Object.keys(locales.en).sort());assert.deepEqual(Object.keys(locales.zh.fieldLabels).sort(),Object.keys(locales.en.fieldLabels).sort());
  for(const operation of catalog){assert(locales.zh.operationTitles[operation.operation]);assert(locales.en.operationTitles[operation.operation]);for(const field of Object.keys(operation.inputSchema.properties)){assert(locales.zh.fieldLabels[field]);assert(locales.en.fieldLabels[field])}}
  for(const key of ['research','options','portfolios','predict','orders','alerts','files','conversations','settings']){await ui.group(locales.zh[key]);assert(ui.render().includes(locales.zh[key]))}
});

test('unconfigured model and market data remain visibly unavailable',async t=>{
  const ui=await mount(t);assert(ui.render().includes(locales.zh.unavailable));const run=ui.find('button',locales.zh.run);assert(run.props.disabled);
  await ui.group(locales.zh.conversations);assert(ui.render().includes(locales.zh.chatUnconfigured));assert(ui.find('button',locales.zh.send).props.disabled);
  assert.equal(ui.calls.filter(c=>c.operation.startsWith('broker.')).length,0);
});

test('chat sends only default scopes and uses current revision for a rename',async t=>{
  const ui=await mount(t,{modelEnabled:true});await ui.group(locales.zh.conversations);await ui.click('button',locales.zh.newChat);
  const titleInput=ui.nodes().find(n=>n.type==='input'&&n.props['aria-label']===locales.zh.chatTitle);titleInput.props.onChange({target:{value:'Renamed by UI'}});ui.render();
  const renameForm=ui.nodes().find(n=>n.type==='form'&&n.text===locales.zh.rename);await renameForm.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,10));ui.render();
  const update=ui.calls.find(c=>c.operation==='chat.update');assert.equal(update.args.revision,1);assert.equal(update.args.title,'Renamed by UI');
  const textarea=ui.nodes().find(n=>n.type==='textarea');textarea.props.onChange({target:{value:'Calculate with explicit fixture input'}});ui.render();
  const composer=ui.nodes().find(n=>n.type==='form'&&n.props.className==='tw-composer');composer.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,10));ui.render();
  const sent=ui.calls.find(c=>c.operation==='chat.send');assert.deepEqual(sent.args.allowedScopes,['market','compute','predict']);assert.equal(sent.args.message,'Calculate with explicit fixture input');
  assert(ui.render().includes('Synthetic runner response'));assert.equal(ui.calls.filter(c=>c.operation.startsWith('broker.')).length,0);
});

test('read-only preview renders the order but offers no confirmation action',async t=>{
  const ui=await mount(t);await ui.group(locales.zh.orders);const form=ui.nodes().find(n=>n.type==='form');form.props.onSubmit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,10));ui.render();
  assert(ui.calls.some(c=>c.operation==='order.preview'));assert(ui.render().includes(locales.zh.executionDisabled));assert.equal(ui.find('button',locales.zh.confirmOrder),undefined);assert.equal(ui.calls.filter(c=>c.operation==='order.confirm').length,0);
});

test('interrupted chat recovery requires an expired run and sends the displayed revision',async t=>{
  const ui=await mount(t,{modelEnabled:true});await ui.group(locales.zh.conversations);await ui.click('button',locales.zh.newChat);
  const id=ui.calls.find(c=>c.operation==='chat.get').args.id;const initial=ui.service.store.require('chat',id);
  let row=ui.service.store.put('chat',id,{...initial,status:'RUNNING',runId:'test-run',runExpiresAt:Date.now()+60000},initial.revision);
  await ui.nodes().find(n=>n.props?.className==='tw-history-item').props.onClick();ui.render();
  assert(ui.render().includes(locales.zh.chatRunning));assert.equal(ui.find('button',locales.zh.recoverChat),undefined);
  row=ui.service.store.put('chat',id,{...row,runExpiresAt:Date.now()-1},row.revision);
  await ui.click('button',locales.zh.refreshChat);assert(ui.find('button',locales.zh.recoverChat));
  await ui.click('button',locales.zh.recoverChat);const recovery=ui.calls.find(c=>c.operation==='chat.recover');
  assert.equal(recovery.args.revision,row.revision);assert.equal(ui.service.store.require('chat',id).status,'FAILED');
  assert.equal(ui.calls.filter(c=>c.operation==='chat.send').length,0);
});

test('private history scopes stay unchecked and block send until explicitly allowed again',async t=>{
  const ui=await mount(t,{modelEnabled:true});await ui.group(locales.zh.conversations);await ui.click('button',locales.zh.newChat);
  const id=ui.calls.find(c=>c.operation==='chat.get').args.id;
  await ui.service.execute('chat.send',{id,message:'Fixture question with an explicit file scope',allowedScopes:['market','compute','predict','files']});
  await ui.nodes().find(n=>n.props?.className==='tw-history-item').props.onClick();ui.render();
  ui.nodes().find(n=>n.type==='textarea').props.onChange({target:{value:'Next question'}});ui.render();
  assert(ui.render().includes(locales.zh.historyScopeRequired));assert(ui.find('button',locales.zh.send).props.disabled);
  const fileLabel=ui.nodes().find(n=>n.type==='label'&&n.text===locales.zh.filesScope);
  const checkbox=fileLabel.props.children.flat(Infinity).find(n=>n?.type==='input');
  assert.equal(checkbox.props.checked,false);checkbox.props.onChange({target:{checked:true}});ui.render();
  assert.equal(ui.find('button',locales.zh.send).props.disabled,false);
  assert.equal(ui.calls.filter(c=>c.operation==='chat.send').length,0);
});
