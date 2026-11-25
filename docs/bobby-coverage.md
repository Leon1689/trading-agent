# Feature coverage

The matrix tracks research and trading workflows, including features compared with the publicly observable BOBBY product. It is not a statement of API compatibility, affiliation, or complete product equivalence. “Implemented” describes a code path; externally configured services still require validation.

| ID | 参照功能 | 当前状态 | 本项目对应实现与缺口 |
|---|---|---|---|
| F01 | Finance首页快捷入口 | 已实现 | 独立 Finance 总览、研究/期权/组合/Predict 四类快捷卡、预置研究问题；不是复刻品牌视觉。 |
| F02 | Hot Trades事件卡 | 部分适配/需配置 | 来源新闻卡、research.events本地透明启发式分类/去重；不声称复制BOBBY专属30卡热点与打分算法。 |
| F03 | Stock Picks预置问题 | 已实现/需配置 | 首页预置研究问题与行情筛选、榜单入口；自然语言回答需要显式配置模型。 |
| F04 | 双股票比较 | 已实现/需配置 | `research.compare`聚合1–8标的资料，Pi可研究解释；真实财务源和模型需配置。 |
| F05 | 财报研究 | 已实现/需配置 | `market.financials`三表与比率、分析师字段、Pi解释；数据权限和时点需验收。 |
| F06 | 交互财务图表 | 已实现/需配置 | 财务指标选择与交互SVG图、结构化表格、回测净值/回撤图；缺数据不画伪曲线。 |
| F07 | 股票榜单 | 部分适配/需配置 | active/gainers/losers及显式条件筛选；未实现BOBBY专属Hot排序。 |
| F08 | 个股完整分析页 | 已实现/需配置 | research.stock聚合报价/公司/分析师/财务/新闻/技术指标；SMA/EMA/RSI/MACD有明确预热与价格口径。 |
| F09 | 宏观/行业事件分类 | 已实现 | research.events对输入资料分类Macro/Industry/Company/Unclassified，保留来源和时间；是本地启发式，不是商业算法复现。 |
| F10 | 财报日历 | 已实现/需配置 | `market.earnings`按日期范围查询和表格展示；数据订阅需验收。 |
| F11 | 每日个性简报 | 已实现/需配置 | briefs.*保存给定标的周期简报，按需运行或启用进程内调度；本地报告与通知入库。无持久在线端推送。 |
| F12 | 持仓风险与再平衡 | 已实现本地预览 | portfolio.risk与Greeks、portfolio.rebalancePlan精确金额/费用/目标权重/现金约束；再平衡只出计划，不调仓真实账户。 |
| F13 | 账户现金/持仓/订单/成交 | 已实现/需配置 | IBKR只读快照、独立本地Paper账户及3.3券商模拟订单回执；没有连接RockFlow Paper，真实IBKR账户尚需逐项核验。 |
| F14 | 期权候选 | 已实现/需配置 | Alpaca期权快照与`options.rank`显式筛选；不是自动完整Wheel交易推荐。 |
| F15 | 原生IV/Greeks | 部分适配/需配置 | 保留供应商原生字段与缺失/单位状态，另有独立定价引擎；未经核实的乘数、交割物、单位和数据时间不补猜。 |
| F16 | 用户Wheel规则 | 已实现 | 原账本保留；`wheel.analyze`按确认成本、严格CC门槛、股份预留和风险输入判断；情景结果不等于账户自动核对完成。 |
| F17 | CSP资金覆盖 | 已实现 | 聚合既有义务、候选、缓冲及费用；现金口径、币种或义务未确认时拒绝静默放行。 |
| F18 | Black–Scholes计算 | 已实现 | 确定性BS、CRR、IV求根、Greeks和情景；显式模型假设与单位。 |
| F19 | 去重账本计算 | 已实现 | 导入事件按稳定ID去重、冲突拒绝、按币种精确累计；不会自动记入原账本。 |
| F20 | 文件保存与回读 | 已实现 | CSV/JSON/文本/Markdown实际入库、校验、回读、下载和`report.save`；不是仅在回答中宣称保存。 |
| F21 | 研究组合卡 | 已实现 | `portfolio.save/list/get`保存权重与说明，UI显示结构化结果；用途RESEARCH_ONLY。 |
| F22 | 月度再平衡回测 | 已实现/真实数据待配置 | 日频总回报序列、月度再平衡、成本、净值/回撤/Sharpe及基准；自动拉取历史要求完整复权数据。 |
| F23 | 年度复利与纠错 | 已实现 | 确定性年度计算及固定样例回归，模型不承担心算；fixture不是历史行情证据。 |
| F24 | AI组合产品联动/跟单 | 未实现 | 本地研究组合不连接RockFlow产品，不提供一键跟单、托管或复制交易。 |
| F25 | Predict面板/榜单 | 部分适配/需配置 | 市场发现及详情、predict.compare按明确深度/费用/主观公允值比较，卡片和平台切换；无BOBBY专属movers榜单。 |
| F26 | Kalshi/Polymarket切换 | 已实现/网络待验收 | 显式platform选择并标准化两源；当前仅Polymarket公开样本实测成功，Kalshi访问返回403。 |
| F27 | Predict研究 | 已实现/需配置 | 市场规则、结果价格与Pi解释；价格不是客观概率或交易保证。 |
| F28 | 结果展开/价格阶梯 | 部分适配 | 支持显式输入的结果深度与分档VWAP/费用比较；实时CLOB深度抓取未实现，不能把输入计算当作实时订单簿。 |
| F29 | 收藏增读删 | 已实现 | 本地watchlist持久化，添加幂等，删除需要当前版本及人类操作。 |
| F30 | 价格提醒 | 已实现/需配置 | 价格阈值、来源字段、时效和最小间隔、手动检查或独立进程轮询；退出应用后无云端服务。 |
| F31 | 通知中心 | 部分适配 | 本地通知持久化与已读状态；邮件、短信、移动推送及外部投递未实现。 |
| F32 | 模拟订单预览 | 已实现 | 结构化草稿、期限和人工令牌确认；默认只预览，LOCAL_PAPER才可确认。 |
| F33 | 修改订单草稿 | 已实现本地草稿替换 | order.replaceDraft版本校验、事务中新建预览并取消旧DRAFT；已接受订单不原地修改，真实券商replace未接入。 |
| F34 | 条件单/止损止盈 | 已实现本地条件预览 | STOP_LIMIT/TAKE_PROFIT_LIMIT/OCO、报价时效/合约/单位校验、事件幂等；触发仅生成DRAFT，需人工确认且仅LOCAL_PAPER可模拟执行。无自动实盘。 |
| F35 | 真实买卖/撤单/FX/跟单 | 部分实现/待配置联调 | 3.3新增IBKR模拟账户单腿限价提交、警告逐次人工确认、查单与人工撤单；对话提取/澄清需求并展示确认卡。实盘、FX、换单、多腿和托管跟单未实现；不能把合成测试当券商成交。 |
| F36 | 多轮上下文 | 已实现/需配置 | 官方Pi AgentSession完整上下文和工具记录，模型配置后使用；不自动压缩或丢弃历史，超预算明确失败。 |
| F37 | 持久会话/刷新回读 | 已实现 | Pi SessionManager原生JSONL为模型上下文权威，SQLite维护应用索引/显示消息；刷新回读、进程恢复、原生导出。 |
| F38 | 会话改名 | 已实现 | 版本化`chat.update`与UI改名。 |
| F39 | 会话搜索 | 已实现 | SQLite先全库标题和正文过滤再分页，支持归档/回收站开关；非向量语义检索。 |
| F40 | 置顶/删除 | 已实现可恢复删除 | 置顶/取消置顶、归档/恢复、回收站/恢复；不提供不可恢复永久删除。 |
| F41 | 复制/编辑/反馈/分享 | 已实现本地适配 | 复制/评价/Markdown及原生JSONL导出、按原生消息ID编辑分支、本机限时可撤销分享快照；公网分享/多人协作尚未部署。 |
| F42 | 文件/图片输入 | 已实现/需配置 | 文本/CSV/JSON/JSONL/Markdown保存回读；图片签名与大小校验，须明确files授权，后续历史必须继续授权；图像理解取决于模型。 |
| F43 | 英文/简体/繁体 | 已实现基础三语 | 简体/英文/繁体导航及交互；领域描述部分由字表转繁体，接口字段/来源文本保留原文，尚无完整专业本地化审校。 |
| F44 | Pro注册/付费 | 未实现 | 个人本地项目没有订阅、付费权益或BOBBY Pro账户联动。 |
| F45 | 账户关联/资料/登出/注销 | 部分适配 | 独立本机启动令牌、HttpOnly会话、登出与本地资料编辑；没有RockFlow OAuth、商业多用户账号/注销流程。 |
| F46 | 语音/移动端 | 部分适配 | 响应式独立Web、PWA manifest与仅静态资源缓存、用户启动浏览器语音输入/朗读（可能在线）；无原生App、离线ASR或私有数据离线缓存。 |

Order execution is limited to the human-confirmed IBKR paper workflow described in [conversational trading](conversational-trading.md). Funded-account execution and commercial services remain outside the current implementation.
