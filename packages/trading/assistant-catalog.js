const str=(description,extra={})=>({type:'string',description,...extra}),num=description=>({type:'number',description}),obj=description=>({type:'object',description,additionalProperties:true});
const id={id:str('记录ID')},rev={...id,revision:num('当前记录版本')};
const op=(operation,title,english,group,kind,scopes,properties,required=[],example={})=>({operation,title,english,description:title,group,kind,scope:scopes[0],requiredScopes:scopes,model:kind!=='human',inputSchema:{type:'object',properties,required,additionalProperties:false},example});
const option=(side,strike,entryPrice)=>({assetClass:'OPTION',side,quantity:1,entryPrice,right:'CALL',strike,expiration:'2027-01-15',multiplier:100,standardDeliverableVerified:true,volatility:0.25});
export const assistantCatalog=[
  op('options.strategy','多腿期权损益与组合Greeks','Multi-leg option payoff and Greeks','options','compute',['compute'],{underlying:str('共同标的'),currency:str('币种',{enum:['USD']}),legs:{type:'array',description:'同一到期日股票/期权腿，逐腿明确方向、数量、价格和合约',items:obj('腿')},totalFees:num('总费用美元'),valuation:obj('估值model/spot/timeYears/rate/dividendYield/steps，腿需volatility'),maxSpot:num('曲线标的价格上界')},['underlying','currency','legs','totalFees'],{underlying:'TEST',currency:'USD',legs:[option('BUY',100,6),option('SELL',110,2)],totalFees:2,valuation:{model:'BLACK_SCHOLES',spot:100,timeYears:0.25,rate:0.04,dividendYield:0}}),
  op('plan.draft','创建或补充投资计划','Collect an investment plan','portfolios','write',['portfolio'],{...rev,fields:obj('name/objective/riskTolerance/horizonMonths/budget/maxPositionWeight/weights/excludedSymbols/note；只填用户提供的条件，配置权重是待确认提案'),clear:{type:'array',items:str('清空字段')},sourceText:str('需求原文')},['fields'],{fields:{name:'研究计划',objective:'长期分散投资'},sourceText:'先讨论目标，尚未确认风险、预算和权重'}),
  op('plan.list','投资计划列表','Investment plans','portfolios','read',['portfolio'],{limit:num('数量'),offset:num('偏移')}),
  op('plan.get','查看投资计划与待补问题','Investment plan and missing questions','portfolios','read',['portfolio'],id,['id']),
  op('plan.accept','人工确认研究组合','Accept a research portfolio','portfolios','human',['portfolio'],rev,['id','revision']),
  op('holdings.analyze','持仓集中度与分币种资产','Holdings concentration by currency','portfolios','read',['broker','portfolio'],{snapshotId:str('已保存的券商快照ID')},['snapshotId']),
  op('holdings.brief','持仓个性化研究简报','Personalized holdings briefing','research','read',['broker','portfolio','market'],{snapshotId:str('已保存的券商快照ID')},['snapshotId']),
  op('holdings.reports','已保存持仓简报','Saved holdings briefings','alerts','read',['broker','portfolio','market'],{}),
  op('holdings.report','读取持仓简报','Read holdings briefing','alerts','read',['broker','portfolio','market'],id,['id']),
  op('research.opportunities','市场机会与研究入口','Market opportunities and research prompts','research','read',['market'],{category:str('榜单',{enum:['active','gainers','losers']}),limit:num('数量')},['category'],{category:'active',limit:10}),
  op('predict.board','预测市场成交量、低价与涨跌榜','Prediction market boards','predict','read',['predict'],{platform:str('平台',{enum:['polymarket','kalshi']}),ranking:str('排序',{enum:['volume','lowPrice','movers']}),limit:num('单页样本数量')},['platform','ranking'],{platform:'polymarket',ranking:'volume',limit:20}),
  op('predict.orderbook','预测市场公开实时价阶','Public prediction order book','predict','read',['predict'],{platform:str('平台',{enum:['polymarket','kalshi']}),id:str('市场ID'),outcomeIndex:num('结果下标，从0开始'),depth:num('Kalshi盘口深度1到100')},['platform','id','outcomeIndex']),
  op('jobs.configure','设置持仓简报或条件监控任务','Configure holdings or condition monitoring','alerts','human',['portfolio'],{...rev,kind:str('任务类型',{enum:['HOLDINGS_BRIEF','CONDITION']}),accountId:str('简报只读账户'),conditionId:str('已有本地条件规则ID'),enabled:{type:'boolean'},intervalMs:num('轮询间隔，至少配置minIntervalMs')},['kind','enabled','intervalMs']),
  op('jobs.list','查看持续监控任务','Research and condition monitoring jobs','alerts','read',['broker','portfolio','market'],{}),
  op('jobs.run','立即运行监控任务','Run a monitoring job now','alerts','human',['portfolio'],id,['id']),
];
export const assistantFieldLabels={underlying:['共同标的','Underlying'],totalFees:['总费用（美元）','Total fees (USD)'],valuation:['Greeks估值输入','Greek valuation inputs'],maxSpot:['曲线价格上界','Chart maximum spot'],sourceText:['需求原文','Original request'],ranking:['排序方式','Ranking'],outcomeIndex:['结果下标','Outcome index'],depth:['盘口深度','Order book depth'],conditionId:['条件规则ID','Condition ID']};
