# dshx-project

在会话标题栏显示**本会话真正在做的项目**，一键在资源管理器里打开它。

## 为什么需要它

DSH 自带「Open In...」按钮打开的是会话的 `cwd`。而 `cwd` 是**会话创建时写死的 immutable 元数据**：

```ts
// dsh-session/lib/types/types.d.ts
export interface SessionHeader {
    /** Absolute working directory the session was created in (if any). */
    readonly cwd?: string;
```

我在 0.2.0-rc.2 的运行时里搜过 `setCwd|updateHeader|patchHeader|updateMeta`——**零结果**，
没有任何修改 API。如果你的会话都建在工作区根目录（常见情况），那个按钮永远只打开根目录。

从日志里反推项目也不可行：实测覆盖率约 3%（267 个日志里只有 9 个提到完整子路径）。

**所以本插件不去改那个 immutable 字段**，而是自己维护一份 `sessionId -> 项目路径` 的映射。
它是纯展示性的：插件没加载时会话照常打开，自带按钮照常工作，会话日志不受任何影响。

## 装了什么

| 位置 | 内容 |
|---|---|
| 标题栏 | 一个「项目」控件，显示项目文件夹名；点开是目录菜单（当前项目 / 工作区目录 / 忘记） |
| AI 工具 | `set_project(path)` —— 模型可以自己把当前项目记下来 |
| 路由 | `/dshx-project/{state,set,clear,open}`，只接受同源请求 |

映射存在 `~/.dsh/dshx-project/projects.json`（原子写：先写 `.tmp-<pid>` 再 rename）。

## 用法

- **手动**：点标题栏的「项目」→ 从菜单里选一个目录 → 记下并可直接打开。
- **AI 自动**：直接跟模型说「这个会话在做 D:\work\my-app」，它会调 `set_project`。
  也可以让它在发现真实项目根和工作区根不同时自己记录下来。
- **打开**：点控件本体 = 打开当前记录的项目；菜单里选别的目录 = 改记录。

## 几个设计取舍

- **路径必须在已知工作区内。** `set` / `open` 路由页面可达，不设限就等于让浏览器
  能打开机器上任意目录。工作区根来自 `~/.dsh/storages/workspace.json`（产品自己的
  事实来源），与会话 `cwd` 取并集。
- **`Agent.id` 就是 session id。** 工具执行时没有 sessionId 参数，是从 `exec.agent.id` 拿的
  （`dsh-agent` 的 `types.d.ts`：`Session identity`）。没有 agent 上下文时明确报错，不猜。
- **只依赖 React。** 下拉菜单是自己实现的，没有 require `@deepseek-ai/dsh-client-ui-primitives`
  ——那个包装在 app.asar 的运行时 payload 里、磁盘上读不到，无法在开发时核对它的 props 契约。
  自带按钮的 `Menu` 组件引用方式可查，但我不想依赖一个没法验证的 API。
- **候选目录走两层。** 项目有的在一层下（`projects/my-app`），有的直接在根下
  （`my-tool`），只走一层会漏掉一半。

## 测试

开发时用一组 11 项的 host 测试（假 ctx 驱动真实模块）覆盖：
空状态、越界拒绝、缺失目录、相对路径、正常记录、状态回读、按记录打开、无记录打开、
清除、AI 工具的三种情形（有效/越界/无 agent）、方法守卫（405）、以及 render 输出。

## 安装

```sh
# Web profile
dsh plugin --profile web add github:callaumyan-design/dshx-project
# Desktop（用 DSH Desktop 自带的 dsh 命令，先从托盘完全退出 Desktop）
dsh plugin --profile desktop add github:callaumyan-design/dshx-project
```

安装后重启 DSH。卸载：`dsh plugin --profile <profile> remove dshx-project`。

## License

MIT
