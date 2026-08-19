/**
 * @file    main.c
 * @brief   {{PROJECT_NAME}} - 主程序入口
 * @chip    {{CHIP}}
 */

#include "main.h"
#include "pinmap.h"
#include <stdio.h>

/* ─── 全局变量 ─── */
UART_HandleTypeDef huart1;

/* ─── 系统时钟配置 ─── */
void SystemClock_Config(void) {
    RCC_OscInitTypeDef RCC_OscInitStruct = {0};
    RCC_ClkInitTypeDef RCC_ClkInitStruct = {0};

    /* HSE 8MHz → PLL ×9 → 72MHz SYSCLK */
    RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;
    RCC_OscInitStruct.HSEState = RCC_HSE_ON;
    RCC_OscInitStruct.HSEPredivValue = RCC_HSE_PREDIV_DIV1;
    RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
    RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
    RCC_OscInitStruct.PLL.PLLMUL = RCC_PLL_MUL9;
    HAL_RCC_OscConfig(&RCC_OscInitStruct);

    /* AHB=72MHz, APB1=36MHz, APB2=72MHz */
    RCC_ClkInitStruct.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK
                                | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
    RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
    RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV2;
    RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV1;
    HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_2);
}

/* ─── UART 初始化 ─── */
void UART1_Init(void) {
    __HAL_RCC_USART1_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();

    /* PA9=TX, PA10=RX */
    GPIO_InitTypeDef gpio = {0};
    gpio.Pin = GPIO_PIN_9 | GPIO_PIN_10;
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    HAL_GPIO_Init(GPIOA, &gpio);

    huart1.Instance = USART1;
    huart1.Init.BaudRate = 115200;
    huart1.Init.WordLength = UART_WORDLENGTH_8B;
    huart1.Init.StopBits = UART_STOPBITS_1;
    huart1.Init.Parity = UART_PARITY_NONE;
    huart1.Init.Mode = UART_MODE_TX_RX;
    HAL_UART_Init(&huart1);
}

/* ─── printf 重定向到 UART1 ─── */
int _write(int fd, char *ptr, int len) {
    HAL_UART_Transmit(&huart1, (uint8_t *)ptr, len, 100);
    return len;
}

/* ─── 主函数 ─── */
int main(void) {
    /* HAL 初始化 */
    HAL_Init();

    /* 时钟配置 */
    SystemClock_Config();

    /* UART 初始化 */
    UART1_Init();

    /* 用户初始化 */
    printf("\r\n=== {{PROJECT_NAME}} Starting ===\r\n");
    printf("Chip: {{CHIP}} @ 72MHz\r\n");

    /* 主循环 */
    while (1) {
        /* TODO: 用户应用逻辑 */
        HAL_Delay(1000);
        printf("Heartbeat\r\n");
    }
}

/* ─── 错误处理 ─── */
void Error_Handler(void) {
    __disable_irq();
    while (1) {
        /* 错误死循环 - 可在此添加 LED 闪烁指示 */
    }
}

/* ─── HardFault 处理 ─── */
void HardFault_Handler(void) {
    while (1) {
        /* HardFault - 连接调试器查看 CFSR/HFSR 寄存器 */
    }
}
