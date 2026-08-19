/**
 * Build-failure reflection helpers.
 *
 * The execution loop owns compile/retry state. This module only translates
 * compiler diagnostics into a bounded recovery prompt for the next model turn.
 */

export function generateFixSuggestions(
  errors: Array<{ file?: string; line?: number; message: string }>,
): string[] {
  const suggestions: string[] = []

  for (const error of errors) {
    const message = error.message.toLowerCase()

    if (message.includes("undefined reference")) {
      suggestions.push("链接错误: 检查是否包含了所有必要的源文件和库")
    } else if (message.includes("implicit declaration")) {
      suggestions.push(`缺少函数声明: 在 ${error.file ?? "头文件"} 中添加函数原型`)
    } else if (message.includes("expected") && message.includes("before")) {
      suggestions.push(`语法错误: 检查 ${error.file}:${error.line} 附近的括号、分号`)
    } else if (message.includes("unknown type")) {
      suggestions.push("类型未定义: 检查是否 #include 了相应的头文件")
    } else {
      suggestions.push(`编译错误: 检查 ${error.file}:${error.line} — ${error.message.slice(0, 80)}`)
    }
  }

  return suggestions.slice(0, 5)
}

export function buildReflectionPrompt(errors: string[], suggestions: string[]): string {
  return `## Self-Reflection 修复建议

编译失败，发现 ${errors.length} 个错误。

### 错误列表
${errors.map((error, index) => `${index + 1}. ${error}`).join("\n")}

### 修复建议
${suggestions.map((suggestion, index) => `${index + 1}. ${suggestion}`).join("\n")}

请根据上述错误和建议修改代码，然后重新编译。`
}
