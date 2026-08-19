# {{PROJECT_NAME}}

> 芯片: {{CHIP}} | 系列: {{CHIP_FAMILY}} | 工具链: {{TOOLCHAIN}} | HAL: {{HAL}}

## 快速开始

```bash
# 编译
mkdir -p build && cd build
cmake .. -DCMAKE_TOOLCHAIN_FILE=../cmake/arm-none-eabi.cmake
make -j$(nproc)

# 烧录 (ST-Link)
openocd -f interface/stlink.cfg -f target/{{CHIP_FAMILY_LOWER}}.cfg -c "program firmware.hex verify reset exit"

# 串口监控
minicom -D /dev/ttyUSB0 -b 115200
```

## 目录结构

```
├── src/           # 应用源代码
├── inc/           # 头文件
├── drivers/       # 外设驱动
├── lib/           # 第三方库
├── build/         # 编译输出
├── docs/          # 文档
└── tools/         # 辅助脚本
```

## 引脚分配

| 引脚 | 功能 | 方向 | 说明 |
|------|------|------|------|
<!-- 由 pin_extract 工具自动填充 -->
