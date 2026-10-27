# dsh-ssh

[English](README.md) | 中文

<p align="center">
  <img src="https://img.shields.io/npm/v/dsh-ssh" alt="npm 版本">
  <img src="https://img.shields.io/npm/l/dsh-ssh" alt="许可证">
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node 版本">
  <img src="https://img.shields.io/github/stars/UynajGI/dsh-ssh" alt="GitHub Stars">
</p>

**DeepSeek Harness 的 SSH 远程工作区插件。** 在「添加工作区」里选择远程 Linux 主机上的目录后，
整个编码 Agent —— Bash、read/write/edit、glob/grep、后台任务、模型可用的终端 —— 都通过一条
SSH 连接在该主机上执行；本地工作区保持原有工具不变。基于 [ssh2](https://github.com/mscdex/ssh2)，
支持跳板链（ProxyJump）、SFTP、完整认证与主机指纹校验。

![通过 SSH 添加工作区](docs/images/add-workspace.png)

## 实现方式（DSH 0.2.1-rc.2）

DSH 通过 **agent preset（Agent 预设）** 挂载模型工具，而自带预设解析的是 **宿主机** 的
`fs` / `subprocess` / `shell` 服务。因此 dsh-ssh：

1. 在 host 层保留连接注册表与「添加工作区」界面；
2. 为 **每条 SSH 连接注册一个隔离的 agent preset**（`dsh-ssh:c1`、`dsh-ssh:c2`…），其隔离域内挂载
   SSH 文件系统、子进程、bash 执行器、远程搜索工具与远程 PTY 终端；
3. 仅当新会话的工作目录是远程路由（`<dsh home>/dsh-ssh-routes/<id>/<远程路径>` 本地占位路径）时，
   在首次对话前把会话切到对应预设。该占位目录是路由键而非仓库镜像——DSH 创建会话时必须在本地
   `mkdir` 该 cwd，且只接受本地绝对路径；
4. 若远程路由会话无法绑定远程预设，**直接报错失败**，绝不悄悄退回宿主机执行。

远程执行域按连接隔离，因此两台服务器上的会话不会串线，本地会话也看不到远程 provider。

## 安装

```sh
dsh plugin --profile desktop add dsh-ssh
```

或 Web 界面：**插件 → 添加插件 → `dsh-ssh`**。需要 DeepSeek Harness 0.2.x 与 Node ≥ 22。
普通 `npm i dsh-ssh` 不会选中 bundle；需自行加入 `dsh.profile.bundles`。

## 安全

- 主机指纹校验：注册表连接支持 `strictHostKeyChecking` 与 `knownHosts`（`SHA256:…` 指纹或原始
  base64 公钥）。`strictHostKeyChecking: true` 且未显式给出 `knownHosts` 时，会读取
  `~/.ssh/known_hosts` 中匹配该主机的条目。默认仍为 `false` 以兼容已有连接——新部署建议开启。
- 连接密码/口令按原文保存在 `<dsh home>/dsh-ssh-connections.json`，请像保护 `~/.ssh` 一样保护它。
- 远程命令以 SSH 登录用户身份运行，**没有远程内核沙箱**：只有文件修改被远程工作区根目录围栏
  （read-only / workspace-write）约束，并沿用宿主审批流程。请把远程工作区视为对该主机的完整 shell 权限。
- SSH 断开后远程工具调用会明确失败；下一次调用会重新拨号同一主机，绝不会回退到本地文件系统或本地 shell。

## 已知限制（如实列出）

- **Web 侧栏文件树 / 文件预览 / “Open in app”** 以及 **Web 侧栏终端** 在 DSH 0.2.1 中读取的是
  *宿主机* 的 `fs` / `subprocess` 服务，因此对远程工作区仍为本地行为；模型可用的终端工具是远程的。
- **变更文件（git）卡片**（`dsh-workspace-changes`）把本地临时文件与远程 git 路径混用，对远程工作区
  没有意义。通过 Bash 工具执行 `git` 则是远程的，正常工作。
- 不支持 LSP（旧 README 中的说法只是愿景）。
- 远程 `glob`/`grep` 由远程 `find`/`grep`（GNU/POSIX）实现，因为官方工具调用的是 harness 内打包的
  本机 ripgrep 二进制，无法在 SSH 子进程里运行。
- 在本架构之前创建、且已经开始对话的旧远程会话无法切换预设；打开时会明确报错。请在该工作区新建会话。
- 远端 pid 恒为 `-1`；`terminate` 只是向 SSH 通道发信号，无法回收远端进程组。
- 规范化路径与原子写入使用 GNU 工具（`realpath -mz`、`base64 -w0`、`ln -T`）；主流 Linux 发行版
  （包括旧 CentOS 7）均具备。
- Web 侧栏交互式终端要做到远程，需要 DSH 核心侧改动。

## 开发

```sh
npm i
npm run typecheck
npm run build      # 产出 lib/，即 harness 加载器实际导入的产物
npm test           # node:test 单元测试（路由、占位路径、环境清洗）
```

`tests/integration/` 下的集成驱动使用一次性 DSH home/profile 与真实 headless harness 连接真实 SSH
目标（`npm run test:e2e`；需要随 Desktop 附带的 Node ≥ 24，并先安装 `tests/_deps`），不会触碰正在
运行的 Desktop profile。前置条件与验收阶段映射见 `tests/integration/README.md`。

## License

MIT


## Desktop 集成修复与验收边界（2026-10-23）

宿主 SDK 采用 peerDependencies；npm 自动安装 peer 仍可能产生第二份 SDK，部署前必须运行
`node tests/integration/check-host-sdk.mjs <宿主 dsh 根目录> <安装后的插件目录>`。
所有关键 SDK 必须解析到同一物理文件，否则禁止启动该测试 Profile。
默认 bundle 使用官方本地 browse Provider；远程目录仍通过 `/dsh-ssh`，
`dsh-ssh/picker` 保留给显式配置了宿主 SSH 的旧组合。

SSH 默认校验主机密钥；未知主机应先通过可信渠道确认密钥。ProxyJump 每一跳分别验证。
远程文件版本同时比较内容 SHA256（需要远端 `sha256sum`），防止 SFTP 秒级 mtime 漏掉同大小修改。
覆盖已有文件使用 OpenSSH POSIX rename 扩展；不支持此扩展的 SFTP 服务会明确失败。

`node tests/integration/provider-smoke.mjs` 验证同进程双连接、真实 SFTP 编辑、旧版本拒绝、
PTY、延时进程、重连和连接销毁后的失败。只写独立 `/tmp/dsh-ssh-test-<UUID>` 目录。
这是 Provider 证据；不代表 Desktop 侧栏终端、文件树或变更卡片已具备远程路由。
SSH Shell 没有远端内核沙箱；文件路径策略不等于完整隔离。
详见 `docs/desktop-integration-20261023.md`。
