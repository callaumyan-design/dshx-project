# dshx-project

> Makes the session header's built-in "Open In" button open the conversation's **real project folder** instead of the workspace root. The project is your pick, the model's `set_project` record, or inferred from the session log.

**不加任何按钮**：直接接管标题栏自带的「Open In」图标。点它（资源管理器、VS Code 等任意应用），打开的是这个对话**真正在做的项目**，而不是工作区根目录。

## 为什么需要它

会话的 `cwd` 是创建时写死的（immutable），DSH 没有任何修改它的 API。如果你习惯从工作区根目录开对话，自带的「Open In...」就永远只能打开根目录。

本插件自己判断真实项目，**不改会话日志**；插件没加载时一切照旧。

## 项目怎么确定（优先级从高到低）

| 来源 | 说明 |
|---|---|
| 你手选 | 通过 `POST /dshx-project/set` 路由（目前无界面） |
| AI 记录 | 常驻系统提示要求 AI 一确定项目就调用 `set_project` 工具 |
| 自动识别 | 读会话日志里所有工具调用涉及的路径，按项目目录打分（写入权重高，越近越重） |
| 兜底 | 会话 cwd（还没识别出项目时） |

- **历史会话**：不需要任何登记，打开就自动识别。作者本机实测 343 个会话里约 73% 能识别出项目，其余基本是没调用过工具的纯聊天。
- **新对话**：一开始打开根目录；AI 开始动某个项目的文件（或调用了 `set_project`）后，下次点图标就会打开那个项目。
- **项目搬过家也认得**：老日志里的 `<root>\my-app` 会按目录名对到现在的 `<root>\projects\my-app`。
- 你手选的永远优先，AI 不能覆盖。

## 文件放置规则（同一段系统提示里下发）

- AI 不在工作区根目录直接写文件；
- 做已有项目 → 文件放进该项目；
- 其他产出 → 先建 `outputs\<YYYY-MM-DD>-<英文短名>\`，本对话所有文件放进去，并用 `set_project` 登记，这样标题栏按钮打开的就是这个文件夹；
- 临时文件 → `.tmp\`，用完删除。

规则文本在 `index.js` 的 `PROMPT_RULE`，可按需修改。

## 识别规则

- 只认工作区（`~/.dsh/storages/workspace.json`）内的目录。
- 「容器目录」本身不算项目，往下取一层：`projects`、`outputs`、`docs`、`dsh`、`dsh/dshx-plugins`、`dsh/skills`、`dsh/tools`（在 `infer.js` 的 `CONTAINERS` 修改）。
- 忽略 `archive`、`.tmp`、`tmp`、`node_modules`、`.dsh`、`.agents` 等（`NOISE`）以及所有点开头的目录。
- 证据不足（总分 < 2）时不下结论。
- 日志只读、增量解码（只解新增的 zstd 帧），每个会话缓存偏移量。

## 实现

- 前端在标题栏放一个隐藏标记记下会话 id，拦截自带按钮发出的 `open-in-app/open` 请求，**只在路径等于该会话 cwd 时**换成真实项目；查询失败或识别不出时原样放行。
- 记录存在 `~/.dsh/dshx-project/projects.json`（串行化原子写）。

| 文件 | 内容 |
|---|---|
| `index.js` | 路由 `/dshx-project/{state,set,clear,open}`、`set_project` 工具、系统提示规则 |
| `infer.js` | 会话日志解析与项目打分 |
| `client.js` | 接管自带 Open In 图标的请求（无可见 UI） |
| `test.mjs` / `client-test.mjs` | 19 项 host 测试 / 8 项 client 测试：`node test.mjs`、`node client-test.mjs` |

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-project
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-project
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-project`。

## 更新日志

- **2.1.0** — 不再单独加按钮，改为接管标题栏自带的「Open In」图标；新增从会话日志自动识别项目（含项目搬家后的重定位）；新增文件放置规则提示。
- **1.0.0** — 首个公开版本：标题栏「项目」控件 + `set_project` 工具。

## 兼容性

在 DeepSeek Harness 0.2.0-rc.2（desktop / web profile）上开发和使用。纯 JavaScript，无构建步骤，无安装脚本。

## License

MIT
