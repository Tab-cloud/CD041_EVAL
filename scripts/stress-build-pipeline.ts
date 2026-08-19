import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildConfigFromContext, createBuildRequest } from "../packages/core/src/runtime/build-context"
import { executeBuildRequest } from "../packages/core/src/tool/hardware/build-runner"
import { ESP_ONLY_BUILD_MESSAGE } from "../packages/core/src/runtime/esp-build-scope"

const projectCount = 12
const logCount = 5_000
const root = mkdtempSync(join(tmpdir(), "eval-build-stress-"))
process.env.EVAL_DATA_DIR = join(root, "database")
const { BuildLogRepo } = await import("../packages/core/src/store/build-log")
const { closeDb } = await import("../packages/core/src/store/database")
const { flushDiagnosticFileLog } = await import("../packages/core/src/runtime/diagnostic-file-log")
const sessionId = `build-stress-${Date.now()}`
const startedAt = Date.now()

try {
  const toolDir = join(root, "tools")
  createFakeIdfTool(toolDir)
  process.env.PATH = `${toolDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`
  assertNonEspDesignOnlyBoundary(root)

  const projects = Array.from({ length: projectCount }, (_, index) => createProject(root, index))
  const manifests = await Promise.all(projects.map(async (project) => {
    const request = createBuildRequest(buildConfigFromContext(project))
    return executeBuildRequest(request)
  }))
  const requestIds = new Set(manifests.map((manifest) => manifest.request.requestId))
  if (requestIds.size !== projectCount) throw new Error("并行构建请求 ID 出现串线")
  const failed = manifests.filter((manifest) => manifest.process.status !== "succeeded")
  if (failed.length) {
    throw new Error(`并行构建失败: ${JSON.stringify(failed.map((item) => ({
      project: item.request.projectName,
      status: item.process.status,
      stdout: item.process.stdoutTail,
      stderr: item.process.stderrTail,
    })))}`)
  }
  if (manifests.some((manifest) => !manifest.programming || !manifest.download.eligible)) {
    throw new Error("至少一个 ESP-IDF 并行构建缺少可认证下载清单")
  }
  const hashes = new Set(manifests.map((manifest) => manifest.programming!.images[0]!.sha256))
  if (hashes.size !== projectCount) throw new Error("并行构建产物哈希出现串线")

  for (let index = 0; index < logCount; index++) {
    BuildLogRepo.append(`run-${index % projectCount}`, sessionId, index + 1, {
      type: index % 13 === 0 ? "stderr" : "stdout",
      text: `line-${index}`,
    }, index)
  }
  const logs = BuildLogRepo.listBySession(sessionId, logCount)
  if (logs.length !== logCount) throw new Error(`构建日志丢失: ${logs.length}/${logCount}`)
  if ((logs[0]?.payload as { text?: string })?.text !== "line-0") throw new Error("构建日志顺序错误")
  if ((logs.at(-1)?.payload as { text?: string })?.text !== `line-${logCount - 1}`) throw new Error("构建日志尾部错误")

  console.log(JSON.stringify({
    status: "passed",
    projectCount,
    certifiedEspBundles: manifests.length,
    nonEspDesignOnlyBoundary: "passed",
    buildLogLines: logs.length,
    elapsedMs: Date.now() - startedAt,
  }))
} finally {
  BuildLogRepo.deleteBySession(sessionId)
  closeDb()
  await flushDiagnosticFileLog()
  await removeWithRetry(root)
}

async function removeWithRetry(path: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt === 49) throw error
      await Bun.sleep(200)
    }
  }
}

function createProject(parent: string, index: number): string {
  const root = join(parent, `project-${index}`)
  mkdirSync(join(root, "main"), { recursive: true })
  mkdirSync(join(root, ".eval"), { recursive: true })
  writeFileSync(join(root, ".eval", "project.toml"), [
    "[project]",
    `name = "firmware-${index}"`,
    'chip = "ESP32-C3"',
    'chip_family = "ESP32-C3"',
    "target_confirmed = true",
    'target_evidence = "stress test"',
    "",
    "[build]",
    'build_system = "idf"',
    'platform_target = "esp32c3"',
    'build_dir = "build"',
    "timeout_seconds = 60",
    "",
    "[debug]",
    'programmer = "esptool"',
    'target_cfg = "esp32c3"',
  ].join("\n"))
  writeFileSync(join(root, "CMakeLists.txt"), [
    "cmake_minimum_required(VERSION 3.16)",
    "include($ENV{IDF_PATH}/tools/cmake/project.cmake)",
    `project(firmware_${index})`,
    "",
  ].join("\n"))
  writeFileSync(join(root, "main", "CMakeLists.txt"), 'idf_component_register(SRCS "main.c" INCLUDE_DIRS ".")\n')
  writeFileSync(join(root, "main", "main.c"), `void app_main(void) { volatile int project_id = ${index}; (void)project_id; }\n`)
  return root
}

function assertNonEspDesignOnlyBoundary(parent: string): void {
  const root = join(parent, "non-esp-design")
  mkdirSync(join(root, ".eval"), { recursive: true })
  mkdirSync(join(root, "src"), { recursive: true })
  writeFileSync(join(root, ".eval", "project.toml"), [
    "[project]",
    'name = "stm32-design"',
    'chip = "STM32F103C8T6"',
    'chip_family = "STM32F1"',
    "target_confirmed = true",
    'target_evidence = "stress test"',
    "",
    "[build]",
    'build_system = "makefile"',
    "timeout_seconds = 60",
  ].join("\n"))
  writeFileSync(join(root, "Makefile"), "all:\n\t@echo must-not-run\n")
  writeFileSync(join(root, "src", "main.c"), "int main(void) { return 0; }\n")

  let rejected = false
  try {
    createBuildRequest(buildConfigFromContext(root))
  } catch (error) {
    rejected = error instanceof Error && error.message.includes(ESP_ONLY_BUILD_MESSAGE)
  }
  if (!rejected) throw new Error("非 ESP 项目绕过了内置编译边界")
  if (!existsSync(join(root, "src", "main.c"))) throw new Error("非 ESP 源码设计能力被误删")
}

function createFakeIdfTool(toolDir: string): void {
  mkdirSync(toolDir, { recursive: true })
  const source = join(toolDir, "fake-idf.ts")
  const output = join(toolDir, process.platform === "win32" ? "idf.py.exe" : "idf.py")
  writeFileSync(source, String.raw`
import { mkdirSync, writeFileSync } from "node:fs"
import { basename, isAbsolute, join, resolve } from "node:path"

const args = process.argv.slice(2)
const buildFlag = args.indexOf("-B")
const buildValue = buildFlag >= 0 ? args[buildFlag + 1] : "build"
const buildDir = isAbsolute(buildValue) ? buildValue : resolve(process.cwd(), buildValue)
const action = args.at(-1)
if (action === "set-target") {
  writeFileSync(join(process.cwd(), "sdkconfig"), "CONFIG_IDF_TARGET_ESP32C3=y\n")
  process.exit(0)
}
if (action === "fullclean") {
  process.exit(0)
}
mkdirSync(buildDir, { recursive: true })
const identity = basename(process.cwd())
const image = "firmware.bin"
writeFileSync(join(buildDir, image), new TextEncoder().encode("ESP-IDF-STRESS:" + identity))
writeFileSync(join(buildDir, "flasher_args.json"), JSON.stringify({
  flash_files: { "0x10000": image },
  extra_esptool_args: { chip: "esp32c3" },
}))
`)
  const result = Bun.spawnSync([
    process.execPath,
    "build",
    "--compile",
    source,
    "--outfile",
    output,
  ], { stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0 || !existsSync(output)) {
    throw new Error(`无法创建 ESP-IDF 压测工具: ${result.stderr.toString()}`)
  }
}
