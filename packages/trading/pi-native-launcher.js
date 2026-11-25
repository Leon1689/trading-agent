/** Run the unmodified official Pi CLI with an isolated resource home and a capability-only trading bridge. */
import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,existsSync,realpathSync,lstatSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {lookup} from 'node:dns/promises';
import {PI_PACKAGE_ROOT,resolvePiNative} from './pi-native-config.js';
import {createComputerTools} from './computer-tools.js';
import {createNativeNetworkProxy}from'./pi-network-proxy.js';
import {TRADING_SYSTEM_POLICY} from './pi-session-runtime.js';
const bridge=fileURLToPath(new URL('./pi-native-bridge.js',import.meta.url));
const inside=(base,path)=>{const r=relative(base,path);return!r||(!r.startsWith('../')&&r!=='..'&&!isAbsolute(r));};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
function pathAllowed(path,protectedPaths){const real=realpathSync(path);for(const p of protectedPaths)if(inside(real,p)||inside(p,real))fail('NATIVE_PATH_DENIED','Native resource paths must not overlap application data/source');return real;}
export async function prepareNativeLaunch({home,computer,config,args=[],scopes=['compute','market','predict'],env=process.env,proxy}) {
 if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec'))fail('SANDBOX_UNAVAILABLE','Native trading launcher requires the macOS sandbox; official Pi remains installed');
 const native=resolvePiNative(config.pi?.native),source=resolve(dirname(bridge),'../..'),protectedPaths=[realpathSync(home),source];
 const agentDir=native.agentDir??home+'-pi';mkdirSync(agentDir,{recursive:true,mode:0o700});const resources=pathAllowed(agentDir,protectedPaths);
 const readPaths=[...native.permissions.readPaths,...native.resources.skillPaths,...native.resources.promptPaths,...native.resources.themePaths,...native.resources.extensionPaths].map(p=>pathAllowed(p,protectedPaths));
 const writePaths=native.permissions.writePaths.map(p=>pathAllowed(p,protectedPaths));
 const workspace=computer.workspace;if(!scopes.includes('resources')&&native.resources.enabled)fail('RESOURCES_SCOPE_REQUIRED','The native entry discovers resources; grant resources explicitly or disable discovery');
 const q=p=>JSON.stringify(p),moduleRoot=resolve(PI_PACKAGE_ROOT,'../..');
 const read=[...(scopes.includes('localRead')?[workspace]:[join(workspace,'.pi')]),resources,...readPaths,'/System','/usr','/bin','/sbin','/Library/Apple','/private/var/db/dyld','/opt/homebrew/Cellar','/opt/homebrew/opt',moduleRoot,dirname(realpathSync(process.execPath))];
 const canWrite=(scopes.includes('localWrite')&&computer.files.write)||(scopes.includes('shell')&&computer.shell.enabled&&computer.shell.write);
 const write=[resources,...(canWrite?[...writePaths,workspace]:[])];
 const destinations=[],brokerTargets=[];
 const brokerURLs=[config.providers?.ibkr?.baseUrl,config.execution?.ibkr?.baseUrl].filter(Boolean);for(const brokerURL of brokerURLs){const u=new URL(brokerURL);for(const a of await lookup(u.hostname,{all:true,family:4}))brokerTargets.push(`${a.address}:${u.port|| (u.protocol==='https:'?443:80)}`);}
 for(const dest of native.permissions.network){const[host,port]=dest.split(':');const addresses=await lookup(host,{all:true,family:4});for(const{address}of addresses){const target=`${address}:${port}`;if(brokerTargets.includes(target)||(address.startsWith('127.')&&['5000','5001','4001','4002','7496','7497'].includes(port)))fail('NATIVE_NETWORK_DENIED','Broker gateway endpoints cannot be granted to native extensions');destinations.push({host,port:Number(port),address});}}
 // Broker credentials and parent HTTP auth are never in this process. Broker and all human operations exist only behind the IPC allowlist.
 const processExec=native.permissions.processExecution&&scopes.includes('shell');
 const profile=`(version 1)\n(deny default)\n(allow process-exec)\n${processExec?'(allow process-fork)':''}\n(allow sysctl-read)\n(allow file-ioctl)\n${native.permissions.clipboard?'(allow mach-lookup (global-name "com.apple.pasteboard.1"))':''}\n(allow file-read-metadata)\n(allow file-read* (literal "/") (literal ${q(workspace)}) (literal ${q(join(workspace,'AGENTS.md'))}) (literal ${q(join(workspace,'SYSTEM.md'))}) (literal ${q(join(workspace,'APPEND_SYSTEM.md'))}) ${read.map(p=>`(subpath ${q(p)})`).join(' ')} (literal ${q(bridge)}) (literal ${q(join(dirname(bridge),'package.json'))}) (literal ${q(join(source,'package.json'))}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/tty"))\n(allow file-write* ${write.map(p=>`(subpath ${q(p)})`).join(' ')} (literal "/dev/null") (literal "/dev/tty"))\n(deny network*)\n${native.permissions.loopbackListenPorts.map(port=>`(allow network-bind network-inbound (local tcp ${q('localhost:'+port)}))`).join('\n')}\n${destinations.length?'(allow network-outbound '+`(remote tcp ${q('localhost:'+(proxy?.port??1))})`+')':''}`;
 const settingsPath=join(resources,'settings.json');let stored={};if(existsSync(settingsPath)){if(!lstatSync(settingsPath).isFile()||lstatSync(settingsPath).isSymbolicLink())fail('NATIVE_PATH_DENIED','settings.json must be a regular file');stored=JSON.parse(readFileSync(settingsPath,'utf8'));}
 const settings={...stored,...native.settings,...(config.pi?.provider?{defaultProvider:config.pi.provider,defaultModel:config.pi.model}:{})};
 if(Object.keys(native.settings).length||!existsSync(settingsPath))writeFileSync(settingsPath,JSON.stringify(settings,null,2)+'\n',{mode:0o600});
 const r=native.resources,cliArgs=[];
 if(!r.enabled||!r.extensions)cliArgs.push('--no-extensions');if(!r.enabled||!r.skills)cliArgs.push('--no-skills');if(!r.enabled||!r.prompts)cliArgs.push('--no-prompt-templates');if(!r.enabled||!r.themes)cliArgs.push('--no-themes');if(!r.enabled||!r.contextFiles)cliArgs.push('--no-context-files');if(!r.enabled||!r.mcp)cliArgs.push('--no-mcp');
 for(const [key,flag,category]of[['skillPaths','--skill','skills'],['promptPaths','--prompt-template','prompts'],['themePaths','--theme','themes'],['extensionPaths','--extension','extensions']])if(r.enabled&&r[category])for(const path of r[key])cliArgs.push(flag,path);
 const childEnv={...native.environment,HOME:resources,PI_CODING_AGENT_DIR:resources,PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',TMPDIR:resources,LANG:env.LANG??'en_US.UTF-8',TERM:env.TERM??'xterm-256color',OPENSSL_CONF:'/dev/null',...(destinations.length?{NODE_USE_ENV_PROXY:'1',HTTP_PROXY:proxy?.url??'',HTTPS_PROXY:proxy?.url??'',http_proxy:proxy?.url??'',https_proxy:proxy?.url??'',NO_PROXY:'',no_proxy:''}:{PI_OFFLINE:'1'})};
 // Model auth is configured in the native Pi home (/login). An explicit model key variable may be forwarded; never copy the application's environment.
 if(config.pi?.apiKeyEnv&&env[config.pi.apiKeyEnv])childEnv[config.pi.apiKeyEnv]=env[config.pi.apiKeyEnv];
 return{command:'/usr/bin/sandbox-exec',args:['-p',profile,realpathSync(process.execPath),join(PI_PACKAGE_ROOT,'dist/bundle/cli.js'),'--extension',bridge,...cliArgs,...args],options:{cwd:workspace,env:childEnv,detached:true},nativeHome:resources,profile,scopes,networkTargets:destinations};
}
export async function launchNative({runtime,args=[],scopes=['compute','market','predict'],stdio='inherit',env=process.env,onChild}={}) {
 const controller=new AbortController(),computer=runtime.computer;
 let plan=await prepareNativeLaunch({home:runtime.home,computer,config:runtime.config,args,scopes,env});
 const proxy=plan.networkTargets.length?await createNativeNetworkProxy(plan.networkTargets):null;
 if(proxy)try{plan=await prepareNativeLaunch({home:runtime.home,computer,config:runtime.config,args,scopes,env,proxy});}catch(error){await proxy.close();throw error;}
 const tools=[...createComputerTools(computer,{scopes,names:['read','bash','edit','write','grep','find','ls','powershell'],signal:controller.signal}),...runtime.service.modelTools(scopes,controller.signal)];
 const byName=new Map(tools.map(t=>[t.name,t])),running=new Map();let calls=0;
 const child=spawn(plan.command,plan.args,{...plan.options,stdio:[stdio,stdio,stdio,'ipc']});
 const stop=()=>{controller.abort();try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
 const send=payload=>{if(child.connected)child.send({bridge:'pi-trading-v1',...payload},()=>{});};
 child.on('message',async m=>{if(m?.bridge!=='pi-trading-v1')return;if(m.type==='ready'){send({type:'init',tools:tools.map(({execute,...t})=>t),scopes,policy:TRADING_SYSTEM_POLICY,modelAuth:runtime.config.pi.apiKeyEnv?{provider:runtime.config.pi.provider,apiKeyEnv:runtime.config.pi.apiKeyEnv}:null});return;}if(m.type==='turn'){calls=0;return;}if(m.type==='cancel'){running.get(m.id)?.abort();return;}if(m.type!=='tool')return;
  const bounded=typeof m.id==='string'&&m.id.length<=100&&Buffer.byteLength(JSON.stringify(m))<=4*1024*1024,tool=bounded?byName.get(m.name):null;
  const signal=new AbortController();running.set(m.id,signal);
  try{if(!tool||++calls>runtime.config.pi.maxToolCalls)fail('CAPABILITY_DENIED','Unknown tool or budget exceeded');const result=await tool.execute(m.id,m.args,AbortSignal.any([controller.signal,signal.signal]));send({type:'result',id:m.id,result});}
  catch(error){send({type:'result',id:m.id,result:{content:[{type:'text',text:`Tool failed (${/^[A-Z_]+$/.test(error.code)?error.code:'TOOL_FAILED'})`}],isError:true}});}
  finally{running.delete(m.id);}
 });
 const signals=['SIGINT','SIGTERM'];for(const s of signals)process.once(s,stop);
 const completed=new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('close',async(code,signal)=>{stop();await proxy?.close();for(const s of signals)process.removeListener(s,stop);resolveExit({code:code??1,signal,nativeHome:plan.nativeHome});});});
 try{await onChild?.(child,plan);return await completed;}catch(error){stop();await proxy?.close();for(const s of signals)process.removeListener(s,stop);throw error;}
}
