# CD041_EVAL

Eval 是面向嵌入式开发工作的桌面 Agent，集成会话、工具调用、文件操作、联网调研、原理图分析、代码构建与设备工作流。

## 开发

先安装 Node.js 22.13+、Bun、Rust 与 pnpm，然后安装依赖：

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @eval-agent/app build
```

Windows 正式发布流程与签名要求见 `AGENTS.md` 和 `docs/windows-release-signing.md`。

### macOS 本地开发

在 macOS（Apple Silicon 或 Intel）上开发桌面应用需要额外准备 Tauri 依赖：

- Node.js 22.13+、Bun、Rust（`rustup` 安装）
- Xcode Command Line Tools：`xcode-select --install`

```bash
pnpm install --frozen-lockfile
pnpm prepare:server    # 构建 eval-server（tauri dev 的 beforeDevCommand 也会自动执行）
pnpm --filter @eval-agent/app tauri dev
```

- 依赖安装后可用 `pnpm prepare:sidecars` 一次性构建 `eval-server`、`eval-serial` 并收集到 `bundle-resources/`
- 前端单独开发可运行 `pnpm --filter @eval-agent/app dev`（Vite，端口 5173）
- 后端单独调试可运行 `bun run packages/core/src/runtime/index.ts`（监听 `127.0.0.1:4096`）
- 运行时数据默认存于 `~/.eval/eval.db`（SQLite），可用 `EVAL_DATA_DIR` 覆盖

## macOS Apple Silicon 打包

在 Apple Silicon Mac 上安装 Node.js 22.13+、Bun、Rust，并执行
`pnpm install --frozen-lockfile` 安装依赖。然后从仓库根目录运行：

```bash
pnpm package:macos-arm
```

未签名应用生成在 `app/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Eval.app`。
正式分发前需配置 Apple Developer 签名（`codesign` + Developer ID Application 证书）与公证
（`notarytool submit` + `stapler staple`），本项目暂未内置签名脚本。

同时支持 Apple Silicon 与 Intel Mac 的 Universal 2 应用使用：

```bash
pnpm package:macos-universal
```

产物位于 `app/src-tauri/target/universal-apple-darwin/release/bundle/macos/Eval.app`。

生成由 macOS Installer.app 打开的安装向导包：

```bash
pnpm package:macos-universal-installer
```

安装包输出到 `dist/<version>/Eval_<version>_universal.pkg`，并将应用固定安装到
`/Applications/Eval.app`。
