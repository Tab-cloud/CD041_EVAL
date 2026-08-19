# AGENTS.md — Eval 项目 AI 编码规范

本文件约束所有 AI 编码助手（Claude / GPT / Cursor / Copilot 等）在本仓库的行为。
违反本规范的代码应被拒绝合并。

---

## 1. 图标规范（强制）

**禁止使用 emoji 图标。**

所有 UI 图标必须使用 SVG，**优先从 `app/src/components/Icons.tsx` 复用**，避免在多处重复定义。

### 1.1 已有图标（直接 import 使用）

| 分类 | 图标 |
|------|------|
| 通用 | `CpuIcon` `SettingsIcon` `SunIcon` `MoonIcon` `PlusIcon` `XIcon` `SearchIcon` `CheckIcon` `CopyIcon` `PencilIcon` `ChevronDownIcon` `ChevronRightIcon` `ExternalLinkIcon` `SpinnerIcon` |
| 文件/项目 | `FolderIcon` `FolderOpenIcon` `FileIcon` `FileCodeIcon` `RefreshCwIcon` `FileImageIcon` `FileTextIcon` `FilePdfIcon` |
| 聊天/消息 | `MessageSquareIcon` `SendIcon` `PaperclipIcon` `UserIcon` `BotIcon` |
| 面板/工具 | `TerminalIcon` `MonitorIcon` `BugIcon` `WrenchIcon` `Trash2Icon` `DownloadIcon` |
| 嵌入式专用 | `CircuitBoardIcon` `CpuChipIcon` `ZapIcon` `HammerIcon` `UsbIcon` |
| 状态/提示 | `CheckCircleIcon` `AlertCircleIcon` `InfoIcon` `LightbulbIcon` |
| 能力标签 | `EyeIcon` `BrainIcon` `Code2Icon` |
| 范围模式 | `HandIcon` `ShieldIcon` `ListChecksIcon` |

### 1.2 新增图标规则

如需新图标，按以下步骤：

1. **从 Lucide Icons 复制 SVG path**（MIT 协议，来源 https://lucide.dev）
2. **追加到 `app/src/components/Icons.tsx` 末尾的对应分类**
3. 使用 `icon()`（单 path）或 `iconMulti()`（多 path）工厂函数，保持 stroke-only 风格
4. **不要**使用 emoji 字符代替（即使只是临时占位）

### 1.3 反例（禁止）

```tsx
// ❌ 错误：使用 emoji
<span>📁 文件</span>
<span>🛡 完整访问</span>
<button>+</button>

// ✅ 正确：使用 SVG
<span><FolderIcon size={16} /> 文件</span>
<span><ShieldIcon size={14} /> 完整访问</span>
<button><PlusIcon size={14} /></button>
```

---

## 2. 通用规范

- **TypeScript 优先**：`packages/core/` 和 `app/` 全部使用 TypeScript，不引入 `.js`/`.jsx`
- **后端运行时**：`packages/core` 用 Bun + Vercel AI SDK，编译时用 `bun build --compile`
- **桌面壳**：`app/src-tauri` 用 Tauri 2 + Rust，命令通过 `@tauri-apps/plugin-shell` 调用
- **持久化**：用户配置、会话、消息、检查点统一用 SQLite（`~/.eval/eval.db`）
- **CORS**：后端基于请求 `Origin` 动态放行，禁止 `*`
- **文件拆分（强制）**：禁止单个程序文件无限膨胀。单文件超过 600 行时必须评估拆分方案，超过 1000 行强制拆分。按功能职责分类，每个文件单一职责：
  - React 组件文件 ≤ 300 行（含 JSX + 逻辑），大型组件拆为 Container（逻辑）+ Presentational（渲染）
  - 状态管理代码与 UI 代码分离（`store.ts` / `reducer.ts`）
  - 工具函数独立为 `util/` 或 `helpers/` 目录
  - 类型定义集中在 `types.ts` 或模块内 `types.ts`
  - 后端路由 / 工具 / agent 各为一个文件，不合并

---

## 3. 提交前自检

- [ ] 没有任何 emoji 字符被用作图标（包括 ✋ 🛡 📋 🖼 📄 📑 📎 ➤ ⏎ 等）
- [ ] 新增图标已加入 `Icons.tsx` 并 export
- [ ] TypeScript 编译通过：`cd app && npx tsc --noEmit`
- [ ] Rust 编译通过：`cd app/src-tauri && cargo build --release`
- [ ] Tauri NSIS 打包成功：`cd app && pnpm tauri build --bundles nsis`
- [ ] eval-server.exe 已同步到 release 目录：`node scripts/sync-server.mjs release`

---

## 4. 发布产物目录（强制）

- Windows 正式发布只生成 **EXE/NSIS** 安装包，不再生成或交付 MSI；打包命令禁止包含 `--bundles msi`。
- 面向 Web 下载或自动升级的 Windows 正式包必须通过仓库根目录执行 `pwsh -NoProfile -File .\scripts\package-windows-release.ps1` 生成。该脚本要求 PowerShell 7，负责生产构建、NSIS 打包、签名、SHA-256、版本目录归档及敏感环境清理；不得用 Windows PowerShell 5.1、手工复制或临时命令代替正式发布流程。
- 所有最终可交付的安装包和发布程序统一放到 `D:\Projects\CD041_LUBAN\dist\<version>`，其中 `<version>` 必须与 `app/package.json`、`app/src-tauri/tauri.conf.json` 中的版本一致，例如 `D:\Projects\CD041_LUBAN\dist\0.1.1`。
- `app/src-tauri/target/release/bundle/` 等构建目录只作为中间输出目录，不作为最终交付路径。
- 每个人工安装版本目录必须包含以下两个相互对应的文件：
  - `Eval_<version>_x64-setup.exe`：NSIS 安装包。
  - `Eval_<version>_x64-setup.exe.sha256.key`：安装包完整性校验文件，内容为安装包的 SHA-256 与文件名；该文件不是代码签名私钥。
- 需要发布到 Web 自动升级通道时，还必须额外生成 `Eval_<version>_x64-setup.exe.sig`。签名文件必须使用与当前客户端内置 updater 公钥匹配的原私钥生成，且文件名必须与 EXE 完全对应。缺少 `.sig` 的 EXE 只允许人工下载和安装，禁止作为自动升级包发布。
- 打包成功后，必须核对 EXE 存在且大小正常、`.sha256.key` 中的哈希与安装包的实际 SHA-256 完全一致，并确认安装包包含 `eval-server.exe`、`eval-serial.exe` 和 `icudtl.dat`。自动升级包还必须验证 `.sig` 能被客户端内置的 updater 公钥验证。
- `updater.pub` 是更新通道长期固定的信任根，不是版本产物。正常版本打包不得在 `dist\<version>` 中复制、重新生成或交付 `updater.pub`；仅在首次建立更新通道或经过明确批准的签名密钥轮换流程中单独维护公钥。
- 禁止为了完成某个版本打包而临时生成新的 updater 密钥。必须使用与当前客户端内置公钥匹配的原签名私钥；原私钥不可用时可以生成并明确标记人工安装包，但必须停止自动升级发布并报告缺少 `.sig`，不能用新密钥生成一个表面完整但旧客户端无法验证的升级包。
- 私钥、私钥密码及其他发布凭据禁止写入仓库或 `dist`，只能由受保护的构建环境提供。公钥也不得作为每版本重复产物写入 `dist`。
- 本机正式签名凭据固定存放在 `%LOCALAPPDATA%\Eval\release-signing`：活动私钥为 `updater.key`，活动公钥为 `updater.pub`，私钥密码为当前 Windows 用户 DPAPI 保护的 `updater.password.dpapi`。目录必须关闭 ACL 继承，并且只允许当前用户和 `SYSTEM` 完全控制。
- `scripts/package-windows-release.ps1` 只能从上述受保护目录读取凭据，必须校验受保护公钥与 `tauri.conf.json` 内置公钥一致，并在结束时清除进程级密码和私钥环境变量。脚本和日志不得输出私钥或密码。
- 签名密钥轮换属于破坏现有自动升级信任链的发布操作，必须得到明确批准。轮换时旧密钥保留为受保护的只读归档，新公钥同时写入客户端并由管理员配置到 Web；不得把公钥复制到每个版本目录。
- Windows 签名凭据边界、Web 配置、轮换和事件响应的完整说明见 `docs/windows-release-signing.md`，正式发布前必须核对该文档。
- 对用户报告打包结果时，必须提供版本目录中的最终文件路径，不得只提供 Tauri 中间构建目录中的路径。
- 不得把构建缓存、解包暂存目录、日志、测试数据库或调试文件复制到 `dist`；该目录只保留正式交付产物。
- 新版本的 EXE 及其适用的校验/签名文件全部生成并通过校验后，才允许清理 `dist` 根目录中的散落旧产物和 Tauri 中间打包目录。
