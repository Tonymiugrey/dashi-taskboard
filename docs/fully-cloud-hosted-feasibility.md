# 全云端托管可行性调研

## 结论

可实现“前端、业务 API、任务数据和附件全部由 Cloudflare 托管”，而且当前代码已经具备大部分云端基础设施。不能在保留现有 Codex 能力的同时把本机进程完全删除：自动认领配置、Codex 余量读取、原生对话跳转、Git/worktree 扫描和设备目录映射都只能由本机执行。

推荐目标不是“纯云端、零本地”，而是：

> Cloudflare 承载产品；每台设备只保留一个不承载业务数据的轻量能力桥和最小菜单注入脚本。

这样可以消除多设备拉取前端代码和重复部署，日常 UI/API 更新只需部署一次。只有 Codex DOM 或本机桥协议变化时，才需要更新设备端组件。

## 当前真实运行路径

### 1. 云端业务路径已经成立

1. `wrangler.jsonc` 把 React 构建产物绑定为 Worker Static Assets，把 D1 绑定为 `DB`，把 R2 绑定为 `ATTACHMENTS`。
2. Worker 对 `/api/*` 执行业务逻辑，其余请求交给 `env.ASSETS.fetch()`；D1 保存项目、议题和评论，R2 保存附件。
3. 当前本地 companion 在 cloud mode 下把业务请求代理到 Worker，并注入 Basic Authentication；Worker 返回变化后，前端每两秒轮询 revision 并刷新。
4. 可观察结果是：任一设备的议题或附件变更写入同一份云端数据，并在其他设备的面板出现。

相关实现：[`wrangler.jsonc`](../wrangler.jsonc)、[`cloud/src/index.mjs`](../cloud/src/index.mjs)、[`server/cloud-proxy.mjs`](../server/cloud-proxy.mjs)、[`docs/cloud-collaboration.md`](./cloud-collaboration.md)。Cloudflare 官方当前也明确支持在一次 Worker 部署中组合 Static Assets 与 Worker API，并由 D1、R2 分别承载 SQL 数据和对象数据：

- [Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare D1](https://developers.cloudflare.com/d1/)
- [Cloudflare R2](https://developers.cloudflare.com/r2/)

### 2. 直接把 iframe 改成云端 URL 会破坏自动认领

1. 前端仅在 iframe 内且 `window.location.origin` 是 localhost 时启用自动化配置。
2. 前端通过 `postMessage` 向父窗口发送 `taskboard:automation-request`。
3. 注入脚本再次拒绝非 localhost iframe，然后通过 CDP 安装的 host binding 调用 Codex 自动化 API。
4. 可观察结果是：云端 URL 虽然能显示面板，但当前自动认领入口会显示“仅本地任务面板可用”。

相关实现：[`web/src/App.tsx`](../web/src/App.tsx)、[`inject/codex-taskboard.user.js`](../inject/codex-taskboard.user.js)、[`scripts/codex-injector.mjs`](../scripts/codex-injector.mjs)。

### 3. 本机能力无法搬到 Worker

本地 companion 当前负责绝对目录映射、Git/worktree 扫描、Skill/MCP 发现、Codex 项目定位和自动化状态。Worker 的 `/api/meta` 明确返回 `localCapabilities.available: false`；cloud mode 的 companion 才把它改为 `true`。浏览器直接访问云端时只具备共享面板和附件能力。

这不是 Cloudflare 能力不足，而是浏览器和 Worker 不应访问设备文件系统或 Codex 本机状态。因此必须保留一个最小本机边界。

### 4. 注入复杂度来自 Codex 宿主，不来自前端部署

当前启动器需要连接 CDP、开启 CSP bypass、注册 document-start 脚本、重载 renderer、挂载菜单和 iframe，并维持 host binding 心跳。把 iframe 指向云端能删除“本地提供前端和代理业务 API”的职责，但不会删除这些宿主集成步骤。

OpenAI 当前公开的插件能力主要是 Skill、MCP 工具和可选 UI；官方 UI 文档明确以 ChatGPT/MCP Apps 宿主为主，并建议在不渲染组件的 Codex 等客户端保持工具可用。公开文档没有提供向现有 Codex 桌面侧边栏注册常驻自定义页面的接口。因此，插件可以承载 Taskboard 工具和工作流，但目前不能可靠替代这套侧边栏注入。来源：[Plugin architecture](https://developers.openai.com/plugins/concepts/plugins)、[Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)。

## 推荐目标架构

| 层 | 放置位置 | 职责 |
| --- | --- | --- |
| 产品层 | Cloudflare Worker + Static Assets | 前端、API、鉴权入口、revision、设备状态 |
| 数据层 | D1 + R2 | 项目/议题/评论/关系/配置元数据；附件 |
| 设备桥 | 本机 loopback daemon | Codex 自动化、余量、本机项目、Git/worktree、Skill/MCP、对话导航 |
| 菜单注入 | Codex renderer | 挂载菜单和云端 iframe；在 iframe 与设备桥之间转发受限消息 |

关键协议应改为“能力握手”，而不是“检测页面是否像在 Codex App”：

1. 注入脚本只接受配置好的云端 origin，并向 iframe 发送带随机 nonce、设备 ID、桥版本和能力列表的 `host-context`。
2. 云端前端只有收到来自 `window.parent` 的实时能力握手后才显示自动认领配置。
3. 自动化写操作仍在本机桥执行；本机桥校验 origin、nonce、操作白名单和项目映射后再调用 Codex。
4. `?host=codex`、User-Agent、Referrer 或可伪造的前端变量只能控制展示，不能作为授权依据。

不要把 cloud shared key 放入 URL、iframe 消息或 localStorage。当前 Basic shared-password 模型允许知道密码的人冒充任意 actor，适合现有的两人信任场景，但不适合作为设备身份。云端 iframe 直连前应改成独立的浏览器会话鉴权；设备桥使用单独、可撤销的设备凭据。

## “云端项目 + 本地项目”的建议定义

建议不要把本地 SQLite 看板与 D1 看板并列合并。两套可写议题库会引入重复 identifier、跨库关系、评论顺序和同步冲突，但这不是当前目标所必需。

建议界面分成两组：

- **云端项目**：D1 中的 Taskboard 项目，是议题和评论的唯一权威来源。
- **本机工作区**：由 Codex host context/设备桥发现的本机项目，只保存设备级映射和 Git/worktree 能力；未映射项可执行“映射到云端项目”。

普通浏览器只显示云端项目；只有完成能力握手的 Codex App iframe 才显示本机工作区。项目 ID 必须带来源命名空间，例如 `cloud:<projectId>` 与 `device:<deviceId>:<codexProjectId>`，避免同名或同 ID 误配。

如果产品定义确实要求同时操作“本地 SQLite 议题”和“D1 议题”，应另开同步/迁移设计，不应混入本轮全云端改造。

## 分阶段实施建议

1. **云端直载**：让注入脚本加载 Worker HTTPS URL；保持业务数据只在 D1/R2，补浏览器会话鉴权。
2. **可信能力桥**：把 localhost 判断替换为 origin + nonce + 能力握手；自动化、余量、对话和 Git 操作继续走本机桥。
3. **项目双视图**：云端项目与本机工作区分组展示，增加设备级映射；不合并两套议题库。
4. **缩小设备端**：本机 companion 不再提供前端、不再代理普通业务 API，只保留 loopback capability API、设备心跳和 Codex host binding。
5. **简化启动**：把启动器做成一次安装、登录时自动启动的设备助手；保留稳定的小型注入脚本。只有桥协议或 Codex DOM 变化时更新设备端。

第一阶段完成后，多设备不再需要为普通产品更新拉代码或各自部署；第四、五阶段完成后，用户日常只打开 Codex，不再手动运行多条命令。

## 主要风险与决策点

| 风险/决策 | 影响 | 建议 |
| --- | --- | --- |
| Codex DOM 与 CDP 注入不是公开扩展契约 | Codex 更新可能使菜单失效 | 保持注入层最小，独立版本和健康检查；等待官方常驻 UI 扩展能力 |
| 云端 iframe 鉴权 | Basic prompt 与共享身份不适合设备授权 | 用户会话与设备凭据分离，可分别撤销 |
| 远端页面调用本机能力 | 远端脚本被攻破会触达本机 | 本机桥只开放固定操作，校验 origin/nonce/项目映射，不提供通用命令执行 |
| “本地项目”的产品含义 | 决定是否需要跨库同步 | 默认定义为本机 Codex 工作区；若指本地议题库，先单独确认同步语义 |
| 设备端自动更新 | 远程下发注入 JS 会扩大供应链风险 | 云端更新 UI；本地注入包保持小且经本地安装/签名更新 |

## 建议的下一实现切片

先做一个可回退的纵向切片：在现有启动器中把 iframe 指向云端 Worker，新增可信 host capability 握手，只打通“读取云端项目 → 映射一个本机 Codex 项目 → 查看并保存自动认领配置”这条路径。暂时保留当前 companion 与 Basic cloud proxy 作为回退，不同时重写鉴权、项目模型和启动方式。

验收结果应可直接观察：普通浏览器不出现自动认领配置；同一云端 URL 嵌入 Codex 后出现配置；保存后 Codex Scheduled 中对应自动化更新；另一台未建立本机映射的设备不能修改该设备的自动化。
