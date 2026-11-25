# Pi Trading Agent

[English](README.en.md) · [使用指南](docs/workbench-usage.md) · [架构](docs/architecture.md) · [接口目录](docs/api-catalog.md)

基于 [Pi Coding Agent](https://github.com/earendil-works/pi) 的本地交易研究工具。把期权计算、策略账本、市场研究和 IBKR 模拟订单放在同一个工作台，通过对话组织工具调用。

Pi 负责理解需求和解释结果；Greeks、成本与风险约束由程序计算。券商订单必须在界面中逐笔确认，模型没有提交权限。

## 功能

- **期权与策略**：Black–Scholes / CRR 定价、IV、Greeks、情景分析、CC / CSP 覆盖检查。
- **策略账本**：按标的保存持仓和期权净现金流，处理部分行权，使用整数分记录金额。
- **研究工作台**：财务、新闻、技术指标、组合回测、预测市场比较、报告与本地提醒。
- **对话交易**：提取需求、追问缺参、查询合约、取得 what-if 预览，由用户确认后向 IBKR 模拟账户提交。
- **Pi 原生能力**：保留 `read`、`bash`、`edit`、`write`、资源发现、自动压缩、重试、会话树；TUI、扩展、MCP 和 RPC 使用独立原生入口。

共有 101 项业务操作；57 项可按权限范围提供给模型，44 项仅供用户操作。Pi 原生工具另外管理。

## 快速开始

完整功能和测试环境为 **macOS + Node.js 26**。文件、Shell 和原生 CLI 的隔离依赖 macOS `sandbox-exec`；其他平台的隔离后端尚未实现。

```sh
git clone https://github.com/Leon1689/pi-trading-agent.git
cd pi-trading-agent
npm ci --ignore-scripts

node apps/pi-trader/cli.js init --home "$HOME/.local/share/pi-trader"
npm start -- --home "$HOME/.local/share/pi-trader" --port 3100
```

打开终端输出的本机认证链接。默认不启用模型和外部数据源，本地计算、账本和文件功能可直接使用。

配置文件位于所选数据目录的 `config.json`。密钥通过环境变量读取，不写入仓库；环境变量示例见 [.env.example](.env.example)，应用不会自动加载 `.env`。

## 选择运行模式

| 模式 | 用途 | 订单行为 |
|---|---|---|
| `READ_ONLY` | 研究、计算、账本和券商查询 | 不向券商提交订单 |
| `LOCAL_PAPER` | 本地模拟订单簿 | 人工记录模拟成交，不连接券商撮合 |
| `IBKR_PAPER` | IBKR 券商模拟账户 | 仅允许指定 DU 账户，每次提交与警告回复都需人工确认 |

真实资金账户、FX、托管跟单和复杂多腿执行尚未提供。IBKR 适配器已实现协议流程，测试使用合成响应；真实模型、账户、行情订阅需自行配置和验收。配置方法见[数据源](docs/provider-setup.md)和[对话交易](docs/conversational-trading.md)。

## 使用 Pi

```sh
# 检查配置与能力，不自动连接账户
npm run doctor -- --home "$HOME/.local/share/pi-trader"

# 配置模型后，使用交易 CLI
npm run agent -- --home "$HOME/.local/share/pi-trader" "计算这份期权的 Delta"

# 官方原生入口；权限由本次启动显式指定
npm run native -- --home "$HOME/.local/share/pi-trader" --scopes compute,resources --
```

原生入口沿用 Pi 的 TUI、print、JSON、RPC、扩展与 MCP。Web 和原生入口使用独立的会话/资源目录；完整配置见 [Pi 能力说明](docs/pi-native-capabilities.md)。

## 目录

```text
apps/pi-trader/       独立 Web / CLI 应用
packages/trading/    业务服务、Pi 适配、研究与执行模块
packages/ledger/     策略账本与兼容适配
packages/preset/     历史 Harness preset，保留迁移兼容
.pi/extensions/     可选 Pi 扩展入口
docs/                架构、配置、接口和验证说明
examples/            无凭据的计算与配置示例
scripts/             检查、打包和兼容安装脚本
.github/             CI、问题模板和贡献入口
```

默认启动链路直接使用官方 `@earendil-works/pi-coding-agent@1.6.0`，不依赖 Harness。历史适配与数据迁移见[迁移说明](docs/upgrade-3.0.md)。

## 开发

```sh
npm run check
npm run check:publication
npm test
node examples/option-pricing.mjs
```

测试覆盖计算、账本、权限、真实 Pi SDK 工具循环、会话持久化以及受控券商协议。测试边界见[验证说明](docs/verification.md)。提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 文档

- [技术设计](docs/technical-design.md)：模块、数据结构、权限与状态。
- [原版 Pi 与交易应用对照](docs/pi-architecture-comparison.md)：复用与新增部分。
- [功能覆盖](docs/bobby-coverage.md)：研究、交易与产品功能的支持范围。
- [安全说明](SECURITY.md)：数据目录、权限和问题报告。
- [路线图](docs/roadmap.md)：外部联调、对账与平台支持。

## 许可

本项目采用 [MIT License](LICENSE)。Pi 的原作者署名和许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目独立维护，不隶属于 Pi、IBKR 或 RockFlow。
