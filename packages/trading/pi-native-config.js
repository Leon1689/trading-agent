/** Native Pi settings and resource routing. Keep the pinned upstream schema authoritative. */
import {readFileSync, realpathSync, existsSync} from 'node:fs';
import {dirname, join, resolve, relative, isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SettingsManager, DefaultResourceLoader} from '@earendil-works/pi-coding-agent';
import {Value} from 'typebox/value';
export const PI_PACKAGE_ROOT=dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))));
export const PI_SETTINGS_SCHEMA=JSON.parse(readFileSync(join(PI_PACKAGE_ROOT,'schemas/settings.schema.json'),'utf8'));
export const NATIVE_CAPABILITIES=[
 ['agent','Agent循环、事件、工具执行','SDK / native'],['sessions','原生JSONL、继续、分支、树、标签','SDK / native'],['compaction','自动/手动压缩、分支摘要','SDK / native'],['retry','自动重试、供应商重试、退避','SDK / native'],['thinking','思考档位与模型思考预算','SDK / native'],['resources','AGENTS、SYSTEM、APPEND_SYSTEM、Skills、提示模板','SDK / native'],['themes','主题、键位、终端图像与编辑器','native'],['extensions','扩展、命令、事件、自定义UI、工具/模型注册','native'],['packages','npm/git/local Pi包、安装、更新、移除','native'],['mcp','stdio/HTTP MCP、资源、认证、工具暴露','native'],['codemode','codemode、tool_search、动态工具','native'],['builtinTools','read/bash/edit/write/grep/find/ls/powershell','SDK / native'],['models','供应商、自定义models、模型切换/路由','native; SDK显式模型'],['auth','API key、OAuth、登录/登出','native'],['queues','steering、follow-up、队列/中断','native'],['cli','TUI、print、JSON、RPC、CLI参数','native'],['exports','会话导出HTML/JSONL、分享','native; SDK JSONL'],['cache','cache warming、transport、缓存设置','SDK / native'],['settings','官方设置schema、全局/项目设置、项目信任','SDK / native'],['platform','终端/平台支持与环境变量','官方能力保留；交易隔离后端当前macOS']
].map(([id,title,entry])=>({id,title,entry,retained:true}));
const error=(message)=>Object.assign(new Error(message),{code:'PI_NATIVE_CONFIG_ERROR'});
export function resolvePiNative(input={}) {
 const out={agentDir:null,settingsSource:'memory',settings:{},resources:{enabled:true,contextFiles:true,skills:true,prompts:true,themes:true,extensions:true,mcp:true,skillPaths:[],promptPaths:[],themePaths:[],extensionPaths:[]},tools:['read','bash','edit','write'],expandPromptTemplates:true,environment:{},permissions:{readPaths:[],writePaths:[],network:[],loopbackListenPorts:[],processExecution:false,clipboard:false},...input};
 out.resources={...resolveResourcesDefaults(),...input.resources};out.permissions={readPaths:[],writePaths:[],network:[],loopbackListenPorts:[],processExecution:false,clipboard:false,...input.permissions};
 if(!['memory','files'].includes(out.settingsSource))throw error('settingsSource must be memory or files');
 if(out.agentDir!==null&&(typeof out.agentDir!=='string'||!isAbsolute(out.agentDir)))throw error('agentDir must be an explicit absolute path');
 if(!out.settings||typeof out.settings!=='object'||Array.isArray(out.settings))throw error('settings must be an object');
 const unknown=Object.keys(out.settings).filter(k=>!Object.hasOwn(PI_SETTINGS_SCHEMA.properties,k));
 if(unknown.length||!Value.Check(PI_SETTINGS_SCHEMA,out.settings))throw error('Invalid upstream Pi settings: '+unknown.join(', '));
 for(const key of ['enabled','contextFiles','skills','prompts','themes','extensions','mcp'])if(typeof out.resources[key]!=='boolean')throw error('Resource switches must be booleans');
 for(const key of ['skillPaths','promptPaths','themePaths','extensionPaths'])if(!Array.isArray(out.resources[key])||out.resources[key].some(p=>typeof p!=='string'||!isAbsolute(p)))throw error(key+' must contain absolute paths');
 for(const key of ['readPaths','writePaths'])if(!Array.isArray(out.permissions[key])||out.permissions[key].some(p=>typeof p!=='string'||!isAbsolute(p)))throw error(key+' must contain absolute paths');
 if(!out.environment||typeof out.environment!=='object'||Array.isArray(out.environment)||Object.entries(out.environment).some(([key,value])=>!/^PI_[A-Z0-9_]+$/.test(key)||['PI_CODING_AGENT_DIR','PI_CODING_AGENT_SESSION_DIR','PI_PACKAGE_DIR'].includes(key)||typeof value!=='string'))throw error('environment accepts Pi-specific string flags; resource directories use explicit path configuration');
 if(typeof out.permissions.clipboard!=='boolean'||typeof out.permissions.processExecution!=='boolean'||typeof out.expandPromptTemplates!=='boolean')throw error('Native permission flags must be booleans');
 if(!Array.isArray(out.permissions.network)||out.permissions.network.some(v=>typeof v!=='string'||!/^([a-zA-Z0-9.-]+):([1-9][0-9]{0,4})$/.test(v)||Number(v.split(':').at(-1))>65535))throw error('network requires explicit host:port destinations');
 if(!Array.isArray(out.permissions.loopbackListenPorts)||out.permissions.loopbackListenPorts.some(p=>!Number.isInteger(p)||p<1024||p>65535))throw error('loopbackListenPorts requires explicit unprivileged TCP ports');
 if(!Array.isArray(out.tools)||out.tools.some(v=>!['read','bash','edit','write','grep','find','ls','powershell'].includes(v)))throw error('tools must name official builtins');
 return out;
}
function resolveResourcesDefaults(){return{enabled:true,contextFiles:true,skills:true,prompts:true,themes:true,extensions:true,mcp:true,skillPaths:[],promptPaths:[],themePaths:[],extensionPaths:[]};}
export function piSettings(native,{cwd,agentDir,provider,model}={}) {
 const manager=native.settingsSource==='files'?SettingsManager.create(cwd,agentDir):SettingsManager.inMemory();
 manager.applyOverrides({...native.settings,...(provider?{defaultProvider:provider,defaultModel:model}:{})});
 return manager;
}
export async function textResources(native,{cwd,agentDir,settingsManager,policy}) {
 // Executable resources use the isolated official CLI entry; never evaluate them beside broker credentials.
 const settings=SettingsManager.inMemory({...settingsManager.getSettings(),packages:[],extensions:[],defaultProjectTrust:'never'});
 const root=realpathSync(cwd),agent=realpathSync(agentDir);
 const allowed=p=>{const path=existsSync(p)?realpathSync(p):resolve(p);return[root,agent,...native.permissions.readPaths.map(p=>realpathSync(p))].some(base=>{const r=relative(base,path);return !r||(!r.startsWith('../')&&r!=='..'&&!isAbsolute(r));});};
 for(const p of [...native.resources.skillPaths,...native.resources.promptPaths,...native.resources.themePaths])if(!allowed(p))throw error('Resource path requires permissions.readPaths: '+p);
 const r=native.resources,enabled=r.enabled;
 const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:true,noSkills:!enabled||!r.skills,noPromptTemplates:!enabled||!r.prompts,noThemes:!enabled||!r.themes,noContextFiles:!enabled||!r.contextFiles,additionalSkillPaths:enabled&&r.skills?r.skillPaths:[],additionalPromptTemplatePaths:enabled&&r.prompts?r.promptPaths:[],additionalThemePaths:enabled&&r.themes?r.themePaths:[],skillsOverride:base=>({...base,skills:base.skills.filter(s=>allowed(s.filePath))}),promptsOverride:base=>({...base,prompts:base.prompts.filter(p=>allowed(p.filePath))}),agentsFilesOverride:base=>({agentsFiles:base.agentsFiles.filter(f=>allowed(f.path))}),appendSystemPromptOverride:base=>[...base,policy]});
 await loader.reload();
 return loader;
}
export function nativeCapabilities(native,manager){const settings=manager??SettingsManager.inMemory(native.settings);return{effectiveSource:manager?'loaded-settings':native.settingsSource==='files'?'configured-overrides; file settings resolved at session start':'memory-settings',effective:{autoCompaction:settings.getCompactionEnabled(),autoRetry:settings.getRetryEnabled(),thinking:settings.getDefaultThinkingLevel()??'medium',cacheWarming:settings.getCacheWarmingMode(),promptTemplates:native.expandPromptTemplates},upstreamVersion:'1.6.0',settingsKeys:Object.keys(PI_SETTINGS_SCHEMA.properties),settings:native.settings,resources:native.resources,settingsSource:native.settingsSource,tools:native.tools,capabilities:NATIVE_CAPABILITIES,completeEntry:'npm run native -- --home <app-home> -- <official Pi arguments>',webExecutableResources:'Use isolated native entry; not loaded inside broker host',network:native.permissions.network};}
