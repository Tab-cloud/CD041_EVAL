---
name: arm-debugging
description: ARM Cortex-M 调试方法论。HardFault诊断、寄存器分析、OpenOCD命令、常见问题排查。
---

## ARM Cortex-M 调试指南

### HardFault 诊断流程
1. 读取 CFSR (Configurable Fault Status Register) @ 0xE000ED28
2. 读取 HFSR (HardFault Status Register) @ 0xE000ED2C
3. 读取 stacked PC (从 MSP 偏移 0x18)
4. 在 PC 地址设置断点，重现故障

### GDB 常用命令
```
target remote :3333           # 连接 OpenOCD
monitor reset halt             # 复位并暂停
info registers                 # 查看所有寄存器
x/10x $sp                     # 查看栈内容
break main.c:42                # 设置断点
continue                       # 继续运行
```

### 常见 HardFault 原因
| 原因 | CFSR 位 | 检查 |
|------|---------|------|
| 未对齐访问 | UNALIGNED | 指针是否对齐 |
| 非法内存 | IACCVIOL/DACCVIOL | 地址是否有效 |
| 总线错误 | IBUSERR/PRECISERR | 外设地址是否正确 |
| 除零 | DIVBYZERO | 检查除数 |
| 未定义指令 | UNDEFINSTR | 是否跳转到数据区 |

### OpenOCD 启动命令
```
# ST-Link + STM32F1
openocd -f interface/stlink.cfg -f target/stm32f1x.cfg
```
