# Feature coverage

The matrix tracks research and trading workflows, including features compared with the publicly observable BOBBY product. It is not a statement of API compatibility, affiliation, or complete product equivalence. “Implemented” describes a code path; externally configured services still require validation.

| ID | 参照功能 | 当前状态 | 本项目对应实现与缺口 |
|---|---|---|---|
| F01 | Finance首页快捷入口 | 已实现 | 独立 Finance 总览、研究/期权/组合/Predict 四类快捷卡、预置研究问题；不是复刻品牌视觉。 |
| F02 | Hot Trades事件卡 | 已实现公开榜单入口/需配置 | research.opportunities连接供应商榜单与研究对话，新闻卡可继续分析；不复现专有热点评分。 |
| F03 | Stock Picks预置问题 | 已实现/需配置 | 首页预置研究问题与行情筛选、榜单入口；自然语言回答需要显式配置模型。 |
| F04 | 双股票比较 | 已实现/需配置 | `research.compare`聚合1–8标的资料，Pi可研究解释；真实财务源和模型需配置。 |
| F05 | 财报研究 | 已实现/需配置 | `market.financials`三表与比率、分析师字段、Pi解释；数据权限和时点需验收。 |
| F06 | 交互财务图表 | 已实现/需配置 | 财务指标选择与交互SVG图、结构化表格、回测净值/回撤图；缺数据不画伪曲线。 |
| F07 | 股票榜单 | 部分适配/需配置 | active/gainers/losers及显式条件筛选；未实现BOBBY专属Hot排序。 |
| F08 | 个股完整分析页 | 已实现/需配置 | research.stock聚合报价/公司/分析师/财务/新闻/技术指标；SMA/EMA/RSI/MACD有明确预热与价格口径。 |
| F09 | 宏观/行业事件分类 | 已实现 | research.events对输入资料分类Macro/Industry/Company/Unclassified，保留来源和时间；是本地启发式，不是商业算法复现。 |
| F10 | 财报日历 | 已实现/需配置 | `market.earnings`按日期范围查询和表格展示；数据订阅需验收。 |
| F11 | 每日个性简报 | 已实现本地持续简报/需配置 | 给定标的briefs.*及按券商固定快照的holdings.brief；HOLDINGS_BRIEF任务持续更新快照、研究和私有报告。需保持服务运行，无云端托管。 |
| F12 | 持仓风险与再平衡 | 已实现研究分析/需配置 | holdings.analyze按币种汇总已报告市值与集中度，未知不补零；原有portfolio.risk/rebalancePlan计算Greeks和再平衡情景，不自动改仓。 |
| F13 | 账户现金/持仓/订单/成交 | 已实现/需配置 | IBKR只读快照、独立本地Paper账户及3.3券商模拟订单回执；没有连接RockFlow Paper，真实IBKR账户尚需逐项核验。 |
| F14 | 期权候选 | 已实现/需配置 | Alpaca期权快照与`options.rank`显式筛选；不是自动完整Wheel交易推荐。 |
| F15 | 原生IV/Greeks | 部分适配/需配置 | 保留供应商原生字段与缺失/单位状态，另有独立定价引擎；未经核实的乘数、交割物、单位和数据时间不补猜。 |
| F16 | 用户Wheel规则 | 已实现 | 原账本保留；`wheel.analyze`按确认成本、严格CC门槛、股份预留和风险输入判断；情景结果不等于账户自动核对完成。 |
| F17 | CSP资金覆盖 | 已实现 | 聚合既有义务、候选、缓冲及费用；现金口径、币种或义务未确认时拒绝静默放行。 |
| F18 | Black–Scholes计算 | 已实现 | BS/CRR/IV/情景及options.strategy同到期日多腿损益、全局最大收益/损失、平衡点和组合Greeks；不包含跨期/提前行权模型。 |
| F19 | 去重账本计算 | 已实现 | 导入事件按稳定ID去重、冲突拒绝、按币种精确累计；不会自动记入原账本。 |
| F20 | 文件保存与回读 | 已实现 | CSV/JSON/文本/Markdown实际入库、校验、回读、下载和`report.save`；不是仅在回答中宣称保存。 |
| F21 | 研究组合卡 | 已实现 | plan.draft/list/get多轮保存投资目标、风险、期限、预算、排除与权重提案；plan.accept人工接受后保存研究组合，缺参和约束冲突明确返回。 |
| F22 | 月度再平衡回测 | 已实现/真实数据待配置 | 日频总回报序列、月度再平衡、成本、净值/回撤/Sharpe及基准；自动拉取历史要求完整复权数据。 |
| F23 | 年度复利与纠错 | 已实现 | 确定性年度计算及固定样例回归，模型不承担心算；fixture不是历史行情证据。 |
| F24 | AI组合产品联动/跟单 | 个人研究部分实现/平台部分不在本轮范围 | 个人计划、组合卡、回测和再平衡可用；自动托管跟单、策略市场、社交跟随及收益分成未实现。不得把个人范围排除解释为自动跟单已完成。 |
| F25 | Predict面板/榜单 | 已实现公开样本榜单/需配置 | predict.board按返回页排序成交量、低价或绝对涨跌；缺失涨跌不推算（Kalshi当前无24h涨跌）；不是全市场或BOBBY专有榜单。 |
| F26 | Kalshi/Polymarket切换 | 适配已实现/在线待验收 | 平台切换及固定GET适配；新增传输测试覆盖官方盘口字段。本轮未把合成传输成功标成线上实测，历史Kalshi403仍保留。 |
| F27 | Predict研究 | 已实现/需配置 | 市场规则、结果价格与Pi解释；价格不是客观概率或交易保证。 |
| F28 | 结果展开/价格阶梯 | 只读盘口适配已实现/在线待验收 | predict.orderbook抓取Kalshi固定小数盘口或Polymarket CLOB，校验市场/结果身份、价阶和单位；缺失源时间保持未知。predict.compare仍要求显式费用与主观公允值。 |
| F29 | 收藏增读删 | 已实现 | 本地watchlist持久化，添加幂等，删除需要当前版本及人类操作。 |
| F30 | 价格提醒 | 已实现/需配置 | 价格阈值、来源字段、时效和最小间隔、手动检查或独立进程轮询；退出应用后无云端服务。 |
| F31 | 通知中心 | 本地与浏览器通知已实现/云推送未实现 | 通知持久化、已读与私有范围过滤；设置中可显式启用本次浏览器桌面通知，不展示账户明细。邮件/短信/移动云推送未接入。 |
| F32 | 模拟订单预览 | 已实现 | 结构化草稿、期限和人工令牌确认；默认只预览，LOCAL_PAPER才可确认。 |
| F33 | 修改订单草稿 | 已实现本地草稿替换 | order.replaceDraft版本校验、事务中新建预览并取消旧DRAFT；已接受订单不原地修改，真实券商replace未接入。 |
| F34 | 条件单/止损止盈 | 本地条件持续监控已实现/券商原生条件未实现 | STOP_LIMIT/TAKE_PROFIT_LIMIT/OCO可由人工设任务持续检查报价；校验身份/币种/时点，触发仅生成待确认本地草稿。需要券商条件执行时仍不能自动下发。 |
| F35 | 真实买卖/撤单/FX/跟单 | 部分实现/待配置联调 | 3.3新增IBKR模拟账户单腿限价提交、警告逐次人工确认、查单与人工撤单；对话提取/澄清需求并展示确认卡。实盘、FX、换单、多腿和托管跟单未实现；不能把合成测试当券商成交。 |
| F36 | 多轮上下文 | 已实现/模型需配置 | 原生AgentSession/SessionManager保留自动压缩、重试、会话树和资源发现，按运行时设置启用；旧表“不自动压缩”的描述已纠正。 |
| F37 | 持久会话/刷新回读 | 已实现 | Pi SessionManager原生JSONL为模型上下文权威，SQLite维护应用索引/显示消息；刷新回读、进程恢复、原生导出。 |
| F38 | 会话改名 | 已实现 | 版本化`chat.update`与UI改名。 |
| F39 | 会话搜索 | 已实现 | SQLite先全库标题和正文过滤再分页，支持归档/回收站开关；非向量语义检索。 |
| F40 | 置顶/删除 | 已实现可恢复删除 | 置顶/取消置顶、归档/恢复、回收站/恢复；不提供不可恢复永久删除。 |
| F41 | 复制/编辑/反馈/分享 | 已实现本地适配 | 复制/评价/Markdown及原生JSONL导出、按原生消息ID编辑分支、本机限时可撤销分享快照；公网分享/多人协作尚未部署。 |
| F42 | 文件/图片输入 | 已实现/需配置 | 文本/CSV/JSON/JSONL/Markdown保存回读；图片签名与大小校验，须明确files授权，后续历史必须继续授权；图像理解取决于模型。 |
| F43 | 英文/简体/繁体 | 已实现基础三语 | 简体/英文/繁体导航及交互；领域描述部分由字表转繁体，接口字段/来源文本保留原文，尚无完整专业本地化审校。 |
| F44 | Pro注册/付费 | 本轮范围外 | 用户确认只做个人投资助手，不建设商业订阅、收费权益或BOBBY Pro账号联动。 |
| F45 | 账户关联/资料/登出/注销 | 本地能力已实现/商业账户范围外 | 本机认证、登出及本地资料编辑；RockFlow OAuth、多用户商业账号、平台注销流程未接入。 |
| F46 | 语音/移动端 | 部分适配 | 响应式独立Web、PWA manifest与仅静态资源缓存、用户启动浏览器语音输入/朗读（可能在线）；无原生App、离线ASR或私有数据离线缓存。 |

Order execution is limited to the human-confirmed IBKR paper workflow described in [conversational trading](conversational-trading.md). Funded-account execution and commercial services remain outside the current implementation.

## 3.4 实现增量

新增持仓/成交对账报告与逐笔后台订单跟踪。只读快照按人工账户映射和精确合约比较；订单跟踪调用查询接口，不能代替提交确认。原生运行时和期权能力继续复用。全历史现金流自动入账、税务成本、外部推送和真实账户验收仍未完成；不将本次增量表述为完整复制商业产品。详见 [对账与跟踪](reconciliation-and-monitoring.md)。

## 3.5 核对结论（2026-11-25）

目标已由用户确认：个人投资助手完整功能；不建设商业收费、多用户及原生App平台。本表覆盖已观察到的46项能力，不声称穷尽BOBBY未公开的后台功能，也不以官方宣传替代实测。

新增15项操作；详情见[个人助手技术设计](personal-assistant.md)。机器可读清单见[bobby-coverage.json](bobby-coverage.json)。单独保留待开发、待配置、范围外三个概念。

**还未实现的个人功能**：已提交券商订单原地修改、券商原生止损/OCO、多腿原子执行、FX和非美元执行、自动跟单、云端守护及移动推送。**已写适配但未完成真实联调**：模型、多源行情、IBKR PAPER、公开盘口。**范围外商业能力**：Pro付费、策略市场商业运营、多用户平台和原生App。

官方核对来源：[BOBBY指南](https://help.rockflow.ai/zh-Hans/docs/innvative-products/rockflow-bobby/)、[AI组合](https://help.rockflow.ai/zh-Hans/docs/innvative-products/ai-portfolio/)、[公开19项MCP工具](https://rockflow.ai/zh-Hans/mcp)。MCP是补充公开接口清单，本轮没有授权连接RockFlow账户或测试真实下单。原始2026-11-21黑盒测试中的未完成项保持历史原文。
