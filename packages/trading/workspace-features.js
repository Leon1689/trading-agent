/** Local application features around Pi sessions; no broker execution or public publishing. */
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { requireThat, TradingError } from './errors.js';
import { importFile } from './files.js';
const digest = value => createHash('sha256').update(value).digest('hex');
const safeChat = ({piMessages,events,...chat})=>chat;
export class WorkspaceFeatures {
  constructor(service) { this.service=service;this.store=service.store;this.activeBriefs=new Set(); }
  async execute(operation,args,context){
    const s=this.service;
    switch(operation){
      case 'chat.search':{const result=this.store.searchChats({...args,limit:args.limit??s.config.limits.listLimit});return {...result,items:result.items.map(({messages,piMessages,events,...row})=>({...row,preview:messages.find(m=>m.content?.toLocaleLowerCase().includes((args.query??'').toLocaleLowerCase()))?.content?.slice(0,240)??''}))};}
      case 'chat.trash':case 'chat.restore':{
        const row=this.store.require('chat',args.id);requireThat(row.status!=='RUNNING','CHAT_BUSY','会话正在运行，不能移动。',409);
        return safeChat(this.store.put('chat',row.id,{...row,deleted:operation==='chat.trash',deletedAt:operation==='chat.trash'?new Date(s.now()).toISOString():null},args.revision));
      }
      case 'chat.fork':{
        const row=this.store.require('chat',args.id);requireThat(row.revision===args.revision&&row.status!=='RUNNING'&&!row.deleted,'CHAT_BUSY','会话版本已改变或无法编辑，请刷新。',409);
        requireThat(Number.isInteger(args.messageIndex)&&row.messages[args.messageIndex]?.role==='user'&&typeof args.replacement==='string'&&args.replacement.trim()&&args.replacement.length<=20000,'INVALID_MESSAGE','请选择用户消息并输入替换问题。');
        const targetId=randomUUID(),prior=row.messages.slice(0,args.messageIndex),historyScopes=[...new Set(prior.flatMap(m=>m.allowedScopes??[]).filter(x=>['broker','ledger','files','portfolio','localRead','localWrite','shell','resources'].includes(x)))];
        let nativeFork=null;
        const entryId=row.messages[args.messageIndex].nativeUserEntryId;
        if(entryId&&s.runner?.fork)nativeFork=await s.runner.fork({sourceChatId:row.id,targetChatId:targetId,userEntryId:entryId});
        requireThat(nativeFork||prior.length===0,'PI_FORK_REQUIRED','此消息尚未绑定Pi原生条目，不能安全保留前文；请新建会话或完成原生会话迁移后重试。',409);
        return safeChat(this.store.put('chat',targetId,{title:args.title??`${row.title} · 编辑分支`,pinned:false,archived:false,deleted:false,status:'IDLE',messages:prior,piMessages:[],events:[],historyScopes,draft:args.replacement,forkedFrom:{chatId:row.id,messageIndex:args.messageIndex},nativePi:!!nativeFork},0));
      }
      case 'chat.native':{requireThat(s.runner?.describe,'PI_SESSION_UNAVAILABLE','当前不是Pi原生会话运行器。',409);this.store.require('chat',args.id);return s.runner.describe(args.id);}
      case 'chat.exportNative':{
        requireThat(s.runner?.export,'PI_SESSION_UNAVAILABLE','当前不是Pi原生会话运行器。',409);this.store.require('chat',args.id);
        const exported=await s.runner.export(args.id);const content=typeof exported==='string'?exported:exported?.content;
        requireThat(typeof content==='string','PI_SESSION_UNAVAILABLE','此会话尚无Pi原生记录可导出。',409);
        return importFile(this.store,{name:`pi-${args.id}.jsonl`,mimeType:'application/x-ndjson',content},s.config.limits);
      }
      case 'share.create':{
        requireThat(Number.isInteger(args.expiresInHours)&&args.expiresInHours>=1&&args.expiresInHours<=168,'INVALID_EXPIRY','分享有效期为1到168小时。');
        let title,content;
        if(args.sourceType==='chat'){const row=this.store.require('chat',args.sourceId);requireThat(!row.deleted&&row.status!=='RUNNING','CHAT_BUSY','请等待会话结束。',409);title=row.title;content=row.messages.map(m=>`## ${m.role}\n\n${m.content}`).join('\n\n');}
        else{const row=this.store.require('file',args.sourceId);requireThat(typeof row.content==='string','TEXT_REQUIRED','只能分享文本报告。');title=row.name;content=row.content;}
        requireThat(Buffer.byteLength(content)<=s.config.limits.textFileBytes,'CONTENT_TOO_LARGE','分享内容超过限制。');
        const token=randomBytes(32).toString('base64url'),id=digest(token),expiresAt=new Date(s.now()+args.expiresInHours*3600000).toISOString();
        const row=this.store.put('share',id,{title,content,sourceType:args.sourceType,sourceId:args.sourceId,expiresAt,revoked:false,mode:'LOCAL_LINK_SNAPSHOT'},0);
        return {id:row.id,revision:row.revision,title,expiresAt,urlPath:`/share/${token}`,mode:row.mode,warning:'此链接在本机应用地址可读；未部署公网。取得链接者可读此快照，撤销后失效。'};
      }
      case 'share.list':return this.store.list('share',{limit:s.config.limits.listLimit}).map(({content,...row})=>row);
      case 'share.revoke':{const row=this.store.require('share',args.id);return this.store.put('share',row.id,{...row,revoked:true},args.revision);}
      case 'briefs.create':{
        requireThat(Array.isArray(args.symbols)&&args.symbols.length>0&&args.symbols.length<=8&&args.symbols.every(x=>/^[A-Z0-9.-]{1,24}$/.test(x)),'INVALID_SYMBOLS','简报需1到8个明确标的。');
        requireThat(Number.isSafeInteger(args.intervalMs)&&args.intervalMs>=s.config.scheduler.minIntervalMs,'INVALID_INTERVAL','简报周期低于服务端下限。');
        return this.store.put('brief',randomUUID(),{...args,nextRunAt:s.now(),lastRunAt:null,lastError:null,delivery:'LOCAL_REPORT_AND_INBOX',schedulerRunning:s.config.scheduler.enabled},0);
      }
      case 'briefs.list':return this.store.list('brief',{limit:s.config.limits.listLimit});
      case 'briefs.update':{const row=this.store.require('brief',args.id);return this.store.put('brief',row.id,{...row,enabled:args.enabled,nextRunAt:s.now()},args.revision);}
      case 'briefs.run':return this.runBrief(args.id,context.signal);
      case 'profile.get':return this.store.get('profile','local')??{id:'local',revision:0,displayName:'个人研究者',bio:'',mode:'LOCAL_SINGLE_USER'};
      case 'profile.update':{
        requireThat(args.displayName.trim().length>0&&args.displayName.length<=80&&(args.bio??'').length<=500,'INVALID_PROFILE','名称或说明长度无效。');
        return this.store.put('profile','local',{displayName:args.displayName,bio:args.bio??'',mode:'LOCAL_SINGLE_USER'},args.revision);
      }
      default:throw new TradingError('UNKNOWN_OPERATION','本地工作区操作不存在。',404);
    }
  }
  readShare(token){
    requireThat(typeof token==='string'&&/^[A-Za-z0-9_-]{43}$/.test(token),'NOT_FOUND','分享不存在。',404);
    const row=this.store.get('share',digest(token));requireThat(row&&!row.revoked&&Date.parse(row.expiresAt)>this.service.now(),'NOT_FOUND','分享不存在、已撤销或已过期。',404);
    return {title:row.title,content:row.content,expiresAt:row.expiresAt,mode:row.mode};
  }
  async runBrief(id,signal){
    const s=this.service;requireThat(!this.activeBriefs.has(id),'BRIEF_BUSY','简报正在生成。',409);
    const row=this.store.require('brief',id);this.activeBriefs.add(id);
    try{
      const result=await s.execute('research.brief',{symbols:row.symbols},{actor:'human',signal});signal?.throwIfAborted();
      requireThat(result.results.some(r=>Object.values(r.sections).some(v=>!v.unavailable)),'DATA_UNAVAILABLE','简报未取得任何可用资料。',503);
      const content=`# ${row.name}\n\n生成于 ${new Date(s.now()).toISOString()}。以下是带来源的研究资料，不是交易指令。\n\n${result.results.map(r=>`## ${r.symbol}\n\n\`\`\`json\n${JSON.stringify(r.sections,null,2)}\n\`\`\``).join('\n\n')}`;
      return this.store.transaction(()=>{
        const current=this.store.require('brief',id);requireThat(current.revision===row.revision,'VERSION_CONFLICT','简报配置已改变，本次结果未保存。',409);
        const file=importFile(this.store,{name:`brief-${id}-${s.now()}.md`,content,mimeType:'text/markdown'},s.config.limits);
        const notification=this.store.put('notification',randomUUID(),{title:row.name,briefId:id,fileId:file.id,read:false,delivery:'LOCAL_INBOX',observedAt:new Date(s.now()).toISOString()},0);
        const saved=this.store.put('brief',id,{...current,lastRunAt:new Date(s.now()).toISOString(),nextRunAt:s.now()+row.intervalMs,lastError:null,lastFileId:file.id},current.revision);
        return {brief:saved,fileId:file.id,notification};
      });
    }catch(error){const current=this.store.require('brief',id);if(current.revision===row.revision&&!signal?.aborted)this.store.put('brief',id,{...current,nextRunAt:s.now()+row.intervalMs,lastError:{code:error.code??'BRIEF_FAILED',message:'简报未生成，请核对数据源。'}},current.revision);throw error;}
    finally{this.activeBriefs.delete(id);}
  }
}
