/**
 * lvgl_gen 工具 — LVGL 屏幕 UI 代码生成
 *
 * 根据用户描述生成 LVGL 初始化代码、屏幕布局、样式定义、事件回调。
 * 当前生成 LVGL v8.x 集成骨架；硬件刷新函数必须由后续实现和编译验证完成。
 */
import { defineTool } from "../define.ts"
import type { ToolResult } from "../types.ts"

export const lvglGenTool = defineTool({
  name: "lvgl_gen",
  description: `生成 LVGL 屏幕 UI 代码。

功能：
- 根据描述生成 LVGL 初始化代码 (显示驱动 + 输入设备 + Tick)
- 生成屏幕布局 (Screen → Container → Widget 层级)
- 生成样式定义代码 (背景色、边框、字体、圆角等)
- 生成事件回调代码 (按钮点击、滑块变化、开关切换)
- 生成 lv_conf.h 推荐配置
- 支持 SPI (ST7789/ILI9341) 和 I2C (SSD1306) 屏幕
- 内存优化建议

参数：
- screenType: 屏幕驱动型号 (st7789 / ili9341 / ssd1306 / gc9a01)
- interface: 通信接口 (spi / i2c / 8080)
- resolution: 分辨率 (如 "240x320")
- colorDepth: 色深 (16 / 24)
- layout: UI 布局描述 (如 "顶部状态栏 + 中间图表区域 + 底部3个按钮")
- widgets: 需要的控件列表 (如 ["label", "button", "slider", "chart", "arc"])
- lvglVersion: LVGL 版本（当前仅支持 8）
- touchEnabled: 是否有触摸屏 (默认 true)`,

  permission: "read",
  parameters: {
    type: "object",
    properties: {
      screenType: { type: "string", description: "屏幕驱动型号" },
      interface: { type: "string", enum: ["spi", "i2c", "8080", "rgb"], description: "通信接口" },
      resolution: { type: "string", description: "分辨率 (宽x高)" },
      colorDepth: { type: "number", description: "色深 (16/24)" },
      layout: { type: "string", description: "UI 布局描述" },
      widgets: { type: "array", items: { type: "string" }, description: "需要的控件" },
      lvglVersion: { type: "number", enum: [8], description: "LVGL 版本（仅支持 8）" },
      touchEnabled: { type: "boolean", description: "是否启用触摸" },
    },
    required: ["screenType", "resolution"],
  },

  // This tool is a pure generator: it returns a scaffold but does not write the
  // workspace. Only a later write/edit call may create mutation evidence.
  contract: { effects: [], idempotency: "read-only", cancellation: "unsupported", progress: { role: "control" } },

  async execute(params, _ctx): Promise<ToolResult> {
    const screenType = (params.screenType as string).toLowerCase()
    const iface = (params.interface as string) ?? "spi"
    const resolution = (params.resolution as string) ?? "240x320"
    const colorDepth = (params.colorDepth as number) ?? 16
    const layout = params.layout as string | undefined
    const widgets = (params.widgets as string[]) ?? ["label", "button"]
    const version = (params.lvglVersion as number) ?? 8
    const touch = params.touchEnabled !== false
    if (version !== 8) return { success: false, error: "当前代码生成模板仅支持 LVGL v8" }

    // 校验分辨率格式，防止生成非法 C 代码
    if (!/^\d+x\d+$/.test(resolution)) {
      return { success: false, error: `非法分辨率格式: ${resolution}（需为 宽x高，如 240x320）` }
    }
    const [width, height] = resolution.split("x").map(Number)

    // 1. 生成 lv_conf.h 配置建议
    const lvConf = generateLvConf(width, height, colorDepth, version)

    // 2. 生成显示驱动初始化代码
    const displayInit = generateDisplayInit(screenType, iface, width, height)

    // 3. 生成 UI 代码
    const uiCode = generateUICode(layout, widgets, width, height)

    // 4. 合成完整文件
    const fullCode = `/**
 * @file    ui.c
 * @brief   LVGL UI 代码 - 自动生成
 * @screen  ${screenType.toUpperCase()} ${resolution} ${iface.toUpperCase()}
 * @lvgl    v${version}.x
 * @generated 由 lvgl_gen 工具生成
 */

#include "lvgl.h"
#include "ui.h"

static void display_flush(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_p);
static void btn_event_cb(lv_event_t *event);
${touch ? "__attribute__((weak)) void touch_init(void) {}\n" : ""}

/* ═══════ 显示驱动初始化 ═══════ */
${displayInit}

/* ═══════ UI 初始化 ═══════ */
void ui_init(void) {
    lv_init();
    display_init();
${touch ? "    touch_init();\n" : ""}

${uiCode}
}

void ui_process(void) {
    lv_timer_handler();
}

static void btn_event_cb(lv_event_t *event) {
    (void)event;
}
`

    return {
      success: true,
      data: {
        completion: "scaffold",
        screenType,
        resolution: `${width}x${height}`,
        interface: iface,
        lvglVersion: `v${version}.x`,
        touchEnabled: touch,
        widgets,
        files: {
          "ui.c": fullCode,
          "ui.h": `#ifndef UI_H\n#define UI_H\n\nvoid ui_init(void);\nvoid ui_process(void);\n\n#endif\n`,
          "lv_conf.h (推荐)": lvConf,
        },
        memoryEstimate: estimateMemory(width, height, colorDepth),
        pinConfig: getPinConfig(screenType, iface),
        instruction: "这是集成骨架，不是已完成驱动。请通过 write/edit 写入项目，实现 display_flush 后再编译验证。",
      },
    }
  },
})

// ══════════════════════════════════════════════════
// 代码生成
// ══════════════════════════════════════════════════

function generateLvConf(width: number, height: number, depth: number, ver: number): string {
  const colorDepthDefine = ver >= 9
    ? `#define LV_COLOR_DEPTH ${depth}`
    : `#define LV_COLOR_DEPTH      ${depth}`

  return `/* lv_conf.h — ${width}x${height} ${depth}-bit 推荐配置 */
#define LV_HOR_RES_MAX         ${width}
#define LV_VER_RES_MAX         ${height}
${colorDepthDefine}
#define LV_COLOR_16_SWAP       0
#define LV_MEM_SIZE             (${Math.max(32, Math.ceil(width * height * depth / 8 / 1024))}U * 1024U)
#define LV_DISP_DEF_REFR_PERIOD 30
#define LV_INDEV_DEF_READ_PERIOD 30
#define LV_TICK_CUSTOM          1
#define LV_USE_LOG              1
#define LV_USE_ASSERT_NULL      1
#define LV_USE_ASSERT_MALLOC    1
#define LV_FONT_MONTSERRAT_14   1
#define LV_FONT_MONTSERRAT_20   1
#define LV_USE_THEME_DEFAULT    1
`
}

function generateDisplayInit(
  screen: string,
  iface: string,
  width: number,
  height: number,
): string {
  if (iface === "spi") {
    return `/* SPI 显示驱动 (${screen.toUpperCase()}) */
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf[${width} * ${Math.min(height, 40)}];

void display_init(void) {
    lv_disp_draw_buf_init(&draw_buf, buf, NULL, ${width * Math.min(height, 40)});
    
    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = ${width};
    disp_drv.ver_res = ${height};
    disp_drv.flush_cb = display_flush;
    disp_drv.draw_buf = &draw_buf;
    lv_disp_drv_register(&disp_drv);
}

static void display_flush(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_p) {
    (void)area;
    (void)color_p;
    /* TODO: 实现 SPI 刷新逻辑 */
    lv_disp_flush_ready(drv);
}`
  }

  if (iface === "i2c") {
    return `/* I2C 显示驱动 (${screen.toUpperCase()}) */
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf[${Math.max(1, Math.floor(width * height / 8))}];

void display_init(void) {
    lv_disp_draw_buf_init(&draw_buf, buf, NULL, ${width * height / 8});
    
    static lv_disp_drv_t disp_drv;
    lv_disp_drv_init(&disp_drv);
    disp_drv.hor_res = ${width};
    disp_drv.ver_res = ${height};
    disp_drv.flush_cb = display_flush;
    disp_drv.draw_buf = &draw_buf;
    lv_disp_drv_register(&disp_drv);
}

static void display_flush(lv_disp_drv_t *drv, const lv_area_t *area, lv_color_t *color_p) {
    (void)area;
    (void)color_p;
    lv_disp_flush_ready(drv);
}`
  }

  return `/* TODO: 实现 ${iface} 显示驱动 */`
}

function generateUICode(
  layout: string | undefined,
  widgets: string[],
  width: number,
  height: number,
): string {
  const parts: string[] = []

  parts.push(`    /* ═══ 创建主屏幕 ═══ */`)
  parts.push(`    lv_obj_t *scr = lv_scr_act();`)
  parts.push(`    lv_obj_set_style_bg_color(scr, lv_color_hex(0x1A1A2E), 0);`)
  parts.push(``)

  // 根据 layout 描述生成层次结构（移除 C 注释结束符，防止 layout 内容注入 C 代码）
  if (layout) {
    const safeLayout = layout.replace(/\*\//g, "* /")
    parts.push(`    /* 布局: ${safeLayout} */`)
    parts.push(``)
  }

  // 生成控件
  for (const widget of widgets) {
    switch (widget.toLowerCase()) {
      case "label":
        parts.push(`    /* ─── 标签 ─── */`)
        parts.push(`    lv_obj_t *label = lv_label_create(scr);`)
        parts.push(`    lv_label_set_text(label, "Hello LVGL");`)
        parts.push(`    lv_obj_set_style_text_color(label, lv_color_hex(0xFFFFFF), 0);`)
        parts.push(`    lv_obj_center(label);`)
        parts.push(``)
        break

      case "button":
        parts.push(`    /* ─── 按钮 ─── */`)
        parts.push(`    lv_obj_t *btn = lv_btn_create(scr);`)
        parts.push(`    lv_obj_set_size(btn, 100, 40);`)
        parts.push(`    lv_obj_align(btn, LV_ALIGN_BOTTOM_MID, 0, -20);`)
        parts.push(``)
        parts.push(`    lv_obj_t *btn_label = lv_label_create(btn);`)
        parts.push(`    lv_label_set_text(btn_label, "OK");`)
        parts.push(`    lv_obj_center(btn_label);`)
        parts.push(``)
        parts.push(`    lv_obj_add_event_cb(btn, btn_event_cb, LV_EVENT_CLICKED, NULL);`)
        parts.push(``)
        break

      case "slider":
        parts.push(`    /* ─── 滑块 ─── */`)
        parts.push(`    lv_obj_t *slider = lv_slider_create(scr);`)
        parts.push(`    lv_obj_set_size(slider, ${Math.floor(width * 0.7)}, 10);`)
        parts.push(`    lv_obj_center(slider);`)
        parts.push(`    lv_slider_set_range(slider, 0, 100);`)
        parts.push(`    lv_slider_set_value(slider, 50, LV_ANIM_OFF);`)
        parts.push(``)
        break

      case "chart":
        parts.push(`    /* ─── 图表 ─── */`)
        parts.push(`    lv_obj_t *chart = lv_chart_create(scr);`)
        parts.push(`    lv_obj_set_size(chart, ${Math.floor(width * 0.8)}, ${Math.floor(height * 0.4)});`)
        parts.push(`    lv_obj_align(chart, LV_ALIGN_TOP_MID, 0, 10);`)
        parts.push(`    lv_chart_set_type(chart, LV_CHART_TYPE_LINE);`)
        parts.push(`    lv_chart_set_point_count(chart, 30);`)
        parts.push(`    lv_chart_series_t *ser = lv_chart_add_series(chart, lv_palette_main(LV_PALETTE_GREEN), LV_CHART_AXIS_PRIMARY_Y);`)
        parts.push(``)
        break

      case "arc":
        parts.push(`    /* ─── 弧形仪表 ─── */`)
        parts.push(`    lv_obj_t *arc = lv_arc_create(scr);`)
        parts.push(`    lv_obj_set_size(arc, 120, 120);`)
        parts.push(`    lv_obj_center(arc);`)
        parts.push(`    lv_arc_set_range(arc, 0, 100);`)
        parts.push(`    lv_arc_set_value(arc, 60);`)
        parts.push(``)
        break

      case "switch":
        parts.push(`    /* ─── 开关 ─── */`)
        parts.push(`    lv_obj_t *sw = lv_switch_create(scr);`)
        parts.push(`    lv_obj_align(sw, LV_ALIGN_TOP_RIGHT, -20, 20);`)
        parts.push(``)
        break
    }
  }

  return parts.join("\n")
}

// ══════════════════════════════════════════════════
// 辅助
// ══════════════════════════════════════════════════

function estimateMemory(width: number, height: number, depth: number): Record<string, string> {
  const frameBuffer = (width * height * depth / 8 / 1024).toFixed(1)
  const doubleBuffer = (width * height * depth / 8 / 1024 * 2).toFixed(1)
  return {
    singleBuffer: `${frameBuffer} KB`,
    doubleBuffer: `${doubleBuffer} KB`,
    recommendation: `LV_MEM_SIZE 建议 >= ${Math.ceil(parseFloat(doubleBuffer) + 32)} KB`,
  }
}

function getPinConfig(screen: string, iface: string): Record<string, string> {
  const configs: Record<string, Record<string, string>> = {
    st7789: { spi: "SCK=PA5 MOSI=PA7 DC=PB0 RST=PB1 CS=PA4 BLK=PB10" },
    ili9341: { spi: "SCK=PA5 MOSI=PA7 DC=PB0 RST=PB1 CS=PA4 BLK=PB10" },
    ssd1306: { i2c: "SCL=PB6 SDA=PB7 ADDR=0x3C" },
    gc9a01: { spi: "SCK=PA5 MOSI=PA7 DC=PB0 RST=PB1 CS=PA4 BLK=PB10" },
  }
  return configs[screen]?.[iface]
    ? { [screen]: configs[screen][iface] }
    : { tip: "请根据硬件连接配置引脚" }
}
