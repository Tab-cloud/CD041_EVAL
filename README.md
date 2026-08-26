# CD041_EVAL

Eval 是面向嵌入式开发工作的桌面 Agent，集成会话、工具调用、文件操作、联网调研、原理图分析、代码构建与设备工作流。

## 开发

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter @eval-agent/app build
```

Windows 正式发布流程与签名要求见 `AGENTS.md` 和 `docs/windows-release-signing.md`。

## macOS Apple Silicon 打包

在 Apple Silicon Mac 上安装 Node.js 22.13+、Bun、Rust，并执行
`pnpm install --frozen-lockfile` 安装依赖。然后从仓库根目录运行：

```bash
pnpm package:macos-arm
```

未签名应用生成在 `app/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Eval.app`。
正式分发前仍需配置 Apple Developer 签名与公证。

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
