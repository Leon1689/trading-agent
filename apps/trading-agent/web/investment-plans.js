/** Human research-plan acceptance is separate from the conversation tool loop. */
export async function renderInvestmentPlans(host,ui){
  const {el,button,notice,op,valueView,replace,renderResult,startPrompt}=ui;
  const panel=el('section',{class:'card'},el('h2',{},'我的投资计划')),list=el('div',{}),result=el('div',{});
  panel.append(el('p',{class:'help'},'对话整理目标、预算、期限与风险偏好；确认后保存研究组合。不会自动买入。'),button('用对话创建投资计划',()=>startPrompt('帮我制定投资计划。先询问我的目标、风险偏好、期限、预算、排除标的和单一持仓上限；用 plan_draft 保存多轮需求，配置权重交由我核对。')),list,result);host.append(panel);
  const refresh=async()=>{
    const rows=await op('plan.list');if(!panel.isConnected)return;
    replace(list,...rows.map(row=>{
      const card=el('article',{class:'news-card'},el('h3',{},row.fields.name??'未命名计划'),el('p',{},row.status==='ACCEPTED'?'已确认研究组合':row.status==='READY'?'等待人工核对':'需求待补充'),valueView(row.fields),row.questions?.length?valueView(row.questions):null,row.violations?.length?notice(row.violations.join(' · ')):null);
      if(row.status==='READY'){
        const check=el('input',{type:'checkbox'}),accept=button('确认此研究组合',async()=>{accept.disabled=true;try{renderResult(result,await op('plan.accept',{id:row.id,revision:row.revision}),'plan.accept');await refresh();}catch(error){accept.disabled=false;throw error;}},{class:'btn primary',disabled:true});
        check.addEventListener('change',()=>accept.disabled=!check.checked);
        card.append(el('label',{class:'check'},check,'已核对以上全部参数，仅保存研究组合'),accept);
      }
      if(row.status!=='ACCEPTED')card.append(button('继续完善',()=>startPrompt(`继续完善投资计划 ${row.id}。先用 plan_get 读取最新版本，向我询问缺失条件或冲突；配置权重只是提案，不要替我确认。`)));
      return card;
    }));if(!rows.length)list.append(el('p',{class:'help'},'尚无计划。可以从对话或下方表单创建。'));
  };
  panel.append(button('刷新投资计划',refresh,{class:'btn small'}));await refresh();
}
