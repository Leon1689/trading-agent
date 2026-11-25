/** Official CLI extension: only IPC crosses into the application; no credentials or database handles. */
import {randomUUID} from 'node:crypto';
export default async function bridge(pi) {
 if(!process.send)throw Error('Launch this extension through the trading native entry');
 const pending=new Map();let initialize;
 const initialized=new Promise(resolve=>{initialize=resolve;});
 const receive=message=>{if(message?.bridge!=='pi-trading-v1')return;if(message.type==='init'){initialize(message);return;}const item=pending.get(message.id);if(item){pending.delete(message.id);item.resolve(message.result);}};
 process.on('message',receive);process.send({bridge:'pi-trading-v1',type:'ready'});
 const {tools,scopes,policy,modelAuth}=await initialized;
 if(modelAuth?.provider&&modelAuth.apiKeyEnv&&process.env[modelAuth.apiKeyEnv])pi.registerProvider(modelAuth.provider,{apiKey:'$'+modelAuth.apiKeyEnv});
 for(const tool of tools)pi.registerTool({...tool,...(['grep','find','ls','powershell'].includes(tool.name)?{defaultActive:false}:{}),executionMode:'sequential',execute:async(_id,args,signal)=>{const id=randomUUID();return await new Promise(resolve=>{const abort=()=>{process.send?.({bridge:'pi-trading-v1',type:'cancel',id});pending.delete(id);resolve({content:[{type:'text',text:'Cancelled'}],isError:true});};pending.set(id,{resolve:result=>{signal?.removeEventListener('abort',abort);resolve(result);}});signal?.addEventListener('abort',abort,{once:true});process.send({bridge:'pi-trading-v1',type:'tool',id,name:tool.name,args});if(signal?.aborted)abort();});}});
 const required=ctx=>[...new Set(ctx.sessionManager.getBranch().filter(e=>e.type==='custom'&&e.customType==='trading.scope.v1').flatMap(e=>e.data?.privateScopes??[]))];
 pi.on('input',(_event,ctx)=>{const missing=required(ctx).filter(s=>!scopes.includes(s));if(missing.length){ctx.ui.notify('Restore historical scopes or open a new session: '+missing.join(', '),'error');return{action:'handled'};}pi.appendEntry('trading.scope.v1',{privateScopes:[...new Set([...required(ctx),...scopes.filter(s=>!['compute','market','predict'].includes(s))])]});return{action:'continue'};});
 pi.on('before_agent_start',event=>{process.send?.({bridge:'pi-trading-v1',type:'turn'});return{systemPrompt:event.systemPrompt+'\n\n'+policy};});
 pi.on('session_shutdown',()=>{process.removeListener('message',receive);for(const {resolve}of pending.values())resolve({content:[{type:'text',text:'Session closed'}],isError:true});pending.clear();});
 // Never replace the CLI active-tool list: its builtins, MCP and user extensions remain available.
}
