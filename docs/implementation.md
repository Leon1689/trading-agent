# trading agent 工程说明

项目将自然语言研究、确定性计算、策略账本和券商模拟订单组织在同一应用中。核心业务代码位于 `packages/trading`、`packages/ledger` 和 `apps/trading-agent`；通用 Agent 运行时作为外部依赖接入。

## 一次交易需求如何流转

1. 对话工具把用户明确提供的字段保存为交易需求，返回缺失字段；未确定的账户、数量、价格或合约不会由程序补成可执行事实。
2. 合约查询取得标识，准备步骤执行输入、持仓、挂单和规则检查，再向模拟 Gateway 请求 what-if。
3. 成功预览保存版本、有效期和摘要。字段修改使旧预览失效，避免确认的订单与用户看到的订单不一致。
4. 人工界面发起核对并获取短期确认凭证；模型工具集没有核对和提交接口。
5. 提交前先持久化状态，再发送请求。警告进入二次确认；超时或模糊响应进入待核对状态，不自动重发。

主要代码：[交易状态机](../packages/trading/trade-flow.js)、[券商协议适配](../packages/trading/ibkr-execution.js)、[确认界面](../apps/trading-agent/web/trades.js)。完整状态与参数见[对话交易设计](conversational-trading.md)。

## 模型与计算的分工

模型负责提取需求、选择已授权工具和解释返回结果。定价、Greeks、成本与约束由程序按显式输入计算，结果保留单位、方法版本和输入口径。

策略账本以整数分保存金额，计算与记账分开。`C=(N-P)/Q` 是项目的策略成本口径；拟收权利金不提前冲减成本。模型生成的提案不会自动成为已确认持仓或现金流。

代码与验证：[计算模块](../packages/trading/quant.js)、[计算回归](../packages/trading/test/quant.test.js)、[账本核心](../packages/ledger/ledger.js)、[账本回归](../packages/ledger/test/ledger.test.js)。

## 权限与数据边界

`TradingService` 统一处理参数校验、调用方身份、数据范围和审计。调用方身份由宿主绑定，不能通过工具 JSON 提升。对话历史已包含的私人数据也要求重新授权。

文件读取、修改、Shell、项目资源、券商查询和交易准备分别授予权限。通用文件/Shell工具使用依赖提供的实现，应用增加工作目录和进程隔离。只读数据适配器与模拟执行适配器独立配置。

代码与验证：[服务入口](../packages/trading/service.js)、[文件/Shell边界](../packages/trading/computer-tools.js)、[权限回归](../packages/trading/test/service.test.js)、[隔离回归](../packages/trading/test/computer-tools.test.js)。

## 存储与恢复

业务 SQLite 保存版本化记录及审计；策略账本独立保存。运行时 JSONL 保存对话树，应用记录其业务投影。修改历史问题会创建分支，中断恢复不会自动重放上一次请求。

订单状态在外部写入前持久化，便于重启后查询未知结果。不同券商端点的持仓和挂单读取不是原子快照，客户端订单编号也不等于券商提供 exactly-once 保证。

## 实现边界

| 类别 | 范围 |
|---|---|
| 应用代码 | 交易流程、权限、计算、账本、业务存储、数据适配、Web/CLI工作台及测试 |
| 外部运行时 | 通用模型循环、流式事件、会话树、压缩、重试、通用工具、扩展和终端协议 |
| 外部服务 | 模型推理、市场数据、券商认证、what-if 和券商模拟执行 |

外部运行时的具体包、版本和复用关系见[运行时集成](runtime-integration.md)及[第三方声明](../THIRD_PARTY_NOTICES.md)。

本地测试使用实际运行时与合成模型/券商响应。它们验证集成和状态边界；真实模型、行情权益及 IBKR 模拟账户仍需配置后验收。真实资金下单、复杂多腿执行、自动对账和非 macOS 隔离后端尚未实现。完整验证范围见[验证说明](verification.md)。
