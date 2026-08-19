cmake_minimum_required(VERSION 3.20)
project({{PROJECT_NAME}} C ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# ─── 工具链 ───
set(TOOLCHAIN_PREFIX arm-none-eabi-)
set(CMAKE_C_COMPILER ${TOOLCHAIN_PREFIX}gcc)
set(CMAKE_ASM_COMPILER ${TOOLCHAIN_PREFIX}gcc)
set(CMAKE_OBJCOPY ${TOOLCHAIN_PREFIX}objcopy)
set(CMAKE_SIZE ${TOOLCHAIN_PREFIX}size)

# ─── 芯片定义 ───
add_definitions(-D{{CHIP}} -D{{CHIP_FAMILY}} -DUSE_HAL_DRIVER)

# ─── 编译选项 ───
set(CPU_FLAGS "-mcpu=cortex-m3 -mthumb")
set(COMMON_FLAGS "${CPU_FLAGS} -Wall -Wextra -Os -g3 -ffunction-sections -fdata-sections")
set(CMAKE_C_FLAGS "${COMMON_FLAGS} -std=gnu11" CACHE INTERNAL "")
set(CMAKE_ASM_FLAGS "${CPU_FLAGS} -x assembler-with-cpp" CACHE INTERNAL "")
set(CMAKE_EXE_LINKER_FLAGS "${CPU_FLAGS} -T${CMAKE_SOURCE_DIR}/{{CHIP_LOWER}}.ld -Wl,--gc-sections -lm -lnosys -Wl,--print-memory-usage" CACHE INTERNAL "")

# ─── HAL 库路径 ───
set(HAL_DIR ${CMAKE_SOURCE_DIR}/lib/{{HAL_LIB}})
include_directories(
    ${CMAKE_SOURCE_DIR}/inc
    ${CMAKE_SOURCE_DIR}/drivers
    ${HAL_DIR}/Inc
    ${HAL_DIR}/CMSIS/Core/Include
)

# ─── 源文件 ───
file(GLOB_RECURSE SRC_FILES
    ${CMAKE_SOURCE_DIR}/src/*.c
    ${CMAKE_SOURCE_DIR}/drivers/**/*.c
)
list(APPEND SRC_FILES
    ${CMAKE_SOURCE_DIR}/startup_${CHIP_FAMILY_LOWER}.s
    ${HAL_DIR}/Src/system_${CHIP_FAMILY_LOWER}.c
)

# ─── 构建目标 ───
add_executable(${PROJECT_NAME}.elf ${SRC_FILES})
add_custom_command(TARGET ${PROJECT_NAME}.elf POST_BUILD
    COMMAND ${CMAKE_OBJCOPY} -O ihex ${PROJECT_NAME}.elf ${PROJECT_NAME}.hex
    COMMAND ${CMAKE_OBJCOPY} -O binary ${PROJECT_NAME}.elf ${PROJECT_NAME}.bin
    COMMAND ${CMAKE_SIZE} ${PROJECT_NAME}.elf
    COMMENT "Generating hex and bin files..."
)
