# 本地研究与条件预览契约

此页描述Pi交易Agent的独立领域模块：`research-features.js`与`conditional-paper.js`。二者不访问网络，不读取密钥，也不提交券商订单。所有明确输入都属于用户给出的情景；服务层负责工具权限、操作目录和审计。

## 技术指标

`technicalIndicators({symbol?, series, priceBasis, asOf, smaPeriods?, emaPeriods?, rsiPeriod?, macd?})`接受严格递增的`[{date:"YYYY-MM-DD",close:number}]`。日期必须有效、唯一且不晚于带时区的`asOf`，价格为正。最多20000个观测，不填充缺失交易日；周期按观测数计算。

`priceBasis`须明确选择`UNADJUSTED_CLOSE`、`SPLIT_ADJUSTED_CLOSE`或`ADJUSTED_TOTAL_RETURN`。默认周期SMA20/50、EMA12/26、RSI14、MACD12/26/9写回`parameters`；这些是计算参数默认值，不是自动交易阈值。均线周期可配置1–2000，最多10条同类均线。

- SMA取完整窗口平均值。EMA首值用第一个完整窗口的SMA，然后使用`alpha=2/(n+1)`递推。
- RSI初值用n次上涨/下跌变化的平均值，后续以Wilder形式`(previous*(n−1)+current)/n`平滑；无涨无跌时本实现约定50，无下跌且有上涨时100。
- MACD为快EMA减慢EMA；信号线是MACD的EMA，柱为两者差。暖机不足返回`null`，不伪装成0。
- 每个历史输出只使用该观测及之前的数据。追加新价格不改变原输出前缀；没有收益或方向保证。

返回`rows/latest/parameters/methodology/methodVersion`及用户情景/不可发单标记。算法参考[Fidelity EMA](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/ema)、[RSI](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/RSI)和[MACD](https://www.fidelity.com/learning-center/trading-investing/technical-analysis/technical-indicator-guide/macd)。明确的种子和暖机约定是本项目实现选择，不声称复现所有终端的相同初始历史。

## 新闻卡与分类

`classifyNews({articles,asOf,limit?})`接受新闻`id?/title/text?/url?/source/publishedAt?/symbols?/sector?`。只允许不含凭据的HTTP(S)链接；来源和标题必须明确。未知发布时间保留未知，未来时间拒绝。

按新闻来源+ID、其次URL、其次标题/时间摘要去重；相同稳定身份有不同内容则返回`EVENT_CONFLICT`。分类为MACRO、INDUSTRY、COMPANY或UNCLASSIFIED；宏观/行业关键词命中优先，再用输入行业和标的字段。每项保留`LOCAL_HEURISTIC`、规则ID、`confirmed:false`。排序仅按已知发布时间从新到旧，未知时间置后；不冒认BOBBY的热点评分或投资推荐。

## 再平衡研究计划

`planRebalance({currency,cash,positions,targetWeights,estimatedFeePerOrder,minimumTradeValue})`支持同一币种、纯股票、非负整数股数。`positions`包含`symbol/quantity/price`；目标中未持有的资产也须提供零数量和明确价格。金额用最多两位小数的字符串，内部转换为整数分；不调用券商净值或价格。

目标股票权重之和须大于0且不超过1，剩余视为目标现金。先按所有资产数保守预留每单费用，再把目标数量向下取整。先列卖出，再用当前现金加计划卖出净收入限制买入；未达到最低金额而跳过的卖出不能为买入提供资金。按实际形成的计划订单扣费，未使用的保留资金留在现金。

输出卖买顺序、数量、限价、显式费用、预计持仓、剩余现金与未执行原因。`RESEARCH_PREVIEW`不等于实际撮合；计划中的卖出未实际成交之前，不能让执行服务把这些收入当作可用资金。限制包括无杠杆、无碎股、无税务优化、无滑点模型；原Wheel策略成本不由此重算。

## 预测市场价格阶梯

`comparePredictionMarkets({markets,quantity,asOf,maxAgeMs})`接受输入结果的完整字段：

```text
id,platform,outcome,eventKey?,resolutionRules?,asOf,source,synthetic,
priceUnit:"USD_PER_CONTRACT",payoutPerContract:1,
orderbook:{bids:[{price,quantity}],asks:[{price,quantity}]},
fairProbability?,feePerContract
```

合并相同价格档位，买盘降序、卖盘升序；跨档计算所需数量的真实输入深度。数量不足时保留可用数量，将总价/均价设为`null`，不外推全部成交。拒绝未来/过期数据及交叉订单簿。`synthetic`须显式标明。

主观买入价差为`用户概率−买入深度均价−显式每合约费用`。该费用不是自动平台费估计；主观概率不是客观概率。只有输入提供完全一致的eventKey、outcome和resolutionRules时才比较不同结果的最低买入总价/最高卖出净额；这仍只是用户提供的相同规则，未独立验证结算和执行可行性，始终`arbitrageVerified:false`。

本地计算数量范围为`1e-8`至`1e9`份；这不是平台的最小交易数量声明。深度不足不使用绝对误差阈值冒充完全满足；金额计算使用浮点数，结果仅为比较研究。

## 本地条件单与OCO

`new ConditionalPaper(store,paper,now)`暴露以下接口，所有写入/检查/重新预览必须由服务层绑定人类身份：

| 方法 | 参数/行为 |
|---|---|
| `create` | `{name,kind:"SINGLE"|"OCO",maxAgeMs,expiresAt,legs:[{type,triggerPrice,order}]}`；创建ARMED规则，不占用现金/股份。 |
| `list/get` | 版本化读取；列表支持limit/offset，未保存明文确认token。 |
| `cancel` | `{id,revision}`，仅ARMED可取消。 |
| `evaluate` | `{id,revision,eventId,quote:{symbol,assetClass,currency,priceUnit,contract?,price,asOf,source,synthetic}}`；检查指定行情并最多创建一个Paper DRAFT。 |
| `previewTriggered` | `{id,revision}`；针对已触发且未接受的旧草稿重新生成凭证，同时取消旧DRAFT；不能复制已经接受过的订单。 |

STOP_LIMIT：买入价达到或高于触发价、卖出价达到或低于触发价时匹配。TAKE_PROFIT_LIMIT方向相反。OCO为同一账户、标的、方向、数量的平仓规则，且一个止损、一个止盈；触发区间必须不重叠。一个分支触发后，另一分支在同一SQLite事务内变为CANCELLED_BY_OCO。OCO规则取消不是券商撤单。

只在用户主动检查时评估给定价格，没有隐藏后台撮合。输入价格必须新鲜且不早于上次已检查的价格；所谓非合成报价也只标为`USER_REPORTED_QUOTE_UNVERIFIED`。条件到期后不创建草稿；期权条件不能超过合约本地保守截止日。

报价须明确资产类型和`currency:"USD"`。股票为`priceUnit:"USD_PER_SHARE"`；期权为`priceUnit:"USD_PER_UNDERLYING_UNIT"`，即与订单限价相同的每一标的单位权利金，不能用乘数乘后的整份合约金额代替。期权报价还必须提供与规则完全相同的`contract:{right,underlying,multiplier,strike,expiration,standardDeliverableVerified}`；同一股票代码或同一标的不是同一期权合约。数量和乘数必须为明确整数，拒绝字符串隐式转换。

唯一eventId保证重试不新增草稿，冲突内容拒绝。首次匹配只向人类调用者返回token，保存的条件和事件仅含草稿ID；重复请求不再返回token，可显式重新预览。触发从不调用`paper.confirm/fill`，真实资源和版本检查仍发生在用户确认草稿时。READ_ONLY允许研究条件/草稿，禁止接受模拟订单。完整状态为ARMED→TRIGGERED/CANCELLED/EXPIRED；TRIGGERED不代表已成交。

## 验证

领域测试覆盖暖机、公式固定样例、无未来数据影响、新闻去重/冲突、再平衡现金守恒/费用/跳过销售、预测深度不足/价格单位/费用、条件方向、OCO事务、并发连接、幂等、时间/标的/期权合约及权利金单位错误、事务回滚及旧确认凭证失效。测试使用明确合成数据，不证明实时行情或策略盈利。
