# Pi native capabilities

Application 3.3.0 uses the official Pi Coding Agent 1.6.0 runtime. Native settings and commands are retained through configurable entry points. The Web UI and isolated native CLI have distinct loading and permission boundaries. Machine-readable settings are in [pi-native-capabilities.json](pi-native-capabilities.json).

## 逐项能力与差异

标记：🟦原生复用、🟨装配/配置调整、🟩交易新增、🟪原账本复用、⬜需授权/待联调/未实现。没有修改官方内核；不会自动把所有权限打开。

| 能力 | 当前入口和配置 | 验证与限制 |
|---|---|---|
| Agent循环、流式事件、工具执行 | 🟦两入口官方AgentSession/Core | 实际SDK和官方CLI执行；模型传输合成 |
| JSONL历史、恢复、树、分支、标签、会话选择 | 🟦SDK恢复/分支/导出；原生`/tree`、`/fork`、`--resume`、`--continue` | 原JSONL回归、RPC get_tree；原生会话与Web会话分开存储 |
| 自动压缩、手动压缩、分支摘要 | 🟨`native.settings.compaction`；默认继承官方enabled=true；原生`/compact` | 实测token阈值自动压缩和应用消息阈值压缩，保留JSONL原文；分支摘要外部模型待联调 |
| 自动重试、provider重试、退避 | 🟨`retry`、`providerRetry`；继承官方默认 | 实测503后恢复；SDK调用预算与总超时仍有效，provider内部HTTP重试受其设置控制 |
| 思考档位与预算 | 🟨`defaultThinkingLevel`、`thinkingBudgets`；未指定继承medium（受模型能力限制） | 实际SDK high；无真实推理模型联调 |
| AGENTS/SYSTEM/APPEND_SYSTEM、Skills、技能命令、提示模板 | 🟨DefaultResourceLoader；`resources.*`；`enableSkillCommands`、`expandPromptTemplates` | 实测发现、模板参数、resources授权及历史再授权；Web仅加载允许目录的文本资源 |
| 主题、键位、编辑器、终端图像、剪贴板 | 🟦原生TUI `/settings`、主题文件、keybindings；`terminal`、`images`、编辑器设置；`permissions.clipboard` | 实际TUI启动及设置面板；图像/剪贴板/外部编辑器逐项设备测试未做 |
| 扩展、事件hook、自定义工具/模型/命令/UI | 🟦官方CLI自动发现、`--extension`、`/reload`；`resources.extensions` | 用户扩展、命令、自定义provider与交易/文件工具实测共存；Web宿主不直接执行扩展 |
| npm/git/local Pi包及包管理 | 🟦原生`install/update/remove/list/config`和`settings.packages` | 保留原命令；安装须授予资源写、进程与网络；联网安装需单独验证 |
| MCP stdio/HTTP、认证、资源、工具暴露 | 🟦`mcp.json`、原生命令、`resources.mcp` | 真实本地stdio MCP echo实测；远程HTTP/OAuth需网络/回调授权，未登录真实服务 |
| codemode、tool_search、动态工具 | 🟦`defaultTools:["+codemode","+tool_search"]`或官方CLI工具选项 | codemode嵌套调用真实交易计算通过；tool_search保留官方注册/选择机制，未做搜索排序专项评测 |
| read/bash/edit/write | 🟦官方工厂+🟨权限包装；Web默认四个 | 原真实文件/Shell回归通过 |
| grep/find/ls/powershell | 🟦Web `native.tools`显式选择；原生`defaultTools`或`--tools` | grep/find/ls实测；powershell工厂保留，当前Mac无pwsh，⬜需安装依赖与实测 |
| 模型供应商、自定义models、切换/路由 | 🟦原生models.json/`/model`/CLI；Web仍显式provider/model | 原生自定义provider实测；真实多供应商待联调 |
| API key、OAuth、登录登出 | 🟦原生独立资源目录auth.json、`/login`、`/logout`与auth命令 | 不继承券商凭据；模型key可显式转交；OAuth回调监听已测，真实登录未测 |
| steering、follow-up、排队、中断 | 🟦原生TUI/RPC队列；`steeringMode/followUpMode` | RPC设置命令实测；Web未复制队列交互 |
| TUI、print、JSON、RPC、命令行参数 | 🟦`npm run native -- [应用参数] -- [官方参数]` | TUI启动/settings、JSON工具循环、RPC状态/树/命令、version/help通过 |
| HTML/JSONL导出、会话分享 | 🟦原生export/share命令；Web现有JSONL和本机分享 | 原导出回归；外部分享须用户主动命令及网络权限，未上传任何会话 |
| cache warming、transport、缓存设置 | 🟨`cacheWarming`、`transport`、`websockets`等原schema | 参数送达SDK；官方默认idle，config.example显式off，可改；真实缓存计费/性能未测 |
| 设置优先级、项目配置、项目信任 | 🟦61个官方顶层设置键完整校验；原生全局/项目配置与trust保留 | Web `settingsSource:memory/files`；原生始终官方文件设置；Web不执行任意扩展 |
| CLI环境变量、平台与终端行为 | 🟨`native.environment`接收Pi专属字符串旗标；原生参数透传 | 资源路径由agentDir管理；交易隔离启动器当前仅macOS，⬜Linux/Windows隔离后端未实现 |

上述“保留”指用户可以使用官方实现或配置入口，不代表所有付费服务、设备、上游每一种组合都完成端到端验收。Pi本身没有内置的通用plan mode/subagent编排，不将这类扩展方向写成被本项目删除的原生能力。Chord/pi-durable等同仓其他产品也不等于Coding Agent自身功能。

## 配置与数据结构

配置仍在`<app-home>/config.json`，启动读取；修改后重启。`pi.native.settings`直接遵循锁定版本的官方schema，未知字段/非法类型报`PI_NATIVE_CONFIG_ERROR`；没有自己维护一份删减的设置白名单。UI能力页展示配置来源和能力，不是全部设置的编辑器。完整默认值见官方settings文档，机器清单保存61个键和各自schema。

```json
{
  "execution": {"mode": "READ_ONLY"},
  "pi": {
    "native": {
      "agentDir": null,
      "settingsSource": "memory",
      "settings": {
        "compaction": {"enabled": true},
        "retry": {"enabled": true},
        "defaultThinkingLevel": "medium",
        "cacheWarming": "off"
      },
      "resources": {
        "enabled": true, "contextFiles": true, "skills": true,
        "prompts": true, "themes": true, "extensions": true, "mcp": true,
        "skillPaths": [], "promptPaths": [], "themePaths": [], "extensionPaths": []
      },
      "tools": ["read", "bash", "edit", "write"],
      "expandPromptTemplates": true,
      "environment": {},
      "permissions": {
        "readPaths": [], "writePaths": [], "network": [],
        "loopbackListenPorts": [], "processExecution": false, "clipboard": false
      }
    }
  }
}
```

- `settingsSource:memory`用于Web，避免自动继承个人凭据；`files`启用指定agentDir和工作目录的官方SettingsManager配置读取，再应用显式settings。Web实际加载的settings在会话启动解析；能力页显示应用启动时加载的设置快照，修改文件后重启以刷新显示。
- 原生CLI总是使用其官方文件设置、项目优先级与trust。启动器把显式`settings`写入独立资源目录settings.json；TUI临时修改若与显式配置冲突，下次启动按配置重新覆盖。未填写的原生设置保持原文件值。
- `agentDir:null`：Web为`<app-home>/sessions-resources`，原生为`<app-home>-pi`。设置同一个显式外部目录可共享资源；默认不会扫描用户真实`~/.pi`。需要使用既有资源时配置绝对agentDir或路径授权，不把整个用户主目录授权给原生进程。
- `resources.enabled`总开关与各分类开关同时约束自动发现及显式路径。官方CLI参数放在最后，用户明确传入的参数仍按官方语义覆盖。交易桥接扩展始终显式载入，不受“用户扩展发现”开关移除。
- `native.tools`是Web工具选择；原生入口使用官方`defaultTools`/`--tools`。工具存在和执行权限分别管理：`localRead`、`localWrite`、`shell`、`resources`互相独立。资源历史在`trading.scope.v1`中累计，撤掉资源授权不能直接重发含私人资源的旧上下文。
- `readPaths/writePaths`是原生扩展的OS路径授权；Web资源读也参考readPaths。它们不能与应用源码/数据重叠。原生可写资源目录保存会话、设置和模型认证；不是对应用数据库开放写权限。电脑工具仍只访问其独立工作目录。原生TUI手动`!`命令和扩展子进程遵循原生进程权限（需processExecution及shell）；它们不会使用Web电脑工具工作进程的权限配置。
- `permissions.network`为精确`host:port`列表，IPv4 DNS固定到启动时地址；经带随机认证的本机HTTP/CONNECT代理出站，OS拒绝直接联网。配置中的IBKR网关及常用本机券商端口不能授予。Node26的内置fetch代理已验证；其他客户端须支持HTTP(S)_PROXY，原始TCP/SSH不会自动获准。
- `loopbackListenPorts`用于明确的本机OAuth回调端口（1024–65535）；不允许任意端口或公网监听。`processExecution:true`还需要shell scope，才允许扩展/MCP启动子进程；默认false。外部浏览器可手动打开认证URL，不自动授予系统桌面全部能力。
- 原生扩展是已授权代码，同进程可读取该原生资源目录中的模型凭据；不能把项目trust描述成OS隔离。只读券商凭据留在父服务，桥接仅提供获准业务工具，无下单、撤单或划转工具。用户另外配置的第三方MCP/自定义代码须使用只读服务凭据，项目不能证明任意第三方远程服务自身只读。

## 模块和接口

| 模块 | 接口/数据 | 职责 |
|---|---|---|
| `pi-native-config.js` | `resolvePiNative(input) -> PiNativeConfig`；`piSettings`；`textResources`；`nativeCapabilities` | 校验官方schema、加载文本资源、权限过滤、完整能力清单 |
| `pi-session-runtime.js` | `createPiSessionRunner`；`run.native` | 复用官方设置/压缩/重试；绑定资源、工具和逐轮授权；仍由SDK运行循环 |
| `pi-native-launcher.js` | `prepareNativeLaunch({home,computer,config,args,scopes})`；`launchNative({runtime,args,scopes}) -> {code,signal,nativeHome}` | 构造沙箱、清洁环境、启动官方bundle并处理IPC与取消 |
| `pi-native-bridge.js` | `bridge=pi-trading-v1`；`ready/init/turn/tool/cancel/result` | 注册交易与受限官方工具；不覆盖整张activeTools表；保留其他扩展 |
| IPC工具调用 | `{type:"tool",id,name,args}` / `{type:"result",id,result}` | 父进程按真实工具Map执行，4MiB边界/工具预算/安全错误，不能注入actor或直接DB方法 |
| `pi-network-proxy.js` | `createNativeNetworkProxy([{host,port,address}]) -> {port,url,close}` | HTTP/CONNECT仅授予目标，拒绝其他目标，退出关闭连接 |
| `computer-tools.js/worker.js` | 官方8工厂、原参数schema，names选择 | 独立文件/Shell范围与进程沙箱；不是自写替代read/bash语义 |
| 原交易Service/Providers | 101项操作与scope | 研究、计算、账本与独立IBKR模拟确认流程 |

## 使用入口

在项目目录执行；将示例绝对路径换成自己的数据目录。授权只涵盖该次原生进程：

```sh
npm run native -- --home /absolute/path/pi-data --scopes compute,resources,localRead,localWrite,shell --
npm run native -- --home /absolute/path/pi-data --scopes compute,resources -- --mode rpc
npm run native -- --home /absolute/path/pi-data --scopes compute,resources -- --tools +codemode,+tool_search
```

普通Web对话启用“Pi资源发现”授权后，可使用工作目录的AGENTS、Skills与提示模板；文件读取、修改、Shell、broker不会随它自动勾选。没有配置真实模型时，计算表单仍可用，但自然语言对话不冒充在线模型。


## Validation

The tests run actual SDK and CLI components with synthetic model responses and local MCP fixtures. Remote providers, OAuth logins, paid services, device-specific UI behavior, and non-macOS isolation require separate validation. See [verification](verification.md).
