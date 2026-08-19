---
name: stm32-hal
description: STM32 HAL 库开发技能。GPIO/UART/SPI/I2C/ADC/TIM/DMA 初始化模板和最佳实践。
---

## STM32 HAL 开发指南

### 时钟配置模板
```c
void SystemClock_Config(void) {
    RCC_OscInitTypeDef osc = {0};
    osc.OscillatorType = RCC_OSCILLATORTYPE_HSE;
    osc.HSEState = RCC_HSE_ON;
    osc.PLL.PLLState = RCC_PLL_ON;
    osc.PLL.PLLSource = RCC_PLLSOURCE_HSE;
    osc.PLL.PLLMUL = RCC_PLL_MUL9;  // 8MHz * 9 = 72MHz
    HAL_RCC_OscConfig(&osc);
}
```

### GPIO 初始化
- 输出推挽: `GPIO_MODE_OUTPUT_PP` + `GPIO_NOPULL`
- 输入上拉: `GPIO_MODE_INPUT` + `GPIO_PULLUP`
- 必须使能时钟: `__HAL_RCC_GPIOx_CLK_ENABLE()`

### UART 配置要点
- TX/RX 引脚设为 `GPIO_MODE_AF_PP` + `GPIO_PULLUP`
- 常用波特率: 115200, 9600
- 接收中断: `HAL_UART_Receive_IT()`
- printf 重定向: 实现 `_write()` 函数

### SPI 配置要点
- CPOL/CPHA 必须与从设备匹配
- 软件 NSS: `SPI_NSS_SOFT`
- DMA 传输: 使用 `HAL_SPI_Transmit_DMA()`

### I2C 配置要点
- 外部上拉电阻 4.7kΩ 必须有
- 标准模式 100kHz, 快速模式 400kHz
- 7位地址, 检查设备地址冲突

### 引脚数量速查 (STM32F1)
| 封装 | GPIO | UART | SPI | I2C | ADC |
|------|------|------|-----|-----|-----|
| LQFP48 | 37 | 3 | 2 | 2 | 10ch |
| LQFP64 | 51 | 3 | 2 | 2 | 16ch |
| LQFP100 | 80 | 5 | 3 | 2 | 16ch |
