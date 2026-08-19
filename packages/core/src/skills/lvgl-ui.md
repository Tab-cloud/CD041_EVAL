---
name: lvgl-ui
description: LVGL 嵌入式图形界面开发。显示驱动、控件使用、事件回调、内存优化。
---

## LVGL UI 开发指南

### 快速启动
```c
lv_init();
lv_disp_draw_buf_init(&draw_buf, buf, NULL, BUF_SIZE);
lv_disp_drv_init(&disp_drv);
disp_drv.flush_cb = display_flush;
disp_drv.hor_res = 240;
disp_drv.ver_res = 320;
lv_disp_drv_register(&disp_drv);
```

### 常用控件速查
| 控件 | 函数 | 用途 |
|------|------|------|
| Label | `lv_label_create()` | 文本显示 |
| Button | `lv_btn_create()` | 按钮 |
| Slider | `lv_slider_create()` | 滑块 |
| Chart | `lv_chart_create()` | 图表 |
| Arc | `lv_arc_create()` | 弧形仪表 |

### 内存配置建议
- 分辨率 240x320: LV_MEM_SIZE >= 32KB
- 分辨率 320x480: LV_MEM_SIZE >= 64KB
- 双缓冲区: 内存翻倍但刷新更流畅

### 屏幕驱动速查
| 驱动 | 接口 | 分辨率 |
|------|------|--------|
| ST7789 | SPI | 240x320 |
| ILI9341 | SPI | 320x240 |
| SSD1306 | I2C | 128x64 |
| GC9A01 | SPI | 240x240 (圆形) |

### 优化建议
- 使用 DMA 传输 SPI 数据
- lv_timer_handler() 每 5ms 调用一次
- 1ms SysTick 作为 lv_tick
