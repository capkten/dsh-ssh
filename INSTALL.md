# 安装本 fork 的 SSH / Docker 插件

本仓库发布的是独立 fork，不是 npm 上的上游 `dsh-ssh`。
**0.4.4 预发布针对 Windows DSH Desktop 0.2.2-rc.1**；其他版本需重新验证，
不要绕过版本检查。安装包是插件 `.tgz`，不是 Desktop 的 EXE 安装程序。

## 下载并安装

1. 从 https://github.com/capkten/dsh-ssh/releases 下载 `dsh-ssh-0.4.4.tgz`
   和 `SHA256SUMS.txt`。GitHub 自动生成的源码 ZIP 不包含构建产物，不能代替安装包。
2. 完全退出 DSH（包括托盘），先备份 `%USERPROFILE%\.dsh\profiles\desktop`
   的 `package.json`、`cordis.patch.yml`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`。
   同时妥善备份 `<DSH_HOME>/dsh-ssh-connections.json`，其中可能含密码，不能上传。
3. 将包放到稳定目录，例如 `%USERPROFILE%\.dsh\deploy`。用
   `Get-FileHash <安装包> -Algorithm SHA256` 与校验文件比对。
4. 将下面的配置**合并**进 Profile 的 `package.json`，保留其他依赖和 bundles。
   将 `YOUR_NAME` 替换为真实用户目录，路径使用 `/`：

```json
{
  "dependencies": {
    "dsh-ssh": "file:C:/Users/YOUR_NAME/.dsh/deploy/dsh-ssh-0.4.4.tgz"
  },
  "dsh": {
    "profile": {
      "bundles": ["dsh-ssh"]
    }
  }
}
```

5. 使用该 DSH 随附的 Node/pnpm，在 Profile 目录执行 `pnpm install --ignore-scripts`，
   保留更新的 lockfile。宿主通过 loader 提供 DSH 核心库；不要另行安装第二份
   `@deepseek-ai/dsh-tools` 等核心包。ssh2 的可选原生加速未构建时使用 JS 路径。
6. 先在隔离 Profile 验证。重启后，通过添加工作区界面选择 SSH，配置服务器、
   用户与认证，选择远程 Linux 目录。启用主机指纹校验，并预先核实 known_hosts。
   不要通过关闭校验来解决未知主机报错。新建测试会话，避免复用旧的本地 preset。

`dsh plugin ... add dsh-ssh` 或按裸包名从插件市场添加，可能安装上游版本，
不能代替上述 fork 安装步骤。固定 file 依赖才能保证普通重装依赖保留此版本。

## Docker exec 工作区

先连接 SSH 宿主，再选容器和容器内目录。容器不需要 sshd 或开放 22 端口。
宿主必须有 Docker CLI，SSH 用户必须有访问 Docker daemon 的权限。
容器必须正在运行，并具备本插件所需的 shell、Linux 文件/搜索工具；并非任意
distroless、scratch 或 Windows 容器都支持。容器工作区的文件和命令在容器内执行，
不会同步整个仓库到 Windows。容器重建改变 ID 后应重新选择目标，不静默切换。

Docker daemon 权限通常接近宿主 root 权限；Docker 边界不代表与 DSH 本地沙箱等效。
SSH 模式没有远端内核沙箱。请使用专用测试目录验证文件读写和审批行为。

## 配套压缩插件（可选）

本插件默认仍使用官方压缩引擎。要使用会话 reasoning 继承及独立阈值，先安装
https://github.com/capkten/dsh-compaction-session 的 rc.5 安装包并注册其 bundle，
再在 Profile 的 `cordis.patch.yml` 顶层列表中合并：

```yaml
- id: ssh-remote
  config:
    compactionProvider: dsh-compaction-session
```

远程实例将继承共享 `session-compaction-settings`。上下文容量、压缩阈值和输出预留
见配套插件说明；不要求所有用户安装该插件。

## 验证与回滚

- 本地会话运行 `hostname` 应仍返回 Windows 本机。
- 远程新会话使用原生 Bash 执行 `hostname; pwd; uname -s; id`，应返回 SSH 宿主
  或所选容器的结果。用原生 read/glob/grep 查看已知文件。
- 写入、编辑和删除只在专用临时目录验证；断线必须明确失败，不能退回本地。
- 验证两个目标不会串线；按实际需要另验 Desktop 文件树、终端和 Git 卡片。
  绕过官方 workspaceFiles 接口的第三方侧栏可能不兼容。

本次发布的 CI 覆盖类型检查、单元测试、构建及打包，不代表完整 Desktop/真实 SSH
验收。回滚时退出 DSH，恢复备份的四个 Profile 文件，再按旧 lockfile 重装依赖；
不要删除聊天目录或连接注册表，也不要修改 app.asar。

## English quick start

This fork targets Desktop rc.5 only. Download the release `.tgz`, verify its
SHA-256, exit Desktop, back up Profile metadata, merge a stable `file:` dependency
and the `dsh-ssh` bundle, then install with the matching bundled pnpm. Do not
replace your whole Profile. The unscoped npm name still points to upstream.
Docker exec needs host Docker permissions and a running Linux container with
the required shell/utilities; no container SSH port is needed. Verify with a new
test session. Host-key verification stays enabled. Remote kernel sandbox parity
and full live Desktop acceptance are not claimed.
