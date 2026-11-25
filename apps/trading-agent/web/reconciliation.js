/** Explicit account/contract bindings precede every saved comparison. */
export async function renderReconciliation(host,ui) {
  const {el,button,op,replace,notice,table,raw,download}=ui;
  const editor=el('section',{class:'card'}), reports=el('section',{class:'card'}), result=el('section',{class:'card'});
  host.append(editor,reports,result);
  const descriptions={MATCH:'数量一致',DIFFERENCE:'数量有差异',UNRESOLVED:'待核对',UNMAPPED_LEDGER:'账本持仓未映射',UNMAPPED_BROKER:'券商持仓未映射',LINKED:'已精确关联',CONFLICTING_DUPLICATES:'同一成交ID内容冲突',INVALID_EXECUTION_ID:'成交ID缺失或无效',ACCOUNT_MISMATCH:'账户不一致',UNLINKED_ORDER_REF:'没有对应订单引用',AMBIGUOUS_ORDER_REF:'订单引用不唯一',IDENTITY_MISMATCH:'合约、方向或币种不一致',INVALID_EXECUTION_AMOUNT:'成交数量或价格无效',OVERFILLED:'可见成交超过委托数量',REPORTED_FILL_UNKNOWN:'回执成交数量未知',VISIBLE_QUANTITY_MATCH:'当前可见数量一致',VISIBLE_EXCEEDS_RECEIPT:'可见成交多于回执',VISIBLE_WINDOW_GAP:'可见流水不足',REVIEW_REQUIRED:'待人工复核',REVIEWED:'已记录复核',EXACT_CONTRACT_AND_CURRENCY:'按合约ID和币种核对',ABSENT_IN_COMPLETE_POSITION_LIST:'完整持仓列表中不存在，按零比较',DUPLICATE_CONTRACT:'同一合约出现多条记录',MISSING_OR_INCOMPATIBLE_POSITION:'持仓缺失或资产/币种不兼容',ACCOUNT_AND_CONTRACT_NOT_CONFIRMED:'未确认账户和合约归属',NO_EXPLICIT_LEDGER_BINDING:'未填写账本映射',OPTION_OR_OTHER_ASSET_REQUIRES_MANUAL_REVIEW:'期权或其他资产须另行核对'};
  const limits={NON_ATOMIC_BROKER_SNAPSHOT:'账户各项数据分次读取，不是同一时刻的原子快照。',EXECUTION_WINDOW_NOT_COMPLETE_HISTORY:'成交仅为近期可见流水，不能当作完整历史。',NO_AUTOMATIC_LEDGER_POSTING:'本报告不自动修改账本或代替交易确认。',CASH_TAX_COST_OPTIONS_AND_CORPORATE_ACTIONS_NOT_RECONCILED:'现金、税务成本、期权持仓及公司行动尚未完成自动对账。',SYNTHETIC_INPUT_NOT_ACCOUNT_EVIDENCE:'当前使用合成测试数据，不是实际账户证据。',STALE_OR_UNKNOWN_SNAPSHOT_TIME:'快照接收时间过期、未知或异常，请重新获取。',NO_ATOMIC_AS_OF_TIME:'没有统一、可信的账户截至时点。',EXECUTIONS_UNAVAILABLE:'此次快照未取得成交明细。'};
  const describe=value=>descriptions[value]??value;
  let state, snapshot, inputs=[];
  const select=el('select',{'aria-label':'选择固定券商快照'}), mapping=el('div',{}), message=el('div',{});
  const confirmed=el('input',{type:'checkbox','aria-label':'已核对账户与合约映射'});
  async function show(id) {
    const report=await op('reconcile.get',{id});if(!result.isConnected)return;
    replace(result,el('h2',{},`对账报告 · ${report.accountId}`),notice(report.stale?'源账本或订单已变化，请生成新报告。':report.status==='REVIEWED'?'已记录人工复核意见；报告未修改账本。':'待人工复核；匹配结果不代表账户历史完整。'),
      el('p',{},`快照 ${report.snapshotId} · 账本版本 ${report.ledgerRevision} · ${report.createdAt}`),
      el('h3',{},'股票持仓：券商数量 − 账本数量'),table(report.positions.map(row=>({'标的':row.symbol,'合约ID':row.instrumentId,'币种':row.currency,'账本股数':row.ledgerQuantity,'券商股数':row.brokerQuantity,'差额':row.difference,'核对结果':describe(row.status),'说明':describe(row.reason)}))),
      el('h3',{},'订单与可见成交'),table(report.orderFills.map(row=>({'订单引用':row.clientOrderId,'标的':row.symbol,'可见成交数量':row.visibleQuantity,'回执成交数量':row.reportedFilledQuantity,'已知佣金':row.knownCommission,'币种':row.currency,'佣金是否完整':row.commissionComplete,'核对结果':describe(row.status)}))),el('h3',{},'成交明细与去重结果'),table(report.executions.map(row=>({'成交ID':row.executionId,'订单引用':row.orderRef,'合约ID':row.instrumentId,'方向':row.side,'数量':row.quantity,'价格':row.price,'佣金':row.commission,'币种':row.currency,'出现次数':row.occurrences,'核对结果':describe(row.status)}))),
      el('h3',{},'数据覆盖与未完成项'),table(report.limitations.map(code=>limits[code]??code)),raw(report),
      button('下载对账JSON',()=>download(`reconciliation-${report.id}.json`,JSON.stringify(report,null,2))));
    if(report.review)result.append(notice(report.review.note,'info'));
    if(!report.stale&&!report.review) {
      const note=el('textarea',{rows:3,'aria-label':'对账复核意见',placeholder:'记录已核对的差异及后续处理；不自动入账。'});
      result.append(note,button('记录人工复核',async()=>{await op('reconcile.review',{id,revision:report.revision,note:note.value});await show(id);await list();}));
    }
  }
  async function list() {
    const rows=await op('reconcile.list');if(!reports.isConnected)return;
    replace(reports,el('h2',{},'已保存报告'),rows.length?table(rows.map(row=>({'账户':row.accountId,'生成时间':row.createdAt,'复核状态':describe(row.status),'源数据是否变化':row.stale,'持仓差异':row.summary.positionDifferences,'持仓待核对':row.summary.positionUnresolved,'成交异常':row.summary.executionIssues}))):notice('暂无报告。'));
    for(const row of rows)reports.append(button(`${row.accountId} · ${row.createdAt} · ${row.id.slice(0,8)}`,()=>show(row.id)));
  }
  async function load() {
    replace(message);confirmed.checked=false;
    [snapshot,state]=await Promise.all([op('snapshot.get',{id:select.value}),op('ledger.read')]);
    if(!mapping.isConnected)return;
    inputs=Object.keys(state.positions).map(symbol=>({symbol,conid:el('input',{'aria-label':`${symbol} conid`,placeholder:'人工核对conid'}),currency:el('select',{'aria-label':`${symbol} 币种`},el('option',{value:'USD'},'USD'))}));
    replace(mapping,notice(`快照账户 ${snapshot.accountId} · 账本版本 ${state.revision} · 来源 ${snapshot.inputAuthority??'未知'}。只映射属于此账户的股票，留空项将列为未映射。`),
      table((snapshot.data?.positions??[]).map(row=>({conid:row.instrumentId,symbol:row.symbol,assetClass:row.assetClass,quantity:row.quantity,currency:row.currency}))),
      inputs.map(row=>el('label',{class:'field'},`${row.symbol}（账本 ${state.positions[row.symbol].shares} 股）`,row.conid,row.currency)));
  }
  const snapshots=await op('snapshot.list');if(!editor.isConnected)return;
  select.append(...snapshots.map(row=>el('option',{value:row.id},`${row.accountId} · ${row.receivedAt??row.updatedAt} · ${row.inputAuthority??'UNKNOWN'}`)));
  replace(editor,el('h2',{},'成交与持仓对账'),notice('使用已保存的券商快照。账户流水可能仅覆盖最近数天；期权现金流、税务成本和公司行动仍需人工核对。'),
    snapshots.length?select:notice('先在“市场研究 → 券商只读账户快照”保存一次快照；未配置券商时不会访问外部账户。'),
    button('读取快照与账本',load,{disabled:!snapshots.length}),mapping,
    el('label',{class:'check'},confirmed,'已核对所选股票属于该快照账户，并核对合约ID及币种'),
    button('生成对账报告',async()=>{
      replace(message);if(!snapshot||!confirmed.checked){replace(message,notice('请先读取快照并确认账户与映射。','error'));return;}
      const report=await op('reconcile.create',{snapshotId:snapshot.id,ledgerRevision:state.revision,accountScopeConfirmed:confirmed.checked,bindings:inputs.filter(row=>row.conid.value.trim()).map(row=>({symbol:row.symbol,instrumentId:row.conid.value.trim(),currency:row.currency.value}))});
      await show(report.id);await list();
    },{class:'btn primary',disabled:!snapshots.length}),message);
  select.addEventListener('change',()=>{snapshot=null;state=null;confirmed.checked=false;replace(mapping);});
  await list();
}
