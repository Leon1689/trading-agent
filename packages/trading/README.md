# @local/trading-workbench / Pi Trading Agent v3 领域模块

此目录包含Pi Trading Agent 3.3.0的共享业务层及历史Harness适配器。**当前主应用以官方Pi Coding Agent SDK 1.6.0独立运行**，从仓库根执行`npm start`；Harness不参与默认启动。完整安装与配置见[根README](../../README.md)。

## 当前原生应用

`apps/pi-trader/runtime.js`直接构造原`Ledger`、本目录`TradingService`与`createPiSessionRunner`。官方`AgentSession/SessionManager`负责模型循环和JSONL树历史；原生入口为`pi-session-runtime.js`，不能与保留的旧`pi-runtime.js`混淆。

业务目录共101项操作，提供期权/Greeks/Wheel、组合与回测、技术指标、研究聚合、预测市场比较、资料、会话、分享、提醒、本地模拟及条件草稿。自然语言调用需要显式配置模型，外部资料需要供应商/账户权限；本地计算不需要模型。

默认券商READ_ONLY，本地模拟执行关闭。LOCAL_PAPER使用独立虚拟账和人工模拟成交；条件/OCO触发只生成DRAFT。IBKR_PAPER提供独立的券商模拟执行适配，逐笔人工确认。实盘、FX、托管跟单、商业会员、互联网公共分享及原生App未实现。

| 文件 | 职责 |
|---|---|
| `service.js`、`catalog.js/extended-catalog.js` | 统一应用入口、目录/schema、actor/scope、审计与版本。 |
| `pi-session-runtime.js` | 官方AgentSession/SessionManager、受限customTools、原生恢复/分支/导出、预算与取消。 |
| `quant.js`、`research-features.js` | 确定性定价/风险/回测/技术指标/分类/再平衡与价阶比较。 |
| `providers.js` | 显式配置、固定供应商只读请求、来源/缺失标记。 |
| `trade-flow.js`、`ibkr-execution.js` | 券商模拟订单需求、预览、人工确认、警告和回执。 |
| `paper.js`、`conditional-paper.js` | 本地模拟订单与人类触发条件预览；不提交券商订单。 |
| `workspace-features.js` | 搜索/回收站/原生分支、临时本机分享、简报与资料。 |
| `storage.js`、`files.js` | 业务SQLite、revision/事务、文件导入、JSONL导出和事件复核。 |

独立HTTP接口为`GET /api/bootstrap`、`POST /api/operations`，认证由`apps/pi-trader/server.js`实现。模型工具使用同一目录，默认market/compute/predict；私人broker/ledger/files/portfolio逐轮明确授予，历史所需范围不得默默撤销后继续发送。模型不能确认订单、撤单、记录模拟成交或修改凭据。

独立数据位于`<PI_TRADER_HOME>/workbench.sqlite`、`ledger.sqlite`和`sessions/*.jsonl`。JSONL是上下文权威，业务库piMessages仅作旧历史首次迁移/兼容缓存。原账本不由快照或文件导入自动改写。

## 历史兼容适配器

`integration.js`、`agent.js`、`client.js`、`runtime.js`、`pi-runtime.js`及Cordis补丁保留原Harness部署用途；发布包入口仍兼容Host/Agent/Client导出。其API为`GET/POST /api/trading-workbench`，配置与数据库仍位于旧`DSH_HOME`，使用旧运行器而非新的独立原生会话宿主。

兼容部署需要原Harness及账本`/core`导出，Host Cordis条目使用裸包名`@local/trading-workbench`以便旧客户端发现。`npm run pack`和根`install:harness`只用于该路径，不用于安装完整独立应用；单独发布本包也不打包`apps/pi-trader`和根SDK依赖。

## 文档与验证

- [架构](../../docs/architecture.md)、[完整技术设计](../../docs/technical-design.md)、[101项接口](../../docs/api-catalog.md)。
- [使用](../../docs/workbench-usage.md)、[部署/迁移](../../docs/upgrade-3.0.md)、[2.0历史兼容](../../docs/upgrade-2.0.md)。
- [计算契约](quant.md)、[新增研究与条件契约](../../docs/research-features.md)、[数据源配置](../../docs/provider-setup.md)。
- [BOBBY覆盖及缺口](../../docs/bobby-coverage.md)、[验证记录](../../docs/verification.md)。

根目录`npm test`包含旧账本、业务、官方Pi SDK和独立应用测试，`npm run check`检查语法/manifest。原生Pi测试只替换provider传输事件，实际运行框架会话和树存储；这不能替代真实模型、行情、券商或全部BOBBY功能验收。

原生文件、Shell和资源配置见[Pi能力说明](../../docs/pi-native-capabilities.md)。


## 3.3 对话交易入口

新增独立IBKR模拟执行配置和人工确认流程；原查询provider保持只读。配置、订单状态、支持范围和待联调项见[对话交易设计](../../docs/conversational-trading.md)。请勿将LOCAL_PAPER与券商PAPER混用。
