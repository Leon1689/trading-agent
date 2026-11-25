/** A one-request subprocess: official Pi tool implementation, no host credentials. */
import {createReadTool,createBashTool,createEditTool,createWriteTool,createGrepTool,createFindTool,createLsTool,createPowerShellTool}from'@earendil-works/pi-coding-agent';
import{spawn}from'node:child_process';
import{resolve,relative,isAbsolute}from'node:path';import{lstatSync}from'node:fs';
// Keep worker independent of application/service imports. Kernel sandbox is set by the parent.
let input='';for await(const chunk of process.stdin){input+=chunk;if(Buffer.byteLength(input)>4*1024*1024)throw Error('Input too large');}
try{
 const {name,id,args,workspace}=JSON.parse(input);
 if(!['bash','powershell'].includes(name)){
  const path=resolve(workspace,args.path??'.'),rel=relative(workspace,path);if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))throw Error('Path outside workspace');
  let part=workspace;for(const segment of rel.split('/').filter(Boolean)){part=resolve(part,segment);let stat;try{stat=lstatSync(part);}catch(e){if(e.code==='ENOENT')continue;throw e;}if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory())||(stat.isFile()&&stat.nlink!==1))throw Error('Symlinks, hard links and special files denied');}
 }
 const factories={read:createReadTool,bash:createBashTool,edit:createEditTool,write:createWriteTool,grep:createGrepTool,find:createFindTool,ls:createLsTool,powershell:createPowerShellTool};if(!factories[name])throw Error('Unknown tool');
 const tool=factories[name](workspace,name==='bash'?{exposeSessionEnvironment:false,operations:{exec:(command,cwd,{onData,signal})=>new Promise((res,rej)=>{const child=spawn('/bin/bash',['--noprofile','--norc','-c',command],{cwd,env:process.env,detached:false,stdio:['ignore','pipe','pipe']});child.stdout.on('data',onData);child.stderr.on('data',onData);child.on('error',rej);child.on('close',(exitCode)=>res({exitCode}));signal?.addEventListener('abort',()=>child.kill('SIGKILL'),{once:true});})}}:undefined);
 const result=await tool.execute(id,args,new AbortController().signal);process.stdout.write(JSON.stringify({result}));
}catch(error){process.stdout.write(JSON.stringify({error:{code:'COMPUTER_TOOL_FAILED',message:String(error.message).slice(0,2000)}}));}
