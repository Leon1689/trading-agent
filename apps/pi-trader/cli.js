#!/usr/bin/env node
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { migrateLegacy } from './migrate.js';
import { createStandaloneRuntime, FRAMEWORK } from './runtime.js';
import {launchNative} from '../../packages/trading/pi-native-launcher.js';
import { startServer } from './server.js';
import { errorBody, TradingError } from '../../packages/trading/errors.js';
try {
const args=process.argv.slice(2),command=args.shift()??'serve',options={},positionals=[];
let nativeArgs=[];if(command==='native'){const split=args.indexOf('--');if(split>=0)nativeArgs=args.splice(split).slice(1);}
for(let i=0;i<args.length;i++){
 const key=args[i];
 if(['--paper','--no-open'].includes(key))options[key]=true;
 else if(['--home','--port','--scopes','--chat','--from-harness'].includes(key)){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value for ${key}`);options[key]=args[++i];}
 else if(key.startsWith('--'))throw new Error(`Unknown option: ${key}`);else positionals.push(key);
}
const home=resolve(options['--home']??process.env.PI_TRADER_HOME??'.pi-trader');
const config=options['--paper']?{execution:{mode:'LOCAL_PAPER'}}:undefined;
 if(command==='serve'){
  const app=await startServer({home,config,port:Number(options['--port']??3100)});
  console.log(`Pi Trading Agent ${FRAMEWORK.applicationVersion} · Pi SDK ${FRAMEWORK.version}\nLocal data: ${home}\nBroker: ${app.runtime.service.capabilities().brokerAccess} · Execution: ${app.runtime.config.execution.mode}\nOpen: ${app.url}`);
  const stop=async()=>{await app.close();process.exitCode=0;};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 }else if(command==='native'){
  const runtime=await createStandaloneRuntime({home});
  try{const result=await launchNative({runtime,args:nativeArgs,scopes:options['--scopes']?.split(',').filter(Boolean)??['compute','market','predict','resources']});process.exitCode=result.code;}finally{await runtime.close();}
 }else if(command==='init'){
  mkdirSync(home,{recursive:true,mode:0o700});const path=join(home,'config.json');
  if(existsSync(path))throw new TradingError('CONFIG_EXISTS','已有配置不覆盖。');
  const template=JSON.parse(readFileSync(new URL('../../config.example.json',import.meta.url),'utf8'));
  writeFileSync(path,JSON.stringify(template,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(`Created ${path}. Configure only the provider/environment variable names you intend to use.`);
 }else if(command==='migrate'){
  if(!options['--from-harness'])throw new TradingError('SOURCE_REQUIRED','迁移需要显式--from-harness <旧DSH_HOME>。');
  const result=await migrateLegacy({sourceHome:options['--from-harness'],home});
  console.log(JSON.stringify(result,null,2));
 }else if(['run','doctor','tools'].includes(command)){
  const runtime=await createStandaloneRuntime({home,config});
  try{
   if(command==='doctor')console.log(JSON.stringify({runtime:FRAMEWORK,dataDirectory:home,capabilities:runtime.service.capabilities(),operationCount:runtime.service.bootstrap().catalog.length},null,2));
   else if(command==='tools')console.log(JSON.stringify({computer:runtime.service.capabilities().computer,domainOperations:runtime.service.bootstrap().catalog.map(o=>({operation:o.operation,scope:o.scope,model:o.model,kind:o.kind}))},null,2));
   else{
    const prompt=positionals.join(' ').trim();if(!prompt)throw new TradingError('PROMPT_REQUIRED','run需要问题文字。');
    const chat=options['--chat']?await runtime.service.execute('chat.get',{id:options['--chat']}):await runtime.service.execute('chat.create',{title:prompt.slice(0,80)});
    const scopes=options['--scopes']?.split(',').filter(Boolean);
    const result=await runtime.service.execute('chat.send',{id:chat.id,message:prompt,...(scopes?{allowedScopes:scopes}:{})});console.log(result.messages.at(-1)?.content??'');console.log(`\nConversation: ${result.id}`);
   }
  }finally{await runtime.close();}
 }else throw new TradingError('COMMAND_UNKNOWN','命令：serve | init | doctor | tools | run | native | migrate。');
}catch(error){console.error(JSON.stringify(errorBody(error)));process.exitCode=1;}
