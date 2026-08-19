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
