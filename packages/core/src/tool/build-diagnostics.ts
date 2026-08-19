import type { ToolDiagnostic } from "./types.ts"

/** Convert compiler/linker prose into a stable recovery contract. */
export function diagnoseBuildFailure(output: string): ToolDiagnostic | undefined {
  const linkerScript = output.match(/cannot open linker script file\s+([^:\r\n]+):\s*No such file or directory/i)
  if (linkerScript) {
    const missingPath = linkerScript[1].trim()
    return {
      kind: "missing-linker-script",
      missingPath,
      evidence: [`链接器无法打开 ${missingPath}`],
      nextActions: [
        `在项目和厂商 SDK 中搜索 ${missingPath} 及其他 *.ld/*.sct/*.icf 文件`,
        "读取与目标芯片、Flash 容量和工具链匹配的厂商链接脚本",
        "核对构建配置中的脚本相对路径；只有存在已读取的可信参考时才能新建脚本",
      ],
    }
  }

  const symbols = [...output.matchAll(/undefined reference to [`']([^`']+)[`']/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean)
  if (symbols.length > 0) {
    const uniqueSymbols = [...new Set(symbols)].slice(0, 40)
    const families = [...new Set(uniqueSymbols.map(symbolFamily).filter(Boolean))]
    return {
      kind: "undefined-symbols",
      symbols: uniqueSymbols,
      evidence: uniqueSymbols.map((symbol) => `链接器未找到符号实现: ${symbol}`),
      nextActions: [
        `在项目和 SDK 源码中搜索这些符号的定义${families.length ? `（优先检查 ${families.join(" / ")} 组件）` : ""}`,
        "核对定义所在源文件是否进入 Makefile/CMake 的编译源集合及最终链接命令",
        "使用厂商驱动实现并重新构建；不得用空函数或弱符号掩盖缺失实现",
      ],
    }
  }

  const missingTarget = output.match(/No rule to make target\s+[`']?([^`'\r\n]+)[`']?/i)
  if (missingTarget) {
    const missingPath = missingTarget[1].trim()
    return {
      kind: "missing-build-input",
      missingPath,
      evidence: [`构建系统找不到输入: ${missingPath}`],
      nextActions: [
        `搜索 ${missingPath} 的真实位置和大小写`,
        "读取构建配置并核对源文件清单、相对目录和生成步骤",
        "修正配置后先做 dry-run，再执行完整构建",
      ],
    }
  }

  return undefined
}

export function diagnosticFingerprint(diagnostic: ToolDiagnostic): string {
  const identity = diagnostic.missingPath
    ?? diagnostic.symbols?.map(symbolFamily).filter(Boolean).sort().join(",")
    ?? diagnostic.evidence[0]
    ?? diagnostic.kind
  return `build:${diagnostic.kind}:${identity}`.toLowerCase()
}

function symbolFamily(symbol: string): string {
  const match = symbol.match(/^([A-Za-z][A-Za-z0-9]*)_/)
  return match?.[1] ?? symbol
}
