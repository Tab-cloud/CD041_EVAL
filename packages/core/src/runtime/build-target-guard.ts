import { isAbsolute, resolve } from "node:path"
import type { ToolResult } from "../tool/types.ts"
import { buildConfigFromContext, type BuildConfig } from "./build-context.ts"
import {
  assessTargetBuildConsistency,
  discoverLocalTargetEvidence,
  discoverSessionTargetEvidence,
  resolveVerifiedTargetFamily,
  targetBuildFamilyOptions,
  targetConfirmationOptions,
} from "./target-discovery.ts"
import { findProjectRoot, loadProjectConfig, saveProjectConfig } from "../store/project-config.ts"
import { findChip, getChipCompilerFlags } from "../knowledge/chips.ts"
import {
  assertEspBuildContract,
  ESP_ONLY_BUILD_MESSAGE,
} from "./esp-build-scope.ts"

/**
 * One authoritative target gate shared by every Agent-controlled build path.
 * Returning undefined means execution is allowed.
 */
export function evaluateBuildTargetGuard(
  projectDir: string,
  config?: BuildConfig,
  context?: { sessionId?: string },
): ToolResult | undefined {
  const bcfg = config ?? buildConfigFromContext(projectDir)
  if (bcfg.chipSource !== "project-config") {
    const sessionEvidence = context?.sessionId ? discoverSessionTargetEvidence(context.sessionId) : []
    const evidence = [...sessionEvidence, ...discoverLocalTargetEvidence(projectDir)]
    const declaredChip = loadProjectConfig(projectDir).project.chip.trim() || undefined
    const candidates = targetConfirmationOptions(projectDir, evidence, declaredChip)
    const error = bcfg.chipSource === "unconfirmed"
      ? "项目中的目标芯片尚未经过用户确认，构建已暂停。"
      : "项目没有已确认的目标芯片，构建已暂停。"
    return {
      success: false,
      error,
      data: {
        status: "target-identification-required",
        projectDir,
        declaredChip,
        sessionEvidence,
        localEvidence: evidence.filter((item) => item.origin !== "session-artifact"),
        userInteraction: {
          type: "question",
          question: candidates.length > 0
            ? "请选择当前项目实际使用的完整目标芯片型号。确认后将写入项目配置并继续原编译任务。"
            : "本地证据不足以确认目标芯片。请输入当前项目实际使用的完整芯片型号。",
          options: candidates,
        },
      },
      outcome: {
        status: "failed",
        category: "evidence",
        summary: error,
        fingerprint: `build:target-identification-required:${projectDir}`,
        diagnostic: {
          kind: "target-identification-required",
          evidence: evidence.length > 0
            ? evidence.slice(0, 12).map((item) => `${item.kind}: ${item.source}${item.candidates.length ? ` [${item.candidates.join(", ")}]` : ""}`)
            : ["本地未发现可直接证明目标芯片的构建定义、原理图、数据手册或说明文档"],
          nextActions: [
            sessionEvidence.length > 0
              ? "先使用 sessionEvidence 中右侧原理图/文档 Tab 已保存的提炼结果；同一 sourceHash 未变化时禁止重复调用 schematic_read/datasheet_read"
              : "使用 glob/grep/read 检索本地构建文件、芯片宏、数据手册和原理图",
            sessionEvidence.some((item) => item.stale)
              ? "仅对 stale=true（源文件已变化）的资料重新识别并更新会话资料库"
              : "只有现有会话资料缺少主控完整型号或验证结论冲突时，才重新调用 schematic_read/datasheet_read",
            "把本地证据和候选型号展示给用户并使用 question 请求确认；证据不足时直接询问芯片完整型号",
            "用户确认后把 chip、chip_family、target_confirmed=true 和 target_evidence 写入 .eval/project.toml",
            "重新执行原构建命令，继续原任务",
          ],
          retryable: true,
          recoveryCandidates: [{
            id: "identify-confirm-and-retry",
            summary: "复用既有资料确认目标身份并恢复原构建",
            steps: [
              {
                instruction: "读取已有会话资料和本地构建定义，提取目标芯片证据",
                tools: ["read", "grep", "glob", "schematic_read", "datasheet_read"],
                effects: ["workspace-read"],
              },
              {
                instruction: "只对缺失或已变化的原理图/数据手册证据重新核验",
                tools: ["read", "schematic_read", "datasheet_read"],
                effects: ["workspace-read", "network"],
              },
              {
                instruction: "向用户展示候选证据并请求确认",
                tools: ["question"],
                effects: ["user-interaction"],
              },
              {
                instruction: "持久化用户确认的目标配置",
                tools: ["edit", "write", "chip_add"],
                effects: ["workspace-write"],
              },
              {
                instruction: "重新执行原构建命令并验证产物",
                tools: ["compile", "bash"],
                effects: ["process"],
              },
            ],
          }],
        },
      },
    }
  }

  try {
    const espTarget = assertEspBuildContract({
      projectRoot: bcfg.projectRoot,
      chipModel: bcfg.chipModel,
      buildSystem: bcfg.buildSystem,
      platformTarget: bcfg.platformTarget,
    })
    // ESP-IDF owns compiler flags and linker inputs. The confirmed chip
    // registry edge plus exact platform_target is the authoritative build
    // identity; applying the legacy GCC macro heuristic would create a false
    // request for Arm-style CPU evidence.
    if (bcfg.buildSystem === "idf"
      && bcfg.platformTarget?.toLowerCase() === espTarget.buildTarget.toLowerCase()) {
      return
    }
  } catch (error) {
    const summary = error instanceof Error ? error.message : ESP_ONLY_BUILD_MESSAGE
    return {
      success: false,
      error: summary,
      data: {
        status: "unsupported-build-platform",
        projectDir,
        chipModel: bcfg.chipModel,
        buildSystem: bcfg.buildSystem,
      },
      outcome: {
        status: "failed",
        category: "build",
        summary,
        fingerprint: `build:unsupported-platform:${projectDir}:${bcfg.chipModel ?? "unknown"}`,
        diagnostic: {
          kind: "unsupported-build-platform",
          evidence: [
            `已确认芯片: ${bcfg.chipModel ?? "未知"}`,
            `项目构建后端: ${bcfg.buildSystem}`,
          ],
          nextActions: [
            "继续使用 Eval 进行源码编写、驱动设计、代码审查和工程文件维护",
            "在对应厂商 IDE 或用户自备工具链中手动编译当前非 ESP 工程",
            "如需使用 Eval 内置编译，请打开原生 ESP-IDF 项目并确认 Espressif 芯片型号",
          ],
        },
      },
    }
  }

  const projectConfig = loadProjectConfig(projectDir)
  const knownChip = findChip(bcfg.chipModel!, bcfg.projectRoot)
  const localEvidence = discoverLocalTargetEvidence(projectDir)
  const sessionEvidence = context?.sessionId ? discoverSessionTargetEvidence(context.sessionId) : []
  const verifiedFamily = resolveVerifiedTargetFamily(
    bcfg.chipModel!,
    localEvidence,
    sessionEvidence,
  )
  const resolvedFamily = projectConfig.project.chip_family.trim()
    || knownChip?.family?.trim()
    || verifiedFamily?.family
  if (!projectConfig.project.chip_family.trim() && resolvedFamily) {
    projectConfig.project.chip_family = resolvedFamily
    projectConfig.project.target_evidence = appendTargetEvidence(
      projectConfig.project.target_evidence,
      knownChip?.family
        ? "项目芯片库中的产品型号到 MCU 族关系"
        : `会话资料与构建定义交叉验证（${verifiedFamily!.sources.join("、")}）`,
    )
    saveProjectConfig(bcfg.projectRoot, projectConfig)
  }
  const consistency = assessTargetBuildConsistency(projectDir, {
    model: bcfg.chipModel!,
    // The canonical chip registry is part of the target identity. A SiP or
    // module name often differs from the MCU family used by the toolchain.
    // Never throw that relationship away merely because an older project
    // config omitted chip_family.
    family: resolvedFamily,
    expectedCpuFlags: knownChip ? getChipCompilerFlags(knownChip).full : undefined,
  }, localEvidence)
  if (consistency.verdict === "consistent") return

  const conflict = consistency.verdict === "conflict"
  const error = conflict
    ? "已确认的目标芯片与项目构建定义不一致，构建已拒绝。"
    : "无法证明项目构建定义属于已确认的目标芯片，构建已暂停。"
  const recoveryActions = conflict
    ? [
        "读取产生冲突的 Makefile、CMake、芯片宏、CPU 参数和链接脚本，确认它们实际面向的芯片",
        "使用现有会话原理图、数据手册和项目芯片库证据核验主控型号与底层 MCU 族",
        "使用 question 向用户展示双方证据并确认应保留的目标身份；不得自行改写已确认型号",
        "根据用户确认结果修正项目目标配置或构建定义；禁止仅为通过门禁而改标签",
        "重新执行原构建命令并验证产物",
      ]
    : [
        "读取 Makefile、CMake、芯片宏、CPU 参数和链接脚本，提取底层构建身份",
        "使用现有会话原理图、数据手册和项目芯片库补全产品型号到 MCU 族的规范关系",
        "若本地权威证据仍不足，使用 question 询问用户底层 MCU 或芯片族；不得猜测",
        "把有证据的 chip_family 写入项目配置或项目芯片库",
        "重新执行原构建命令并验证产物",
      ]
  const familyOptions = conflict ? [] : targetBuildFamilyOptions(consistency.evidence)
  return {
    success: false,
    error,
    data: {
      status: conflict ? "target-build-conflict" : "target-build-evidence-required",
      consistency,
      ...(familyOptions.length > 0 ? {
        userInteraction: {
          type: "question",
          purpose: "target-family-confirmation",
          question: `已确认主控产品型号 ${bcfg.chipModel}，但缺少它与底层构建芯片族的可验证关系。请选择实际 MCU/芯片族，确认后将继续原构建任务。`,
          options: familyOptions,
        },
      } : {}),
    },
    outcome: {
      status: "failed",
      category: "evidence",
      summary: error,
      fingerprint: `build:${conflict ? "target-build-conflict" : "target-build-evidence-required"}:${projectDir}`,
      diagnostic: {
        kind: conflict ? "target-build-conflict" : "target-build-evidence-required",
        evidence: consistency.reasons,
        nextActions: recoveryActions,
        retryable: true,
        recoveryCandidates: [{
          id: conflict ? "resolve-target-conflict" : "prove-build-family",
          summary: conflict ? "修正目标身份与构建定义冲突" : "补全产品型号与构建芯片族证据",
          steps: [
            {
              instruction: recoveryActions[0]!,
              tools: ["read", "grep", "glob"],
              effects: ["workspace-read"],
            },
            {
              instruction: recoveryActions[1]!,
              tools: ["read", "schematic_read", "datasheet_read"],
              effects: ["workspace-read", "network"],
            },
            {
              instruction: recoveryActions[2]!,
              tools: ["question"],
              effects: ["user-interaction"],
            },
            {
              instruction: recoveryActions[3]!,
              tools: ["edit", "write", "chip_add"],
              effects: ["workspace-write"],
            },
            {
              instruction: recoveryActions[4]!,
              tools: ["compile", "bash"],
              effects: ["process"],
            },
          ],
        }],
      },
    },
  }
}

/**
 * Commit a real user's target confirmation before retrying the suspended
 * build. This is runtime-owned state transition, not an instruction left for
 * the LLM to implement.
 */
export function persistConfirmedBuildTarget(
  projectDir: string,
  answer: string,
): ToolResult {
  const model = answer.trim()
  if (!/^[A-Za-z][A-Za-z0-9._+-]{1,63}$/.test(model)) {
    return {
      success: false,
      error: "目标芯片型号格式无效，未修改项目配置。",
      outcome: {
        status: "failed",
        category: "evidence",
        summary: "目标芯片型号格式无效",
        fingerprint: `build:invalid-confirmed-target:${projectDir}`,
      },
    }
  }
  const projectRoot = findProjectRoot(projectDir) ?? projectDir
  const config = loadProjectConfig(projectDir)
  const sameDeclaredTarget = normalizeTarget(model) === normalizeTarget(config.project.chip)
  const knownChip = findChip(model, projectRoot)
  config.project.chip = model
  config.project.chip_family = sameDeclaredTarget
    ? config.project.chip_family.trim() || (knownChip?.family ?? "")
    : knownChip?.family ?? ""
  config.project.target_confirmed = true
  config.project.target_evidence = "用户在构建目标确认弹窗中明确选择"
  try {
    saveProjectConfig(projectRoot, config)
  } catch (error) {
    return {
      success: false,
      error: `保存目标芯片配置失败: ${error instanceof Error ? error.message : String(error)}`,
      outcome: {
        status: "failed",
        category: "evidence",
        summary: "无法保存用户确认的目标芯片",
        fingerprint: `build:target-confirmation-write-failed:${projectRoot}`,
      },
    }
  }
  return {
    success: true,
    data: {
      status: "target-confirmed",
      projectRoot,
      chip: config.project.chip,
      chipFamily: config.project.chip_family,
    },
  }
}

/** Persist only the missing MCU/build-family edge for an already confirmed product. */
export function persistConfirmedBuildFamily(
  projectDir: string,
  answer: string,
): ToolResult {
  const family = answer.trim()
  if (!/^[A-Za-z][A-Za-z0-9._+-]{1,63}$/.test(family)) {
    return {
      success: false,
      error: "芯片族格式无效，未修改项目配置。",
      outcome: {
        status: "failed",
        category: "evidence",
        summary: "芯片族格式无效",
        fingerprint: `build:invalid-confirmed-family:${projectDir}`,
      },
    }
  }
  const projectRoot = findProjectRoot(projectDir) ?? projectDir
  const config = loadProjectConfig(projectRoot)
  if (!config.project.chip.trim() || !config.project.target_confirmed) {
    return {
      success: false,
      error: "主控产品型号尚未确认，不能单独确认芯片族。",
      outcome: {
        status: "failed",
        category: "evidence",
        summary: "缺少已确认的主控产品型号",
        fingerprint: `build:family-without-target:${projectRoot}`,
      },
    }
  }
  config.project.chip_family = family
  config.project.target_evidence = appendTargetEvidence(
    config.project.target_evidence,
    "用户在构建芯片族确认弹窗中明确选择",
  )
  try {
    saveProjectConfig(projectRoot, config)
  } catch (error) {
    return {
      success: false,
      error: `保存芯片族配置失败: ${error instanceof Error ? error.message : String(error)}`,
      outcome: {
        status: "failed",
        category: "evidence",
        summary: "无法保存用户确认的芯片族",
        fingerprint: `build:family-confirmation-write-failed:${projectRoot}`,
      },
    }
  }
  return {
    success: true,
    data: {
      status: "target-family-confirmed",
      projectRoot,
      chip: config.project.chip,
      chipFamily: config.project.chip_family,
    },
  }
}

/** Resolve the embedded project affected by a shell build command. */
export function resolveShellBuildProject(command: string, cwd: string): string | undefined {
  if (!isEmbeddedBuildCommand(command)) return
  const cd = command.match(/(?:^|[;&|]\s*)cd(?:\s+\/d)?\s+(?:"([^"]+)"|'([^']+)'|([^&|;\r\n]+?))\s*(?:&&|&|;)/i)
  const effectiveCwd = cd ? resolveAgainst(cwd, (cd[1] ?? cd[2] ?? cd[3]!).trim()) : cwd
  const makeC = command.match(/\b(?:mingw32-)?make(?:\.exe)?\b[^&|;\r\n]*?\s-C\s+(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))/i)
  if (makeC) return resolveAgainst(effectiveCwd, makeC[1] ?? makeC[2] ?? makeC[3]!)
  const cmakeSource = command.match(/\bcmake(?:\.exe)?\b[^&|;\r\n]*?\s-S\s+(?:"([^"]+)"|'([^']+)'|([^\s&|;]+))/i)
  if (cmakeSource) return resolveAgainst(effectiveCwd, cmakeSource[1] ?? cmakeSource[2] ?? cmakeSource[3]!)
  return effectiveCwd
}

export function isEmbeddedBuildCommand(command: string): boolean {
  return command.split(/&&|\|\||[;&|]/).some((part) => {
    let segment = part.trim().replace(/^call\s+/i, "")
    if (!segment || /^cd(?:\s|$)/i.test(segment)) return false
    const executableMatch = segment.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))(.*)$/)
    if (!executableMatch) return false
    const executable = (executableMatch[1] ?? executableMatch[2] ?? executableMatch[3]!)
      .split(/[\\/]/).pop()!.toLowerCase()
      .replace(/\.exe$/, "")
    const args = executableMatch[4] ?? ""
    if (executable === "make" || executable === "mingw32-make" || executable === "ninja") return true
    if (executable === "cmake") return /(?:^|\s)(?:--build|-S|-B)(?:\s|$)/i.test(args)
    return /^(?:arm-none-eabi-|riscv(?:32|64)?-[a-z0-9-]*|xtensa-[a-z0-9-]*)?(?:gcc|g\+\+)$/.test(executable)
  })
}

function resolveAgainst(cwd: string, path: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path)
}

function normalizeTarget(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function appendTargetEvidence(existing: string | undefined, evidence: string): string {
  return [...new Set([existing?.trim(), evidence].filter((item): item is string => Boolean(item)))]
    .join("；")
}
