# 升级到交易研究工作台 2.0

> **历史兼容文档（2.0）**：以下保留旧Harness部署的版本语义，不是当前v3启动指引。v3已改为官方Pi AgentSession/SessionManager独立应用，使用`npm start`，不依赖Harness；当前部署与数据迁移见[升级到v3](upgrade-3.0.md)。旧适配器仍保留，但其会话宿主与存储不等同v3原生JSONL。

这是参考文档。2.0在原有两个Harness插件旁增加`@local/trading-workbench`，保留`options-trading`模式和原账本数据。`@local/options-ledger-dashboard`1.2.3只新增`/core`导出，账本格式仍为version2，不进行自动导入或重建。

新工作台位于“交易研究工作台”侧栏，新增`trading-research`模式。Harness原对话继续使用原模型配置；工作台自己的研究会话使用单独配置的Pi1.6.0。两者不是同一会话库，导出和历史在各自入口使用。

更新前应停止正在使用的账本服务并备份完整`DSH_HOME`，或使用SQLite备份机制。原安装器备份profile配置，不自动备份数据库。更新源码后运行`npm test`、`npm run check`、`npm run pack`，再按README安装三个包（安装器使用内容哈希命名的本地tarball，防止同路径同版本的pnpm缓存仍保留旧字节）；安装不会重启运行实例。

将根目录`config.example.json`复制到`$DSH_HOME/data/trading-workbench/config.json`，按[数据源配置](provider-setup.md)填写环境变量名称和账户范围。示例没有密钥、账户或已启用的外部数据源。配置改变后重新启动Host；不把配置文件或数据库提交到Git。

默认`READ_ONLY`：不接受模拟订单确认，更没有真实券商下单入口。`LOCAL_PAPER`只启用本地模拟订单簿，手工模拟成交不等于券商模拟账户成交，不自动改动原策略账本。DAY订单按纽约日期在下次检查/订单访问时过期；不是交易所日历或真实市场撮合。风险/冲突/平仓/DAY检查处理全部活跃订单，页面1000条上限不影响风控。期权到期日期UTC00:00禁止确认和新增模拟成交，不做行权/交割/结算，不支持0DTE盘中交易。本地模拟是通用资源检查，Wheel的`K>C`未接入确认。

新数据独立保存在`$DSH_HOME/data/trading-workbench/workbench.sqlite`，原账本仍在`$DSH_HOME/data/options-ledger/ledger.sqlite`。新schema版本1；不支持打开未来版本。停用新插件不删除旧账本；卸载或回退前保留两份数据库及WAL/SHM一致备份。2.0数据不能通过1.2.2插件读取。

新研究模式不挂载Shell或任意文件工具；默认只暴露市场、计算和预测市场工具。工作台Pi对话逐轮选择额外账户/账本/文件范围；已有私人范围历史必须当前会话重新全部允许，否则在发往模型之前阻止发送。此限制是应用工具权限，不是同一OS用户进程间的凭据文件隔离。

新增能力及仍未交付的产品功能见[BOBBY覆盖表](bobby-coverage.md)。真实券商交易、换汇、跟单、公共分享、外部通知投递及原生移动App不因升级而启用。
