---
name: freertos
description: FreeRTOS 实时操作系统集成。任务创建、队列、信号量、软件定时器配置。
---

## FreeRTOS 集成指南

### FreeRTOSConfig.h 关键配置
```c
#define configCPU_CLOCK_HZ           (72000000)
#define configTICK_RATE_HZ           (1000)
#define configMAX_PRIORITIES         (8)
#define configMINIMAL_STACK_SIZE     (128)
#define configTOTAL_HEAP_SIZE        ((size_t)(15 * 1024))
```

### 任务创建模板
```c
void vTaskFunction(void *pvParameters) {
    for (;;) {
        // Task logic
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

xTaskCreate(vTaskFunction, "TaskName", 256, NULL, 2, NULL);
```

### 堆栈大小建议
- 简单任务: 128-256 words
- UART/日志任务: 256-512 words
- 复杂协议任务: 512-1024 words
- 使用 uxTaskGetStackHighWaterMark() 检查实际使用量

### 优先级分配原则
- 硬实时任务 > 软实时任务 > 后台任务
- 空闲任务优先级最低 (0)
- 定时器任务建议 priority >= 2

### 常见问题
- 堆栈溢出 → 增大 configMINIMAL_STACK_SIZE
- 任务饿死 → 检查高优先级任务是否阻塞
- 死锁 → 互斥信号量，避免嵌套锁
