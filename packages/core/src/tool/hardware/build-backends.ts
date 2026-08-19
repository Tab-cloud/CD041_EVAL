import { existsSync } from "node:fs"
import { join } from "node:path"
import type { BuildPhase, BuildRequest } from "./build-types"

export interface BuildStep {
  phase: BuildPhase
  command: string[]
  required: boolean
}

export interface BuildPlan {
  steps: BuildStep[]
}

/** Build definitions own compiler selection. Eval only selects and drives the backend. */
export function createBuildPlan(request: BuildRequest): BuildPlan {
  switch (request.buildSystem) {
    case "makefile":
      return makePlan(request)
    case "cmake":
      return cmakePlan(request)
    case "idf":
      return idfPlan(request)
  }
}

function makePlan(request: BuildRequest): BuildPlan {
  const clean = step("clean", ["make", "-C", request.projectDir, `-j${request.jobs}`, "clean"])
  const build = step("build", ["make", "-C", request.projectDir, `-j${request.jobs}`, request.target])
  if (request.mode === "clean") return { steps: [clean] }
  if (request.mode === "rebuild") return { steps: [clean, build] }
  return { steps: [build] }
}

function cmakePlan(request: BuildRequest): BuildPlan {
  const steps: BuildStep[] = []
  const cacheExists = existsSync(join(request.buildDir, "CMakeCache.txt"))
  if (!cacheExists || request.mode === "rebuild") {
    if (request.configurePreset) {
      steps.push(step("configure", ["cmake", "--preset", request.configurePreset]))
    } else {
      const command = ["cmake", "-S", request.projectDir, "-B", request.buildDir]
      if (request.generator) command.push("-G", request.generator)
      if (request.toolchainFile) command.push(`-DCMAKE_TOOLCHAIN_FILE=${request.toolchainFile}`)
      steps.push(step("configure", command))
    }
  }
  const buildCommand = request.buildPreset
    ? ["cmake", "--build", "--preset", request.buildPreset, "--parallel", String(request.jobs)]
    : ["cmake", "--build", request.buildDir, "--target", request.target, "--parallel", String(request.jobs)]
  const cleanCommand = request.buildPreset
    ? ["cmake", "--build", "--preset", request.buildPreset, "--target", "clean"]
    : ["cmake", "--build", request.buildDir, "--target", "clean"]
  if (request.mode === "clean") return { steps: [...steps, step("clean", cleanCommand)] }
  if (request.mode === "rebuild") steps.push(step("clean", cleanCommand))
  steps.push(step("build", buildCommand))
  return { steps }
}

function idfPlan(request: BuildRequest): BuildPlan {
  const base = ["idf.py", "-B", request.buildDir]
  const configure = request.platformTarget && !existsSync(join(request.projectDir, "sdkconfig"))
    ? [step("configure", [...base, "set-target", request.platformTarget])]
    : []
  if (request.mode === "clean") return { steps: [...configure, step("clean", [...base, "fullclean"])] }
  if (request.mode === "rebuild") {
    return { steps: [...configure, step("clean", [...base, "fullclean"]), step("build", [...base, request.target === "all" ? "build" : request.target])] }
  }
  return { steps: [...configure, step("build", [...base, request.target === "all" ? "build" : request.target])] }
}

function step(phase: BuildPhase, command: string[]): BuildStep {
  return { phase, command, required: true }
}
