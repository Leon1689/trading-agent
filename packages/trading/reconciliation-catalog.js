const string = description => ({type:'string',description});
const id = {id:string('记录ID')};
const revision = {type:'number',description:'当前记录版本；首次开启跟踪填0'};
const scopes = ['broker','ledger','trade'];
const operation = (name,title,kind,properties,required,model=false) => ({
  operation:name,title,description:title,group:'reconciliation',kind,scope:'broker',requiredScopes:scopes,model,
  inputSchema:{type:'object',properties,required,additionalProperties:false},example:{},
});
export const reconciliationCatalog = [
  operation('reconcile.create','生成持仓与成交对账报告（不修改账本）','human',{
    snapshotId:string('固定券商快照ID'),ledgerRevision:revision,
    accountScopeConfirmed:{type:'boolean',description:'已人工确认所选账本持仓属于快照账户'},
    bindings:{type:'array',description:'人工核对的股票映射；不按代码自动匹配',items:{type:'object',properties:{symbol:string('账本股票代码'),instrumentId:string('券商conid'),currency:string('已核对币种')},required:['symbol','instrumentId','currency'],additionalProperties:false}},
  },['snapshotId','ledgerRevision','accountScopeConfirmed','bindings']),
  operation('reconcile.list','已保存的对账报告','read',{},[],true),
  operation('reconcile.get','读取对账报告及过期状态','read',id,['id'],true),
  operation('reconcile.review','人工记录对账复核意见（不入账）','human',{...id,revision,note:string('复核记录；差异仍需单独处理')},['id','revision','note']),
  {...operation('trade.watch','启停此订单的后台只读跟踪','human',{...id,revision,enabled:{type:'boolean'},intervalMs:{type:'number',description:'查询间隔毫秒；至少15000'}},['id','revision','enabled']),group:'orders',scope:'trade',requiredScopes:['trade']},
  {...operation('trade.monitorStatus','读取订单跟踪状态','read',id,[],true),group:'orders',scope:'trade',requiredScopes:['trade']},
];
