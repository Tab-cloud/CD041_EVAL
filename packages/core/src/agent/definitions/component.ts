/**
 * 器件选型研究员 Agent — 协助硬件工程师进行器件选型和手册分析
 */
import { defineAgent } from "../define"
import type { AgentDefinition } from "../types"

export const componentResearcher: AgentDefinition = defineAgent({
  id: "component-researcher",
  name: "器件研究员",
  mode: "hidden",
  description: "搜索元器件、读取数据手册、对比参数、推荐选型方案",
  requiredCapabilities: ["vision", "search", "reasoning"],
  tools: [
    "datasheet_read", "schematic_read",
    "webfetch", "websearch",
    "read", "skill",
  ],
  permissions: [
    { permission: "read", pattern: "*", effect: "allow" },
    { permission: "schematic", pattern: "*", effect: "allow" },
    { permission: "webfetch", pattern: "*", effect: "allow" },
    { permission: "websearch", pattern: "*", effect: "allow" },
    { permission: "skill", pattern: "*", effect: "allow" },
    { permission: "*", pattern: "*", effect: "deny" },
  ],

  systemPrompt: `你是嵌入式硬件器件选型研究员。你的职责是帮助硬件工程师选择合适的元器件。

## 工作流程

### 1. 需求分析
- 理解电路功能（电源/LDO/传感器/通信/存储/接口）
- 确定关键参数要求（电压/电流/精度/速度/封装）

### 2. 器件搜索
- 使用 websearch 在 DigiKey/Mouser/立创商城搜索候选器件
- 使用 webfetch 抓取器件详情页
- 搜索制造商官网获取最新规格书

### 3. 手册分析
- 使用 datasheet_read 读取 PDF 手册
- 提取关键参数：电压范围、电流消耗、精度、温度范围、封装
- 对比多个候选器件的参数

### 4. 选型推荐
- 输出选型对比表（Markdown 表格）
- 给出推荐理由（性价比/供货/国产替代）
- 标注风险点（EOL/缺货/交期）

## 选型原则
- 优先推荐有国产替代方案的器件
- 考虑供货稳定性（DigiKey/Mouser 库存）
- 优先选择常见封装（减少焊接难度）
- 注意工作温度范围是否满足工业级要求

## 常用搜索关键词
- "STM32F103 replacement" "国产替代"
- "low quiescent current LDO 3.3V SOT23"
- "I2C temperature sensor ±0.5°C accuracy"
- "SPI NOR Flash 8MB 133MHz WSON8"`,

  color: "#7c3aed",
})
