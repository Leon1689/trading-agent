/** Official Pi tools, isolated execution, and independent per-turn computer permissions. */
import { createReadTool, createBashTool, createEditTool, createWriteTool, createGrepTool, createFindTool, createLsTool, createPowerShellTool } from '@earendil-works/pi-coding-agent';
import { mkdirSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {homedir}from'node:os';
import { spawn } from 'node:child_process';
export const COMPUTER_SCOPES = ['localRead','localWrite','shell'];
const worker = fileURLToPath(new URL('./computer-worker.js', import.meta.url));
const within=(root,path)=>{const r=relative(root,path);return !r||(!r.startsWith('..'+ '/')&&r!=='..'&&!isAbsolute(r));};
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function computerPolicy(input={}, {workspace,protectedPaths=[],sourceRoot}={}) {
  let root=resolve(input.workspace??workspace??fail('WORKSPACE_REQUIRED','Computer workspace is required'));
  const canonical=p=>{let existing=resolve(p),suffix=[];while(!existsSync(existing)){suffix.unshift(existing.slice(dirname(existing).length+1));existing=dirname(existing);}return join(realpathSync(existing),...suffix);};
  if(existsSync(root)&&lstatSync(root).isSymbolicLink())fail('WORKSPACE_SYMLINK','Workspace itself must not be a symlink');
  root=canonical(root);
  protectedPaths=protectedPaths.map(canonical);
  for(const p of [...protectedPaths,...(sourceRoot?[canonical(sourceRoot)]:[])])if(within(root,p)||within(p,root))fail('PROTECTED_WORKSPACE','Computer workspace must be separate from application data and source');
  mkdirSync(root,{recursive:true,mode:0o700});
  const policy={workspace:root,toolBinDir:resolve(input.toolBinDir??join(homedir(),'.pi/agent/bin')),files:{read:input.files?.read??true,write:input.files?.write??true},shell:{enabled:input.shell?.enabled??true,write:input.shell?.write??true,timeoutMs:input.shell?.timeoutMs??30000},protectedPaths:protectedPaths.map(p=>resolve(p))};
  for(const value of [policy.files.read,policy.files.write,policy.shell.enabled,policy.shell.write])if(typeof value!=='boolean')fail('INVALID_COMPUTER_CONFIG','Computer permission flags must be booleans');
  if(!Number.isSafeInteger(policy.shell.timeoutMs)||policy.shell.timeoutMs<1||policy.shell.timeoutMs>300000)fail('INVALID_COMPUTER_CONFIG','Shell timeout must be 1..300000 ms');
  return policy;
}
export function checkWorkspacePath(root, path, {directory=false}={}) {
  const absolute=resolve(root,path);
  if(!within(root,absolute))fail('PATH_DENIED','Path is outside the configured workspace');
  let cursor=absolute;
  while(within(root,cursor)){
    if(existsSync(cursor)||(()=>{try{lstatSync(cursor);return true;}catch{return false;}})()){
      const stat=lstatSync(cursor);
      if(stat.isSymbolicLink()||(!stat.isDirectory()&&!stat.isFile())||(stat.isFile()&&stat.nlink!==1))fail('PATH_DENIED','Symlinks, hard links and special files are not permitted');
      if(cursor===absolute&&directory&&!stat.isDirectory())fail('PATH_DENIED','Expected a directory');
    }
    if(cursor===root)break;cursor=dirname(cursor);
  }
  return absolute;
}
export function sandboxProfile(policy,writable,temp) {
  const quoted=p=>JSON.stringify(p);
  const moduleRoot=realpathSync(dirname(dirname(dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')))))));
  const readRoots=['/System','/usr','/bin','/sbin','/Library/Apple','/private/var/db/dyld','/opt/homebrew/Cellar','/opt/homebrew/opt',moduleRoot,dirname(realpathSync(process.execPath)),policy.workspace];
  return `(version 1)\n(deny default)\n(allow process-exec)\n(allow process-fork)\n(allow sysctl-read)\n(allow file-read-metadata)\n(allow file-read* (literal "/"))\n(allow file-read* ${readRoots.map(p=>`(subpath ${quoted(p)})`).join(' ')} (literal ${quoted(worker)}) (literal ${quoted(join(dirname(worker),'package.json'))}) (literal ${quoted(resolve(dirname(worker),'../../package.json'))}) (literal ${quoted(join(policy.toolBinDir,'rg'))}) (literal ${quoted(join(policy.toolBinDir,'fd'))}) (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))\n(allow file-write* (subpath ${quoted(temp)}) ${writable?`(subpath ${quoted(policy.workspace)})`:''} (literal "/dev/null"))\n(deny network*)\n${policy.protectedPaths.map(p=>`(deny file-read-data file-write* (subpath ${quoted(p)}))`).join('\n')}`;
}
export function createComputerTools(policy,{scopes=[],signal:parentSignal,names=['read','bash','edit','write']}={}) {
  const factories={read:createReadTool,bash:createBashTool,edit:createEditTool,write:createWriteTool,grep:createGrepTool,find:createFindTool,ls:createLsTool,powershell:createPowerShellTool};
  const definitions=names.map(name=>factories[name](policy.workspace));
  const grants={read:'localRead',write:'localWrite',edit:'localWrite',bash:'shell',powershell:'shell',grep:'localRead',find:'localRead',ls:'localRead'};
  return definitions.map(tool=>({...tool,label:tool.label??tool.name,executionMode:'sequential',description:tool.description+`\nWorkspace: ${policy.workspace}. Requires ${grants[tool.name]} permission. Shell has no network or application credentials.`,execute:async(id,args,signal)=>{
    if(!scopes.includes(grants[tool.name]))fail('COMPUTER_SCOPE_REQUIRED',`This tool requires ${grants[tool.name]}`);
    if(tool.name==='edit'&&!scopes.includes('localRead'))fail('COMPUTER_SCOPE_REQUIRED','edit also requires localRead');
    if((['read','grep','find','ls'].includes(tool.name)&&!policy.files.read)||(['write','edit'].includes(tool.name)&&!policy.files.write)||(tool.name==='edit'&&!policy.files.read)||(['bash','powershell'].includes(tool.name)&&!policy.shell.enabled))fail('COMPUTER_PERMISSION_DENIED','Tool disabled by independent computer policy');
    if(process.platform!=='darwin'||!existsSync('/usr/bin/sandbox-exec'))fail('SANDBOX_UNAVAILABLE','This installation requires macOS sandbox-exec; no unsandboxed fallback');
    const combined=parentSignal?AbortSignal.any([signal??new AbortController().signal,parentSignal]):signal;
    combined?.throwIfAborted();
    if(!['bash','powershell'].includes(tool.name))checkWorkspacePath(policy.workspace,args.path??'.');
    const temp=join(policy.workspace,'.pi-tool-tmp');checkWorkspacePath(policy.workspace,temp,{directory:true});mkdirSync(temp,{recursive:true,mode:0o700});
    const writable=['bash','powershell'].includes(tool.name)?policy.shell.write:['write','edit'].includes(tool.name);
    const timeout=Math.min(policy.shell.timeoutMs,typeof args.timeout==='number'&&args.timeout>0?args.timeout*1000:policy.shell.timeoutMs);
    return await new Promise((resolveResult,reject)=>{
      const child=spawn('/usr/bin/sandbox-exec',['-p',sandboxProfile(policy,writable,temp),realpathSync(process.execPath),worker],{cwd:policy.workspace,env:{PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin',HOME:policy.workspace,TMPDIR:temp,LANG:'en_US.UTF-8',OPENSSL_CONF:'/dev/null',PI_CODING_AGENT_DIR:dirname(policy.toolBinDir),PI_OFFLINE:'1'},stdio:['pipe','pipe','pipe'],detached:true});
      let bytes=0,output='',error='',failure,closed=false;
      const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
      const abort=()=>{failure=Object.assign(new Error('Computer tool cancelled'),{code:'CANCELLED'});kill();};
      const timer=setTimeout(()=>{failure=Object.assign(new Error('Computer tool timed out'),{code:'TIMEOUT'});kill();},timeout);
      combined?.addEventListener('abort',abort,{once:true});if(combined?.aborted)abort();
      child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>4*1024*1024){failure=Object.assign(new Error('Tool output too large'),{code:'OUTPUT_LIMIT'});kill();}else output+=chunk;});
      child.stderr.on('data',chunk=>{if(error.length<4096)error+=chunk;});
      child.on('error',e=>{failure=e;});
      child.on('close',code=>{if(closed)return;closed=true;clearTimeout(timer);combined?.removeEventListener('abort',abort);kill();if(failure){reject(failure);return;}try{const reply=JSON.parse(output);if(reply.error)reject(Object.assign(new Error(reply.error.message),{code:reply.error.code}));else resolveResult(reply.result);}catch{reject(Object.assign(new Error(`Isolated Pi tool failed (${code}); sandbox execution did not produce a result`),{code:'SANDBOX_EXECUTION_FAILED',diagnostic:error}));}});
      child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({name:tool.name,id,args,workspace:policy.workspace}));
    });
  }}));
}
export function computerCapabilities(policy) {return {tools:['read','bash','edit','write'],workspace:policy.workspace,files:policy.files,shell:{...policy.shell,network:false,credentialsInherited:false},scopes:COMPUTER_SCOPES,sandbox:'macOS sandbox-exec',available:process.platform==='darwin'&&existsSync('/usr/bin/sandbox-exec')};}
