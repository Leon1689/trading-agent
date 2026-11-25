# 部署与迁移到 Pi Trading Agent v3

v3默认运行于官方Pi SDK，`npm start`直接启动独立应用，不需要安装或运行Harness。旧领域逻辑和插件适配器保留，用户数据不会因安装源码自动迁移。默认券商READ_ONLY，模型、供应商及后台轮询默认未启用。

## 新部署

使用Node.js 26，先在仓库根安装锁定依赖：

```sh
npm ci --ignore-scripts
node apps/pi-trader/cli.js init --home /absolute/path/pi-trader-data
npm run doctor -- --home /absolute/path/pi-trader-data
npm start -- --home /absolute/path/pi-trader-data --port 3100
```

打开本次启动输出的`http://127.0.0.1:3100/auth?token=…`。服务只监听loopback。`--home`优先于`PI_TRADER_HOME`，两者未设时使用当前目录的`.pi-trader`；不同目录是不同应用数据集。`init`只创建缺失配置，不覆盖已有文件。

默认本地账本、计算和资料可直接用；开启自然语言需明确配置模型及密钥环境变量，外部行情和账户另需相应配置/订阅。[数据源说明](provider-setup.md)介绍适配器契约；v3配置实际路径为`<home>/config.json`。不要把真实密钥或账户数据提交源码。

## 从已有2.0数据库迁移

迁移器只复制明确选择的旧`DSH_HOME`，不扫描其他位置、不写旧数据库、不复制密钥。源必须同时存在：

```text
<old DSH_HOME>/data/options-ledger/ledger.sqlite
<old DSH_HOME>/data/trading-workbench/workbench.sqlite
```

目标必须是尚不存在的新目录。**先迁移，再init**；提前启动、doctor或init可能创建目录，迁移器会拒绝覆盖。仅有1.x旧账本、没有workbench库时不满足自动迁移条件，应从独立空应用通过既有账本JSON导出/导入流程核对迁移，不能伪造空源库后声称完成完整迁移。

建议先结束原应用中的会话和写操作并停止原实例，以取得两库之间一致的业务时点，再执行：

```sh
node apps/pi-trader/cli.js migrate --from-harness /absolute/path/old-dsh-home --home /absolute/path/new-pi-trader-data
node apps/pi-trader/cli.js init --home /absolute/path/new-pi-trader-data
npm start -- --home /absolute/path/new-pi-trader-data --port 3100
```

实现通过Node SQLite backup API逐库生成一致副本，执行`PRAGMA quick_check`，在目标旁临时目录完成后一次rename发布。失败清理临时目录，已有目标拒绝覆盖。逐库备份不等于两数据库跨库原子快照，因此迁移前停止旧写操作仍有意义；不能用直接复制活动`.sqlite`主文件替代此流程。

迁移结果为：

| 数据 | v3位置/行为 |
|---|---|
| 原策略账本 | `<home>/ledger.sqlite`；复用原Ledger核心、账本格式和确认规则，不自动重算成本。 |
| 原工作区 | `<home>/workbench.sqlite`；保留研究对象和UI会话，业务schema仍为1。 |
| 模型历史 | 首次进入新运行器时，从该会话已保存的旧piMessages导入一次，之后`<home>/sessions/*.jsonl`权威。 |
| 供应商/模型配置 | 不从旧目录复制；新config.json按实际需要显式填写，环境变量重新提供。 |
| 已有认证会话 | 不迁移；使用新进程认证链接。 |

先核对持仓数量、N/P/Q、净权利金、交易/交割记录、修改提案、文件、模拟订单和会话数量，再使用新应用。旧原始数据库保留为回退依据；新库的后续变更不会反向同步到旧部署。

旧UI消息不一定带原生entryId。迁移后已追加的当前会话消息会绑定真正的Pi节点；对尚未绑定且需要保留前文的旧消息编辑，应用会返回`PI_FORK_REQUIRED`，不会按UI下标猜测或丢弃历史。普通继续会话和新建空会话不要求伪造该映射。

## 数据备份、恢复与退出

```text
<home>/config.json
<home>/ledger.sqlite
<home>/workbench.sqlite
<home>/sessions/*.jsonl
```

备份需包含两库和原生会话。停止应用后保存整个数据目录，或为数据库使用可靠SQLite备份机制；运行中仅复制主库而遗漏WAL/SHM可能不是一致快照。当前没有云备份、加密归档或自动保留功能。

正常SIGINT/SIGTERM会取消服务请求和调度并关闭资源。硬退出留下RUNNING会话时，等租约到期后在人类界面核对既有结果，再恢复；不自动重试旧问题。原生历史遗漏toolResult会标记UNKNOWN，不重放工具。损坏JSONL会被拒绝，恢复时保留损坏副本并使用核实的备份，不随意删行“修复”。

分享token和原生会话可包含私人研究材料。分享只在本机地址可访问、支持到期与撤销，不因为备份或PWA安装变成公网可读。语音是浏览器能力，可能使用网络服务；PWA不是离线模型/交易后台。

## 验证与启用顺序

```sh
npm test
npm run check
```

先验收本地账本、计算、文件、认证和原生会话。之后配置模型，再配置券商只读账户和市场资料；每项能力单独核对真实返回，不把配置检查、合成fixture、API契约测试或源码存在当成真实账户验收。

需本地模拟时可以在独立演练数据目录用`--paper`，或明确`execution.mode=LOCAL_PAPER`。仍没有真实券商执行；条件触发只生成草稿，人工确认/成交只影响虚拟账。正式首次账户接入保留READ_ONLY。

## 历史Harness兼容入口

`packages/trading/integration.js/agent.js/client.js/runtime.js/pi-runtime.js`、Cordis补丁、`scripts/install.mjs`和打包脚本保留，服务于旧Harness部署。旧配置路径仍是`$DSH_HOME/data/trading-workbench/config.json`，旧API仍是`/api/trading-workbench`，旧会话使用原适配器缓存；不会自动升级为新的AgentSession JSONL权威模型。

需要维护旧部署时可参照[2.0历史说明](upgrade-2.0.md)及原包README；`npm run pack`仍产出兼容包。主程序从仓库根运行，`install:harness`不是v3必需步骤。不要将旧profile中运行的产品、旧浏览器界面或旧AgentCore测试称为当前原生Pi宿主验收。

真实执行、FX、跟单、会员计费、公共分享、外部推送、原生移动端与多用户部署未因迁移而启用。当前范围见[技术设计](technical-design.md)及[BOBBY覆盖表](bobby-coverage.md)。

## 3.1 增量升级：恢复官方四工具

升级保留原数据库与JSONL格式；无需迁移账本。新computer配置缺省即注册read/bash/edit/write，调用仍需localRead/localWrite/shell逐轮授权；broker只读状态不变。工具工作目录与应用数据/源码分离。CLI tools输出改为包含computer和domainOperations的对象。

可选官方Pi扩展增加四个工具；extension.allowedComputerScopes单独授权。macOS沙箱不可用时明确拒绝执行，不回落到无限制Shell。配置和限制详见技术设计；实际模型仍按原流程配置。

## 3.2 增量升级：保留全部Pi原生能力入口

SDK锁定1.6.0不变，无数据库schema迁移。新增`pi.native`配置；旧配置未填写时，资源发现和官方默认自动压缩/重试恢复启用，cache warming继承官方idle（示例配置为off）。真实模型未配置仍不调用。使用Web发现到私人资源须授予resources，旧会话必须重新满足历史scope。

原生模式：`npm run native -- --home /absolute/path/data --scopes compute,resources --`。默认独立`<home>-pi`存原生会话、配置和模型认证；Web原生JSONL仍在`<home>/sessions`，不自动合并两套会话。备份时同时保留所用Pi资源目录。配置、网络/MCP/本机端口授权和完整能力清单见[pi-native-capabilities.md](pi-native-capabilities.md)。不自动安装扩展、不读取已有用户密钥、不调用券商。
