/** Additional native Pi workspace operations. All execution decisions remain human operations. */
const str=(description,extra={})=>({type:'string',description,...extra}),num=(description,extra={})=>({type:'number',description,...extra}),obj=description=>({type:'object',description,additionalProperties:true}),arr=(description,items={type:'object',additionalProperties:true})=>({type:'array',description,items}),bool=description=>({type:'boolean',description});
const op=(operation,title,group,kind,scope,properties={},required=[],example={},model=false)=>({operation,title,description:title,group,kind,scope,model,inputSchema:{type:'object',properties,required,additionalProperties:false},example});
const id={id:str('记录ID')},rev={...id,revision:num('当前记录版本',{minimum:1})};
const order={symbol:'AAPL',assetClass:'STOCK',side:'BUY',positionEffect:'OPEN',quantity:1,type:'LIMIT',limitPrice:'100.00',currency:'USD',timeInForce:'GTC',session:'REGULAR',estimatedFees:'0.00'};
export const extendedCatalog=[
 op('research.technicals','技术指标 SMA/EMA/RSI/MACD','research','compute','compute',{symbol:str('证券代码'),series:arr('按时间严格升序的date/close'),asOf:str('带时区的截至ISO时间'),priceBasis:str('复权口径',{enum:['UNADJUSTED_CLOSE','SPLIT_ADJUSTED_CLOSE','ADJUSTED_TOTAL_RETURN']}),smaPeriods:arr('SMA周期',num('周期')),emaPeriods:arr('EMA周期',num('周期')),rsiPeriod:num('RSI周期'),macd:obj('fast/slow/signal周期')},['series','asOf','priceBasis'],{symbol:'TEST',series:[{date:'2026-11-16',close:100},{date:'2026-11-17',close:102},{date:'2026-11-18',close:101},{date:'2026-11-19',close:104}],asOf:'2026-11-20T00:00:00Z',priceBasis:'UNADJUSTED_CLOSE',smaPeriods:[2],emaPeriods:[2],rsiPeriod:2,macd:{fast:2,slow:3,signal:2}},true),
 op('research.events','宏观、行业与公司事件卡','research','compute','compute',{articles:arr('含title/source/publishedAt等字段'),asOf:str('截至时间'),limit:num('卡片数量')},['articles','asOf'],{articles:[{id:'example',title:'Federal Reserve inflation outlook',source:'synthetic-example',publishedAt:'2026-11-20T10:00:00Z'}],asOf:'2026-11-21T00:00:00Z',limit:30},true),
 op('research.stock','个股研究总览','research','read','market',{symbol:str('股票代码'),from:str('历史开始日期'),to:str('历史结束日期')},['symbol','from','to'],{symbol:'AAPL',from:'2026-01-01',to:'2026-11-20'},true),
 op('portfolio.rebalancePlan','生成组合再平衡计划','portfolios','compute','compute',{currency:str('币种'),cash:str('可用现金金额'),positions:arr('symbol/quantity/price，零持仓候选也需价格'),targetWeights:obj('目标权重，剩余为现金'),estimatedFeePerOrder:str('每笔预计费用'),minimumTradeValue:str('最小交易额')},['currency','cash','positions','targetWeights','estimatedFeePerOrder','minimumTradeValue'],{currency:'USD',cash:'1000.00',positions:[{symbol:'A',quantity:10,price:'100.00'},{symbol:'B',quantity:0,price:'50.00'}],targetWeights:{A:0.5,B:0.5},estimatedFeePerOrder:'1.00',minimumTradeValue:'0.00'},true),
 op('predict.compare','预测市场价阶与概率差比较','predict','compute','predict',{markets:arr('明确规则、时间、单位、深度、费用和主观概率的市场'),quantity:num('比较数量'),asOf:str('比较时间'),maxAgeMs:num('最大数据年龄')},['markets','quantity','asOf','maxAgeMs'],{},true),
 op('conditions.create','创建本地止损/止盈/OCO规则','orders','human','portfolio',{name:str('规则名'),kind:str('类型',{enum:['SINGLE','OCO']}),maxAgeMs:num('行情最大年龄'),expiresAt:str('规则截止ISO时间'),legs:arr('type STOP_LIMIT/TAKE_PROFIT_LIMIT、triggerPrice及完整order')},['name','kind','maxAgeMs','expiresAt','legs'],{name:'合成条件演练',kind:'SINGLE',maxAgeMs:300000,expiresAt:'2027-01-01T00:00:00Z',legs:[{type:'STOP_LIMIT',triggerPrice:'100.00',order}]}),
 op('conditions.list','本地条件规则','orders','read','portfolio',{limit:num('数量'),offset:num('偏移')},[],{},true),
 op('conditions.get','读取条件规则','orders','read','portfolio',id,['id'],{},true),
 op('conditions.evaluate','用明确行情检查条件','orders','human','portfolio',{...rev,eventId:str('唯一检查事件ID'),quote:obj('symbol/price/asOf/source/synthetic/assetClass/currency:USD/priceUnit（STOCK为USD_PER_SHARE，OPTION为USD_PER_UNDERLYING_UNIT并需完整contract）')},['id','revision','eventId','quote']),
 op('conditions.cancel','取消条件规则','orders','human','portfolio',rev,['id','revision']),
 op('conditions.previewTriggered','重新预览已触发草稿','orders','human','portfolio',rev,['id','revision']),
 op('order.replaceDraft','修改并替换未确认草稿','orders','human','portfolio',{...rev,patch:obj('需要修改的订单字段')},['id','revision','patch']),
 op('chat.search','全文搜索Pi会话','conversations','human','portfolio',{query:str('标题或消息正文关键词'),includeArchived:bool('含归档'),includeDeleted:bool('含回收站'),limit:num('每页最多1000'),offset:num('分页偏移')},[],{query:'',limit:50,offset:0}),
 op('chat.trash','移入会话回收站','conversations','human','portfolio',rev,['id','revision']),
 op('chat.restore','从会话回收站恢复','conversations','human','portfolio',rev,['id','revision']),
 op('chat.fork','编辑问题并建立Pi分支','conversations','human','portfolio',{...rev,messageIndex:num('用户消息在UI messages中的下标'),replacement:str('修改后的问题'),title:str('新分支标题')},['id','revision','messageIndex','replacement']),
 op('chat.native','查看Pi原生会话信息','conversations','human','portfolio',id,['id']),
 op('chat.exportNative','导出Pi原生JSONL记录','conversations','human','files',id,['id']),
 op('share.create','创建本机只读分享快照','conversations','human','portfolio',{sourceType:str('来源',{enum:['chat','file']}),sourceId:str('会话或文本文件ID'),expiresInHours:num('1到168小时',{minimum:1,maximum:168})},['sourceType','sourceId','expiresInHours']),
 op('share.list','本机分享记录','conversations','human','portfolio'),
 op('share.revoke','撤销分享链接','conversations','human','portfolio',rev,['id','revision']),
 op('briefs.create','设置周期性研究简报','alerts','human','market',{name:str('简报名'),symbols:arr('标的',str('代码')),intervalMs:num('周期毫秒，日更为86400000'),enabled:bool('启用')},['name','symbols','intervalMs','enabled'],{name:'每日观察',symbols:['AAPL','MSFT'],intervalMs:86400000,enabled:true}),
 op('briefs.list','研究简报任务','alerts','read','portfolio',{},[],{},true),
 op('briefs.update','启停研究简报','alerts','human','portfolio',{...rev,enabled:bool('启用')},['id','revision','enabled']),
 op('briefs.run','立即生成简报与本地通知','alerts','human','market',id,['id']),
 op('profile.get','本地个人资料','settings','human','portfolio'),
 op('profile.update','修改本地个人资料','settings','human','portfolio',{revision:num('当前版本，初次为0',{minimum:0}),displayName:str('显示名'),bio:str('简介')},['revision','displayName']),
];
