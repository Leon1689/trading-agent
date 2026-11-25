/** Broker confirmation cards. Tokens stay in this closure and never enter Pi history. */
export async function renderTradeCards(host,ui,{chatId}={}){
 const {S,el,button,op,replace,notice,raw}=ui;
 const box=el('section',{class:'card trade-orders'});host.append(box);
 const states={NEEDS_INPUT:'待补全需求',READY:'待券商预览',PREVIEWED:'待你核对',SUBMITTING:'正在发送 · 不可重复提交',UNKNOWN:'结果未知 · 先查单',AWAITING_BROKER_REPLY:'IBKR警告 · 待你再次确认',ACKNOWLEDGED:'已取得券商回执',CANCEL_PENDING:'撤单请求已发送 · 等待券商状态',REJECTED:'券商拒绝',DECLINED:'你已拒绝券商警告',DISCARDED:'已放弃草稿'};
 let reviewActive=false, activeActions=0;
 const enabled=S.boot.capabilities.conversationalTrading?.brokerPaper===true;
 async function refresh(){
  reviewActive=false;
  const rows=await op('trade.list',chatId?{chatId}:{});if(!box.isConnected)return;
  const watches=await op('trade.monitorStatus');if(!box.isConnected)return;
  replace(box,el('div',{class:'row'},el('h2',{},'对话交易 · IBKR模拟账户'),button('刷新交易卡',refresh,{class:'btn small'})),notice('模型只提取需求和准备订单。核对卡中的账户、合约、方向、数量与限价后，由你点击最终确认。'));
  if(!enabled)box.append(notice('IBKR模拟执行尚未配置；可保存需求，不会发往券商。'));
  if(!rows.length)box.append(el('p',{class:'help'},'暂无交易需求。在对话中选择“交易需求与订单”，说明你要交易什么。'));
  for(const row of rows){
   const card=el('article',{class:'trade-card'}),f=row.fields,details=el('dl',{class:'trade-details'});
   for(const[label,value]of [['账户',f.accountId],['标的 / 合约',`${f.symbol??'待定'} / ${f.conid??'待查询'}`],['资产 / 买卖 / 开平',`${f.assetClass??'待定'} · ${f.side??'待定'} · ${f.positionEffect??'待定'}`],['数量',f.quantity],['限价 / 币种',`${f.limitPrice??'待定'} ${f.currency??''}`],['订单 / 有效期 / 时段',`${f.type??'待定'} · ${f.timeInForce??'待定'} · ${f.session??'待定'}`],...(f.assetClass==='OPTION'?[['期权',`${f.expiration??'待定'} · ${f.right??'待定'} · 行权价 ${f.strike??'待定'} · 乘数 ${f.multiplier??'待定'}`]]:[])])details.append(el('dt',{},label),el('dd',{},String(value??'待定')));
   card.append(el('h3',{},states[row.status]??row.status),details);
   if(row.missing?.length)card.append(el('ul',{},row.missing.map(x=>el('li',{},x.question))));
   if(row.preview){const amount=row.preview.whatIf?.amount;card.append(el('p',{},`券商预估金额：${amount?.amount??'未知'} · 佣金：${amount?.commission??'未知'} · 合计：${amount?.total??'未知'}`));if(row.preview.whatIf?.warn)card.append(notice(row.preview.whatIf.warn,'warn'));}
   if(row.preview)card.append(raw({instrument:row.preview.instrument,quote:row.preview.quote,whatIf:row.preview.whatIf,receivedAt:row.preview.receivedAt,expiresAt:row.expiresAt}));
   if(row.warnings?.length)card.append(notice(row.warnings.join('\n'),'warn'));
   if(row.receipt)card.append(el('p',{},`券商订单：${row.brokerOrderId??'待定'} · 状态：${row.receipt.status??row.status}`),raw(row.receipt));
   const watch=watches.find(item=>item.id===row.id)??{id:row.id,revision:0,enabled:false};
   const terminal=row.receipt?.snapshot===true&&(row.executionResultIsFill||['Cancelled','Canceled'].includes(row.receipt.status));
   const stopped={HUMAN_PAUSED:'你已暂停',FAILURE_LIMIT:'连续查询失败，需人工恢复',BROKER_TERMINAL:'订单已终结，自动停止'};
   card.append(el('p',{},`后台只读跟踪：${watch.enabled?'已启用':'未启用 / 已暂停'} · 上次查询 ${watch.lastCheckedAt??'尚未查询'}${watch.stoppedReason?' · '+(stopped[watch.stoppedReason]??watch.stoppedReason):''}`));
   if(watch.lastError)card.append(notice(watch.lastError.code+'：'+watch.lastError.message));
   if(row.lastError)card.append(notice(row.lastError,'warn'));
   const controls=el('div',{class:'actions'}),reviewBox=el('div',{}),errors=el('div',{});let busy=false;
   const action=(name,fn)=>button(name,async()=>{if(busy)return;busy=true;activeActions++;replace(errors);try{await fn();}catch(e){replace(errors,notice(e.message,'error'));}finally{busy=false;activeActions--;}},{disabled:!enabled});
   const shortOpen=f.assetClass==='OPTION'&&f.side==='SELL'&&f.positionEffect==='OPEN';
   const evidence=el('textarea',{rows:8,'aria-label':'人工核对的Wheel证据JSON',placeholder:'填写已核对的Wheel分析输入JSON；不使用模型自动确认的账户事实。'});
   if(shortOpen&&row.status==='PREVIEWED')card.append(el('label',{class:'field'},'人工核对的Wheel证据JSON',evidence));
   const review=async kind=>{
    const reviewed=await op('trade.review',{id:row.id,revision:row.revision,action:kind,...(kind==='SUBMIT'&&shortOpen?{wheelEvidence:JSON.parse(evidence.value)}:{})});
    row.revision=reviewed.revision;reviewActive=true;
    const check=el('input',{type:'checkbox','aria-label':'我已核对以上订单及券商警告'}),final=button(kind==='CANCEL'?'确认请求撤单':kind==='DECLINE'?'确认拒绝券商警告':'确认发送至IBKR模拟账户',async()=>{
     final.disabled=true;try{const result=await op('trade.confirm',{id:reviewed.id,revision:reviewed.revision,confirmationToken:reviewed.confirmationToken});await refresh();if(box.isConnected&&result.status==='UNKNOWN')box.prepend(notice('提交结果未知，请查单；不要重新创建同一订单。','warn'));}catch(e){await refresh();if(box.isConnected)box.prepend(notice(e.message,'error'));}
    },{class:'btn primary',disabled:true});
    check.addEventListener('change',()=>{final.disabled=!check.checked;});
    replace(reviewBox,el('div',{class:'notice warn'},el('strong',{},`最终核对：${kind} · ${f.accountId} · ${f.side} ${f.quantity} ${f.symbol} @ ${f.limitPrice} ${f.currency}`),el('p',{},`确认有效至 ${reviewed.confirmationExpiresAt}；只针对当前版本。`),el('label',{class:'check'},check,'我已核对以上订单及券商警告'),final,button('返回核对',refresh)));
   };
   if(['READY','PREVIEWED'].includes(row.status))controls.append(action('取得 / 更新券商预览',async()=>{await op('trade.prepare',{id:row.id,revision:row.revision});await refresh();}));
   if(row.status==='PREVIEWED')controls.append(action('核对并准备提交',()=>review('SUBMIT')));
   if(row.status==='AWAITING_BROKER_REPLY')controls.append(action('核对IBKR警告并继续',()=>review('REPLY')),action('拒绝IBKR警告',()=>review('DECLINE')));
   if(['ACKNOWLEDGED','UNKNOWN','SUBMITTING','CANCEL_PENDING'].includes(row.status))controls.append(action('从IBKR查单',async()=>{const result=await op('trade.refresh',{id:row.id});await refresh();if(result.message)box.prepend(notice(result.message));}));
   if(['ACKNOWLEDGED','UNKNOWN','SUBMITTING','CANCEL_PENDING'].includes(row.status))controls.append(button(watch.enabled?'暂停自动查单':'启用自动查单',async()=>{await op('trade.watch',{id:row.id,revision:watch.revision,enabled:!watch.enabled});await refresh();},{disabled:!watch.enabled&&(terminal||!enabled||!S.boot.capabilities.orderMonitoring?.enabled)}));
   if(row.status==='ACKNOWLEDGED'&&!['Filled','Cancelled','Canceled','Inactive'].includes(row.receipt?.status))controls.append(action('核对撤单请求',()=>review('CANCEL')));
   if(['NEEDS_INPUT','READY','PREVIEWED'].includes(row.status))controls.append(button('放弃未提交需求',async()=>{await op('trade.discard',{id:row.id,revision:row.revision});await refresh();}));
   card.append(controls,reviewBox,errors);box.append(card);
  }
 }
 await refresh();
 // Only refresh visible cards, and preserve active human review and edited input.
 function schedule(){const timer=setTimeout(async()=>{
  if(!box.isConnected)return;
  try{if(!document.hidden&&!reviewActive&&!activeActions&&!(box.contains(document.activeElement)&&['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)))await refresh();}catch{/* Manual refresh still reports errors through the UI. */}
  if(box.isConnected)schedule();
 },5000);timer.unref?.();}
 if(typeof document.visibilityState==='string')schedule();
 return{refresh};
}
