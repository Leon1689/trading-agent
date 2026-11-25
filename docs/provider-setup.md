# 数据源接入参考

本文描述 `packages/trading/providers.js` 的当前配置、请求与限制。它提供固定白名单内的 HTTP GET 请求；没有下单、撤单、换汇、授权、切换券商账户或绕过 TLS 验证的路径。配置只能由本机应用配置文件提供，聊天参数不能改变主机、凭据或账户范围。调用者仍须控制哪些操作可在当前对话使用。

## 配置

下列对象传给 `createProviders`；独立 Pi 应用负责从指定 --home 的本地受控配置加载，不把整个对象发给模型。API 密钥由环境变量读取，配置只保存环境变量名称。未提供的服务返回 `UNCONFIGURED`，不会使用合成数据替补。

在 v3 独立应用中，下列对象放入 `<PI_TRADER_HOME>/config.json` 的 `providers` 字段，而不是替换整个配置文件。默认数据目录为启动目录下 `.pi-trader`，也可显式传 `--home`；完整外层结构参见 [config.example.json](../config.example.json)。保留 `execution.mode="READ_ONLY"` 即可单独配置数据读取。修改后重启 `npm start -- --home <目录>`；读取适配器可用与真实数据授权通过是两项独立验收。旧 Harness 插件路径只用于兼容部署，不是 v3 主路径。

```json
{
  "mode": "live",
  "fmp": { "apiKeyEnv": "FMP_API_KEY" },
  "alpaca": {
    "keyEnv": "ALPACA_API_KEY",
    "secretEnv": "ALPACA_SECRET_KEY",
    "feed": "indicative"
  },
  "ibkr": {
    "baseUrl": "https://localhost:5000/v1/api",
    "accountIds": ["REPLACE_WITH_AUTHORIZED_ACCOUNT"]
  },
  "predict": { "enabled": true },
  "limits": {
    "timeoutMs": 15000,
    "maxBytes": 2097152,
    "maxItems": 5000,
    "maxPages": 5,
    "minIntervalMs": 250
  }
}
```

删除不准备启用的服务配置。示例账户名称是占位值，部署时必须替换为用户指定账户；不能从返回账户列表自动放宽允许范围。IBKR 仅接受 loopback `/v1/api` 地址，登录和二次认证由用户在官方 Gateway 完成。证书必须受 Node 信任；可配置本机受信 CA，代码不支持关闭证书验证。

`limits` 默认值为15秒、2 MiB、100条、5页、250毫秒。跨年度历史研究应显式提高 `maxItems`，上限5000；限制导致截断时 `complete=false`。`timeoutMs`包含排队时间，每个请求有独立取消信号；同源请求排队，IBKR账户、订单、成交端点还遵守每端点至少5秒间隔，其余IBKR请求至少100毫秒。遇到429不自动重试；宿主展示失败并决定下一次用户查询或调度时机。

`capabilities()`报告每个操作的配置状态，`credentialsValidated=false`表示“已填写配置”不等于密钥、订阅或登录已验收。没有任何操作会在构造适配器或读取能力列表时连接账户。

## 应用操作

所有调用使用 `await providers.request(operation, args, { signal })`。下表是应用接口，不是券商原生方法名。

| operation | 输入 | 返回 `data` |
|---|---|---|
| `market.quote` | `symbol` | 报价数组：symbol、十进制字符串price、currency、volume、change、changePercent、asOf、raw |
| `market.history` | `symbol,from,to` | 按交易日升序的 `{date,adjustedClose,volume,symbol}`，来源为股息及拆股调整EOD；不会用普通close替代 |
| `market.news` | 可选symbol、from/to、page、limit | 标题、摘要、出版者、HTTP(S)来源链接、原始发布时间；未带时区的时间保留raw且标准时间为null |
| `market.profile` | `symbol` | 公司资料数组，保留供应商字段 |
| `market.financials` | `symbol,statement,period,limit` | income/balance/cashflow/ratios之一；quarter或annual |
| `market.analysts` | `symbol,kind,period,limit` | ratings为评级共识、targets为目标价共识、estimates为季度或年度预测 |
| `market.screen` | `category,limit` | active/gainers/losers/filter；filter接受sector/industry/country/exchange和文档中实现的数值过滤项 |
| `market.earnings` | `from,to,limit` | 财报日历数组；不是已验证事件风险结论 |
| `market.options` | `symbol,right,from,to,limit,cursor` | Alpaca期权快照候选，CALL/PUT；from/to筛选到期日；返回nextCursor |
| `broker.accounts` | 空对象 | 仅允许列表内的accountId、currency、accountType |
| `broker.snapshot` | `accountId` | summary、分币种cash、positions、orders、executions及coverage |
| `predict.markets` | `platform,limit`；Kalshi可传status/cursor/eventId，Polymarket可传offset/closed/slug | 预测市场卡、结果及价格；不创建钱包或交易 |
| `predict.detail` | `platform,id` | 单市场数组，Kalshi用ticker，Polymarket用数字ID |

日期要求有效的 `YYYY-MM-DD`，数量上限由部署配置决定。股票代码只接受有限字符；不接受任意URL、API路径或HTTP方法。过滤、分页和数据集范围始终属于输出解释的一部分，不把一个分页结果称为全市场扫描。

## 结果与单位

外层返回 `{source,asOf,receivedAt,mode,data,missing,...}`。`asOf`取自源数据而非请求时间；未知为null。`receivedAt`只表示应用收取时间。FMP统一保守标为`delayed`，并注明数据源时间或延迟未获保证；不据接口名称承诺当前用户拥有实时行情权限。Alpaca `indicative`同样标为delayed，`opra`成功返回时标为live并保留feed和源时间。

历史接口的`complete=true`仅表示本次收到的结果未触及适配器截断条件，不证明交易所日历覆盖完整，也不能识别供应商静默缺失的所有日期。上层回测拒绝`complete=false`、合成数据、跨标的不齐日期和超过支持范围的日频缺口，并保留实际使用日期；完整交易日核验仍须明确交易所日历或调用方提供预期日期。上市时间、假日与停牌不能靠自动补价猜测。

期权快照没有合约交割详情，因此`multiplier`和`deliverables`为null，不能默认100。Greeks保留供应商值，`greekUnits=provider_native_units_unverified`，在单位核验和合约详情补全前不能自动聚合为组合风险；本地定价引擎的已定义单位是另一类数据。成交最后一笔数量不是日成交量，本适配器将`volume`保留null。数据缺失通过`missing`列出，未配置不生成示例报价。

IBKR分币种现金不加总`BASE`换算行，`settledCash`不直接冒认为可用于全部CSP的可用现金。`brokerCostBasis`保持`avgCost`原口径，另给averagePrice；不会覆盖策略N。分页持仓读完后才有`positionsComplete=true`；账户组件不是原子快照，整个结果`complete=false`，必须由上层对账和时间一致性服务继续判断。

订单只覆盖当前券商会话可见范围。成交端点受Gateway当前选中账户及当日加前六日范围限制；结果再按允许账户筛选，历史覆盖始终不完整。空数组不证明完整历史无成交；读取失败返回null与缺失原因，避免把失败显示为零。没有自动更改Gateway选中账户。完整历史、指派、公司行动和费用迟到仍需要独立的对账与补录流程。

预测市场价格使用每1美元二元兑付合约的美元报价，不转成“客观概率”。Kalshi读取`*_dollars`和`*_fp`，不再把这些值除100；Polymarket的序列化outcomes/outcomePrices成对解析。市场规则仅为返回的文本，不代表应用确认结算条件。Polymarket每个结果的bid/ask需要CLOB接口，本版本保留null。卡片url指向对应公开API原始记录，不承诺直接打开交易页面。

## 失败与合成模式

主要错误码：`UNCONFIGURED`、`UNSUPPORTED`、`INVALID_INPUT`、`INVALID_CONFIG`、`ACCOUNT_SCOPE`、`ACCOUNT_UNAVAILABLE`、`AUTH_REQUIRED`、`ACCESS_DENIED`、`RATE_LIMITED`、`UPSTREAM_HTTP`、`UPSTREAM_SCHEMA`、`UPSTREAM_REJECTED`、`RESPONSE_TOO_LARGE`、`UPSTREAM_UNAVAILABLE`、`TIMEOUT`、`ABORTED`。HTTP403不能单独诊断为订阅问题，也可能是区域或访问策略。错误不透传上游正文、URL、头部或原始异常；未确认访问权限时不改用其他域名绕过。

离线演示必须显式设置`mode='synthetic'`和`fixtures`，按操作名注入已准备的结果数据。输出必带`source='explicit_fixture'`、`mode='synthetic'`及“不是行情/账户证据”缺失标记。每次复制结果，调用方不能修改之后的fixture；缺少某操作fixture时报错，真实模式也不会回退到fixture。

工作台持久化合成券商快照时使用`inputAuthority='SYNTHETIC_FIXTURE'`；真实适配器响应使用`BROKER_REPORTED`。两者均不自动写入策略账本，合成结果不会因保存而获得券商事实身份。

## 官方核对与实际验证

接口定位于2026-11-21核对；上游接口或订阅变化需要重新验收。

- [FMP接口目录](https://site.financialmodelingprep.com/developer/docs)定义stable路径和header `apikey`；[股息调整历史](https://site.financialmodelingprep.com/developer/docs/stable/historical-price-eod-dividend-adjusted)用于总回报价格序列。FMP实际付费权益没有测试。
- [Alpaca option chain](https://docs.alpaca.markets/us/reference/optionchain)定义snapshots、分页和opra/indicative。未使用真实密钥请求。
- [IBKR账户及余额说明](https://www.interactivebrokers.com/campus/ibkr-api-page/web-api-trading/)、[分页持仓](https://ibkrcampus.com/docs/web-api/v1/endpoints/portfolio/positions)、[成交范围](https://ibkrcampus.com/docs/web-api/v1/endpoints/order-monitoring/trades)、[速率限制](https://ibkrcampus.com/docs/web-api/v1/pacing-limitations)用于只读路径与覆盖声明；未连接真实或模拟券商账户。
- [Kalshi市场接口](https://docs.kalshi.com/api-reference/market/get-markets)当前指向`external-api.kalshi.com`，字段采用美元/固定小数形式。[Polymarket市场接口](https://docs.polymarket.com/api-reference/markets/list-markets)采用Gamma API。服务可用性与访问权限取决于部署环境；适配器测试不代表目标环境已获得服务访问权限。

`node --test packages/trading/test/providers.test.js`验证只读白名单、请求字段、金额单位、无密钥泄露、账户过滤、分页/覆盖状态、未知值、超时/取消、响应大小与JSON解析限制及明确合成模式。mock传输通过不等于供应商授权和真实数据正确性已经验收。


## 3.3 对话交易入口

新增独立IBKR模拟执行配置和人工确认流程；原查询provider保持只读。配置、订单状态、支持范围和待联调项见[对话交易设计](conversational-trading.md)。请勿将LOCAL_PAPER与券商PAPER混用。

## Personal assistant integration (3.5)

See [personal assistant design](personal-assistant.md) for the complete module graph, data structures, operation scopes, workflow and remaining gaps. The additions reuse the existing runtime, ledger and human-confirmed IBKR paper gateway.
