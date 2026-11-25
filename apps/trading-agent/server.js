/** Authenticated loopback UI for the Pi SDK application; account data never enters the static cache. */
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewAssignment, LedgerError } from '../../packages/ledger/ledger.js';
import { TradingError, errorBody } from '../../packages/trading/errors.js';
import { locales } from '../../packages/trading/locales.js';
import { createStandaloneRuntime } from './runtime.js';
const root = join(dirname(fileURLToPath(import.meta.url)), 'web');
const assets = new Map([['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/ui-model.js','ui-model.js'],['/copy.js','copy.js'],['/conversations.js','conversations.js'],['/trades.js','trades.js'],['/ledger.js','ledger.js'],['/styles.css','styles.css'],['/manifest.webmanifest','manifest.webmanifest'],['/sw.js','sw.js'],['/icon.svg','icon.svg']]);
const types = { html:'text/html; charset=utf-8',js:'text/javascript; charset=utf-8',css:'text/css; charset=utf-8',webmanifest:'application/manifest+json',svg:'image/svg+xml' };
const equal = (a, b) => { const x=Buffer.from(a ?? ''),y=Buffer.from(b ?? '');return x.length===y.length&&timingSafeEqual(x,y); };
const htmlEscape = s => String(s).replace(/[&<>"']/g, x => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
async function readBody(req, limit) {
  const declared = req.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared)>limit)) throw new TradingError('BODY_TOO_LARGE','请求体超过限制。',413);
  const chunks=[];let size=0;
  for await(const chunk of req.iterator({destroyOnReturn:false})){size+=chunk.length;if(size>limit)throw new TradingError('BODY_TOO_LARGE','请求体超过限制。',413);chunks.push(chunk);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch(error){throw new TradingError('INVALID_JSON','请求JSON无效。');}
}
export async function startServer({ home, config, port=3100, runtime: suppliedRuntime, sessionTtlMs=8*3600000 }={}) {
  if (!Number.isInteger(port)||port<0||port>65535)throw new TradingError('INVALID_PORT','端口无效。');
  const runtime = suppliedRuntime ?? await createStandaloneRuntime({home,config});
  const launchToken=randomBytes(32).toString('base64url'), browserSession=randomBytes(32).toString('base64url');
  const shutdown=new AbortController(),active=new Set();let origin,authority,timer,tick,closing=false;
  let authenticatedUntil=0;
  const send=(res,status,value,headers={})=>{res.writeHead(status,{'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer',...headers});res.end(value);};
  const json=(res,status,value)=>send(res,status,JSON.stringify(value),{'content-type':'application/json; charset=utf-8'});
  const server=createServer((req,res)=>{
    const traceId=randomUUID(),controller=new AbortController();
    req.on('aborted',()=>controller.abort());res.on('close',()=>{if(!res.writableEnded)controller.abort();});
    const pending=(async()=>{
      try{
        if(closing)throw new TradingError('CLOSING','服务正在关闭。',503);
        if(req.headers.host!==authority)throw new TradingError('HOST_DENIED','访问地址不匹配。',403);
        const requestOrigin=req.headers.origin;
        if(requestOrigin && requestOrigin!==origin)throw new TradingError('ORIGIN_DENIED','拒绝跨站请求。',403);
        const url=new URL(req.url,origin);
        if(url.pathname==='/auth'&&req.method==='GET'){
          if(!equal(url.searchParams.get('token'),launchToken))throw new TradingError('AUTH_REQUIRED','认证链接无效；使用本次启动输出的链接。',401);
          authenticatedUntil=Date.now()+sessionTtlMs;
          send(res,303,'',{'location':'/','set-cookie':`pi_trader_session=${browserSession}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(sessionTtlMs/1000)}`});return;
        }
        if(url.pathname.startsWith('/share/')&&req.method==='GET'){
          const value=runtime.service.readShare(url.pathname.slice(7));
          send(res,200,`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${htmlEscape(value.title)}</title><body><h1>${htmlEscape(value.title)}</h1><p>trading agent · 本机分享快照 · ${htmlEscape(value.expiresAt)}</p><pre style="white-space:pre-wrap">${htmlEscape(value.content)}</pre></body></html>`,{'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'"});return;
        }
        const cookie=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('pi_trader_session='))?.slice(18);
        if(!equal(cookie,browserSession)||Date.now()>=authenticatedUntil)throw new TradingError('AUTH_REQUIRED','请使用trading agent启动时显示的本机认证链接。',401);
        if(req.method==='POST'){
          if(req.headers['x-pi-trader']!=='1'||!String(req.headers['content-type']).startsWith('application/json'))throw new TradingError('REQUEST_DENIED','请求需要JSON和应用校验头。',403);
        }
        if(url.pathname==='/api/bootstrap'&&req.method==='GET'){
          json(res,200,{ok:true,data:{...runtime.service.bootstrap(),locales,runtime:runtime.framework},traceId});return;
        }
        if(url.pathname==='/api/operations'&&req.method==='POST'){
          const body=await readBody(req,runtime.config.limits.requestBytes);
          if(!body||typeof body.operation!=='string'||Object.keys(body).some(k=>!['operation','args'].includes(k)))throw new TradingError('INVALID_REQUEST','请求仅接受operation和args。');
          const data=await runtime.service.execute(body.operation,body.args??{},{actor:'human',signal:AbortSignal.any([controller.signal,shutdown.signal]),traceId});
          json(res,200,{ok:true,data,traceId});return;
        }
        if(url.pathname==='/api/ledger'&&['GET','POST'].includes(req.method)){
          try{
            let value;
            if(req.method==='GET')value=runtime.ledger.view();
            else{
              const command=await readBody(req,runtime.config.limits.requestBytes);
              if(command.action==='previewAssignment'){
                const state=runtime.ledger.read();if(command.revision!==state.revision)throw new LedgerError('账本已更新，请重新核对。',409);
                value=previewAssignment(state,command.data);
              }else value=runtime.ledger.change(command,controller.signal);
            }
            json(res,200,value);
          }catch(error){json(res,error.status??400,{error:error instanceof LedgerError?error.message:'账本请求未完成，请核对输入。'});}
          return;
        }
        if(url.pathname==='/api/logout'&&req.method==='POST'){
          authenticatedUntil=0;send(res,200,JSON.stringify({ok:true}),{'content-type':'application/json','set-cookie':'pi_trader_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});return;
        }
        if(req.method==='GET'&&assets.has(url.pathname)){
          const path=assets.get(url.pathname),content=await readFile(join(root,path));
          send(res,200,content,{'content-type':types[path.split('.').at(-1)]??'application/octet-stream','content-security-policy':"default-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'"});return;
        }
        throw new TradingError('NOT_FOUND','路径或方法不受支持。',404);
      }catch(error){if(!res.headersSent)json(res,error.status??500,{ok:false,error:errorBody(error),traceId});else res.destroy();}
    })();
    active.add(pending);pending.finally(()=>active.delete(pending));
  });
  server.requestTimeout=30000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});}
  catch(error){await runtime.close();throw error;}
  authority=`127.0.0.1:${server.address().port}`;origin=`http://${authority}`;
  const schedule=()=>{if(closing)return;timer=setTimeout(()=>{tick=runtime.service.tick(shutdown.signal).catch(error=>{if(!closing)runtime.service.store.append({operation:'scheduler.tick',status:'ERROR',error:errorBody(error)});}).finally(schedule);},runtime.config.scheduler.pollMs);timer.unref?.();};
  if(runtime.config.scheduler.enabled)schedule();
  return {origin,url:`${origin}/auth?token=${launchToken}`,runtime,server,close:async()=>{if(closing)return;closing=true;shutdown.abort();clearTimeout(timer);const closed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections();await Promise.allSettled([...active,...(tick?[tick]:[])]);await closed;await runtime.close();}};
}
