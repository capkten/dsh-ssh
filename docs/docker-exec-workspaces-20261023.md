# SSH + Docker exec 工作区

## 状态

容器功能在隔离 Profile 和 UUID 临时目录完成下述验证，新增表单尚未进行浏览器交互及原生 Electron 视觉验收。

## 使用方式

新增连接表单中填写 SSH 宿主机地址、用户和认证信息；“Docker 容器”填容器名或 ID。“容器用户”可指定 UID/GID 或用户，留空使用容器默认用户；“工作目录”留空使用镜像 Config.WorkingDir，否则填写容器内绝对路径。普通 SSH 连接不填 Docker 字段，行为不变。

目标示例：填写可访问的 SSH 宿主机、Docker 容器名或 ID，以及容器内目录（例如 `/app`）。保存时解析并持久化完整容器 ID；不会直接修改已有 SSH 工作区的目标。需要新增容器连接/工作区，而不是在旧 SSH 会话中自动切换。

不需要容器 SSH 服务、端口映射、远端 Node 或驻留 Agent，不安装远端依赖，不同步项目仓库。并非所有容器都满足要求：容器必须运行且未暂停，宿主机 SSH 用户须有 Docker 权限，容器须具备 Bash、Python 3、GNU coreutils/find 及 grep。Distroless/scratch、缺少这些工具的最小镜像和 Windows 容器不在首版支持范围。Docker context/rootless 配置沿用 SSH 用户环境，不自动 sudo。

## 路由实现

- `src/docker.ts`：目标校验、精确 argv 引用、Docker exec/PTY、内联 Python 子进程监督与终止。所有执行使用完整容器 ID。拒绝通过容器客户端调用原始宿主机 shell/SFTP/subsystem/forwardOut。
- `src/docker-files.ts`：私有文件操作适配层，经 docker exec 执行一次性 Python 代码，提供 stat/list/分块字节读写/原子 rename 等操作。它不启动 SFTP 服务，不是网络 SFTP 协议；已有 SSH 工作区仍使用真正的 SFTP。每次读取最大 64 KiB、写入块 32 KiB，避免把文件放进命令行大参数；不做本地镜像。
- `src/connection.ts`：可选 `docker: {container,user?}`；预检并固定 ID，容器执行客户端与文件适配器共用同一目标。宿主机控制面只用于 Docker inspect/exec。
- `src/registry.ts` / `src/web.ts`：保存前预检，连接记录和无密钥视图保留 Docker 目标；测试连接与保存连接使用同样的校验；容器目录浏览从容器工作目录开始。
- `src/preset.ts` / `src/context.ts`：沿用每连接隔离域和原有本地占位元数据路由，展示 Docker 预设和真实容器目标，执行路由不依赖提示词。
- `src/client/form.tsx` / `flow.tsx` / `index.ts`：表单、传输类型和认证重试保留目标及目录，避免重新认证变成宿主机连接。
- `src/filesystem-final.ts`：复用编辑版本冲突检查和同目录 staging 发布；修正 guarded-create 的 staging 清理，以及未消费预览流提前建立造成的错误生命周期问题。

## 实际验证

测试容器 `turboocr_demo`，固定 ID `5c329dcbf3210913fd74dd1c60b5de1af588e75c3dc1e5c2103f9207e6088772`，宿主机 `ai-gpu-a100-128`，容器 hostname `5c329dcbf321`。

1. `docker-exec-smoke.mjs`：容器 hostname/pwd/Linux、真实文件读写和编辑、过期版本拒绝、目录列表、glob/单文件 grep、二进制及范围读取、延迟任务、终止长任务后 /proc 中进程不存在、真实 PTY、交互输入和 30x96 尺寸调整、宿主机/容器并发且宿主机不存在对应文件、SSH 重连固定目标、缺失容器拒绝。
2. `docker-headless.mjs`：隔离 Profile 使用真实 Agent + run_code 调度器调用 Bash、Git、read、write、edit、glob、grep；从外部读取临时文件确认 DOCKER_EDIT_OK。mock 模型只安排调用，结论依据真实工具输出和外部文件。
3. `docker-lifecycle.mjs`：仅创建、停止及删除测试自有容器，使用已有镜像，无网络、端口和挂载。停止容器被拒绝；同名替换后，已有和恢复连接都不选择新容器。没有停止或重建 turboocr_demo。
4. `docker-registry.mjs`：隔离连接状态文件，测试表单后端连接、保存完整 ID、重载固定目标、默认 /app，调用者输入不被修改。
5. `desktop-bridge-smoke.mjs`：官方文件/终端控制器，同进程一个 SSH 和一个 Docker 目标；真实列表、预览与 PTY、目录边界、本地 Windows 文件和 Shell、轮询与失败关闭通过。仅 Typert 注册 stub，不代表 renderer/RPC/Electron 完整验收。测试等待 PTY 输出流结束后断言输出，避免退出与缓冲区排空时序影响结果。
6. 59/59 单元测试、类型检查、构建通过；local-hostname 和 remote-read headless 旧功能回归通过。

测试仅写 UUID 命名 /tmp 目录；专用临时容器和文件已清理。业务项目没有写入。

## 限制与部署

Docker 执行权限取决于容器配置与指定用户；测试容器默认 root。保留原有审批/文件策略和 SSH Host Key 验证，但不是新增的完整内核沙箱。后台任务的正常终止已测；突然网络中断时长期任务的完整恢复/清理、全部 job_output/job_kill GUI、非 root 镜像、不同发行版和完整 Electron UI 尚未验收。容器文件操作的单次 exec 成本比 SFTP 更高。原有版本检查到发布间的 CAS 窗口仍存在。

候选包保持 0.4.2，只用于本地测试，没有发布。正式安装仍需沿用已验证的宿主 SDK 共用适配；不能仅假设 peerDependencies 保证身份相同，也不能用普通重装覆盖当前 SDK 修正。先备份正式插件，复制准备好的产物、通过官方 Profile 解析规则下的 SDK/调度器身份及执行检查，再由用户退出重开 Desktop。DSH 升级或移动路径后须重新部署及验收。正式容器工作区仍待用户授权安装候选版后试用。
