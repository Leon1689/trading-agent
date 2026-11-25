/** Conversational preparation tools and separate human-only broker controls. */
const s=(description,extra={})=>({type:'string',description,...extra});
const n=description=>({type:'number',description});
const fields={accountId:s('IBKR模拟账户DU编号'),symbol:s('股票代码；期权填写标的代码'),assetClass:s('资产',{enum:['STOCK','OPTION']}),side:s('买卖',{enum:['BUY','SELL']}),positionEffect:s('开平仓',{enum:['OPEN','CLOSE']}),quantity:n('整数股数或合约数'),type:s('本版本支持限价',{enum:['LIMIT']}),limitPrice:s('每股或每份期权限价，十进制字符串'),currency:s('币种',{enum:['USD']}),timeInForce:s('有效期',{enum:['DAY','GTC']}),session:s('交易时段',{enum:['REGULAR']}),conid:n('从IBKR查询到的唯一合约ID'),expiration:s('期权到期日YYYY-MM-DD'),right:s('期权方向',{enum:['CALL','PUT']}),strike:s('期权行权价'),multiplier:n('IBKR核实的合约乘数')};
const id={id:s('交易需求ID')},rev={...id,revision:n('最新版本')};
function op(operation,title,kind,properties={},required=[],model=false){return{operation,title,description:title,group:'orders',kind,scope:'trade',model,inputSchema:{type:'object',properties,required,additionalProperties:false},example:{}};}
export const tradeCatalog=[
 op('trade.intent','提取或补充对话交易需求（不下单）','write',{...rev,fields:{type:'object',properties:fields,additionalProperties:false},clear:{type:'array',items:s('清空字段',{enum:Object.keys(fields)})}},['fields'],true),
 op('trade.list','交易需求与券商订单列表','read',{chatId:s('仅此会话；省略显示全部')},[],true),
 op('trade.get','读取交易需求和缺失参数','read',id,['id'],true),
 op('trade.search','IBKR股票与期权标的搜索','read',{symbol:s('标的代码')},['symbol'],true),
 op('trade.optionContracts','IBKR期权行权价或精确合约查询','read',{symbol:s('标的代码'),underlyingConid:n('search返回的标的ID'),month:s('search返回月份，例如DEC26'),right:s('方向',{enum:['CALL','PUT']}),strike:s('不填查询行权价，填写查询该行权价合约')},['symbol','underlyingConid','month'],true),
 op('trade.prepare','校验需求并取得IBKR模拟订单预览（不提交）','write',rev,['id','revision'],true),
 op('trade.refresh','从IBKR查询订单回执与成交状态','read',id,['id'],true),
 op('trade.review','人工核对订单或券商警告，签发短期确认凭证','human',{...rev,action:s('确认动作',{enum:['SUBMIT','REPLY','CANCEL','DECLINE']}),wheelEvidence:{type:'object',description:'卖出开仓期权需人工填写已核对的Wheel分析输入',additionalProperties:true}},['id','revision','action']),
 op('trade.confirm','人工提交已核对的IBKR模拟订单动作','human',{...rev,confirmationToken:s('人工核对返回的凭证')},['id','revision','confirmationToken']),
 op('trade.discard','放弃未提交的交易需求','human',rev,['id','revision']),
];
export const INTENT_FIELDS=fields;
