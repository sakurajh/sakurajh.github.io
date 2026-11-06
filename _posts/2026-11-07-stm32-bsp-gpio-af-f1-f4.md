---
layout: post
title: "STM32 官宣统一平台后：一层 BSP 隔离 F1 与 F4 的 GPIO 复用差异"
date: 2026-11-07 06:02:00 +0800
categories: 硬件设计
tags: STM32 嵌入式 GPIO复用 HAL库 BSP
description: "把 F103 最小系统板的串口代码搬到 F407 板，编译零警告，PA9 却一直是低电平。这篇从复现讲起，说明 F1 的 AFIO 重映射与 F4 的 GPIOx_AFR 复用编号差在哪，以及我怎样用一层 BSP 头文件把差异隔离在编译期。"
---

上个月我把 Stm32 仓库里那块 F103 最小系统板的串口日志功能，照原样搬到了一块 F407 开发板上。代码是同一份 `bsp_usart.c`，只改了工程里的芯片宏，编译零警告，烧进去之后串口助手一片空白。我第一反应是波特率算错了，换了几个参数还是没动静；拿示波器一量 PA9，电平一直是低——这说明引脚根本没被配置成复用推挽输出，信息还没走到 USART 就被卡在 GPIO 这一层了。

这件事和这两天的 STM32 峰会消息放在一起看挺有意思。厂商在讲统一 MCU 平台，强调架构、IP、软件和工具可以跨工业、汽车、机器人复用。我认同这个方向，工具链统一确实省事，但「软件可复用」说的是外设库和工程骨架，寄存器层的差异不会因此消失。F1 和 F4 的 GPIO 复用就是最典型的一处。

那天晚上我在这块板子上耗了将近两个小时，前一个小时都在怀疑硬件：换 USB-TTL、换杜邦线、量供电，甚至把两块板子的晶振都对比了一遍。真正的转折点是拿示波器直接夹在 PA9 上，看到它从复位起就趴在地平线上，而不是只在发数据时才异常。信号从来没出去过，问题必然在初始化，不在通信。

## 一、现象：同一份初始化，F1 通、F4 不通

我原来的初始化代码长这样，很短，短到我从没觉得它有问题：

```c
GPIO_InitTypeDef gpio = {0};
gpio.Pin   = GPIO_PIN_9 | GPIO_PIN_10;
gpio.Mode  = GPIO_MODE_AF_PP;
gpio.Pull  = GPIO_NOPULL;
gpio.Speed = GPIO_SPEED_FREQ_HIGH;
HAL_GPIO_Init(GPIOA, &gpio);
```

在 F103 上这么写完全够用：USART1 默认就映射在 PA9/PA10，不需要任何额外配置。到了 F407，USART1 依然在 PA9/PA10，引脚号一模一样，但 GPIO 还得知道「复用成哪个功能」——这个信息写在 `gpio.Alternate` 字段里。我没填，它默认是 0，也就是 AF0，那是系统功能。于是 PA9 被配成了一个跟 USART 无关的复用通道，TX 自然不出波形。

这类问题难查，是因为它全程不报错：HAL 认为初始化成功，USART 寄存器读出来也正常，只是信号没被接到引脚上。如果我当时先去改波特率、改校验位，方向就全错了。

## 二、差异盘点：一张表说清 F1 与 F4

我把两个系列在复用配置上真正不同的点列了出来，调代码时对着表走，比翻手册快：

| 差异点 | STM32F1 | STM32F4 / F7 |
|---|---|---|
| 复用配置位置 | AFIO_MAPR 的重映射位 | GPIOx_AFRL / AFRH 里 4 位复用编号 |
| 是否要填复用编号 | 不需要，按功能固定或重映射 | 必填，例如 USART1 在 PA9 上是 AF7 |
| GPIO_InitTypeDef.Alternate | 结构体里没有这个字段 | 必须显式赋值 |
| 额外时钟 | 要用重映射宏就得开 AFIO 时钟 | 没有 AFIO 这一层 |
| 引脚速度上限 | 枚举只到 HIGH | 可选 VERY_HIGH |
| 典型错误表现 | 重映射写错，功能跑到别的脚上 | 忘了填 Alternate，引脚毫无输出 |

看完表就能明白，根本矛盾是「F1 用重映射寄存器表达复用，F4 用每个引脚的复用编号表达复用」。同一句 `HAL_GPIO_Init`，语义并不完全等价。

再往深一层说，F1 的 AFIO_MAPR 是一个全局开关式的东西：某些功能只能整体挪到一组备用引脚上，比如 USART1 要么在 PA9/PA10，要么整体挪到 PB6/PB7，不存在「PA9 给 USART1、PB6 给别的东西」这种混搭。F4 则把选择权下放到每个引脚，AFRL 管 0 到 7 号引脚，AFRH 管 8 到 15 号引脚，每个引脚独占 4 位，最多能表达 16 种复用功能。这个设计上的变化才是根因：F1 时代外设少、引脚少，用一张全局映射表就够；到了 F4，外设数量和引脚复用冲突都上来了，只能改成逐引脚的矩阵。

这也解释了我为什么会栽在「默认值」上。F1 里没有 Alternate 字段，编译器连提醒都不会给；F4 里这个字段存在，但结构体是零初始化的，`Alternate = 0` 在语法上完全合法，于是 AF0 被静默地写进了 AFRL。编译器没有错，HAL 也没有错，错的是我把两个系列当成同一个东西。

## 三、我的 BSP：只暴露「哪个脚做什么用」

我不想在每个业务文件里写 `#ifdef`，那样一加新板子就到处改。我的做法是让上层只说需求：PA9 做 USART1 的 TX。具体落到哪个寄存器，由 BSP 决定。先定义引脚描述结构和统一的初始化函数：

```c
/* bsp_gpio.h：差异集中在这里，业务代码不包含任何系列头文件 */
typedef struct {
    GPIO_TypeDef *port;
    uint16_t      pin;
    uint32_t      mode;
    uint32_t      pull;
    uint32_t      speed;
    uint8_t       af;      /* F1 忽略此字段 */
} bsp_pin_t;

static inline void bsp_pin_init(const bsp_pin_t *p)
{
    GPIO_InitTypeDef init = {0};
    init.Pin   = p->pin;
    init.Mode  = p->mode;
    init.Pull  = p->pull;
    init.Speed = p->speed;
#if defined(STM32F4) || defined(STM32F7)
    init.Alternate = p->af;
#endif
    HAL_GPIO_Init(p->port, &init);
}
```

然后串口引脚的板级初始化写成这样：

```c
static inline void bsp_usart1_pins_init(void)
{
#if defined(STM32F1)
    __HAL_RCC_AFIO_CLK_ENABLE();          /* F1 独有：重映射控制器 */
    __HAL_AFIO_REMAP_USART1_DISABLE();    /* 显式声明用默认映射，别留悬念 */
    bsp_pin_init(&(bsp_pin_t){GPIOA, GPIO_PIN_9,  GPIO_MODE_AF_PP,
                              GPIO_NOPULL, GPIO_SPEED_FREQ_HIGH, 0});
    bsp_pin_init(&(bsp_pin_t){GPIOA, GPIO_PIN_10, GPIO_MODE_AF_PP,
                              GPIO_NOPULL, GPIO_SPEED_FREQ_HIGH, 0});
#else
    /* AF7 是查 F4 参考手册复用映射表得到的，不是猜的 */
    bsp_pin_init(&(bsp_pin_t){GPIOA, GPIO_PIN_9,  GPIO_MODE_AF_PP,
                              GPIO_NOPULL, GPIO_SPEED_FREQ_VERY_HIGH, 7});
    bsp_pin_init(&(bsp_pin_t){GPIOA, GPIO_PIN_10, GPIO_MODE_AF_PP,
                              GPIO_NOPULL, GPIO_SPEED_FREQ_VERY_HIGH, 7});
#endif
}
```

几个取舍值得说清楚。第一，把函数写成 `static inline` 放在头文件里，而不是拆成一个 `bsp_gpio.c`：这些函数只有几行，内联之后没有函数调用开销，也不会为了一个空壳文件去改链接脚本。第二，F1 分支里那句 `__HAL_AFIO_REMAP_USART1_DISABLE()` 其实删掉也能跑，但我坚持写出来——半年后回来看到这行，就知道默认映射是有意为之，而不是漏配。第三，`af` 字段在 F1 上永远不用，看起来浪费一个字节，但它让上层调用语法在两个系列上保持一致，这比省那点 RAM 重要得多。

另一个选择是用 CubeMX 给每块板各生成一套工程，让图形化工具去处理这些差异。我试过，生成出来的代码确实能跑，但两个工程的外设初始化是各自独立的，业务代码想共用就得手工搬。更要命的是，CubeMX 重新生成时会覆盖我改过的手写部分，我每次都得先把改动复制出来再贴回去。BSP 这条路麻烦在前期的抽象设计，但一旦稳定，加第三块板子只是复制一个 board 目录、把 AF 编号查表填进去，业务层一行不用改。对我来说，这个投入产出比明显更高。

BSP 的边界也要守住：它只做「引脚和时钟的映射」，不封装协议，也不替上层决定收发策略。USART 发一帧怎么组包、超时怎么处理，仍然属于业务代码。我见过把整个串口收发放进 BSP 的做法，结果换系列时发现 HAL 的 DMA 回调命名、中断优先级分组都有细微差别，抽象层被迫越来越厚，最后变成另一套框架，反而比直接写 HAL 更难维护。

## 四、用编译期选择，而不是运行时判断

差异隔离好之后，剩下的问题是「怎么让编译器知道当前是哪块板」。我在工程里按板子分目录，一套源码配多个 board 头文件，用 CMake 变量切换：

```cmake
set(BOARD "f103_min" CACHE STRING "目标板")

if(BOARD STREQUAL "f103_min")
    set(BOARD_DEFS STM32F1 STM32F103xB)
    set(BOARD_HAL_DIR Drivers/STM32F1xx_HAL_Driver)
elseif(BOARD STREQUAL "f407_min")
    set(BOARD_DEFS STM32F4 STM32F407xx)
    set(BOARD_HAL_DIR Drivers/STM32F4xx_HAL_Driver)
endif()

get_filename_component(HAL_NAME ${BOARD_HAL_DIR} NAME)      # STM32F1xx_HAL_Driver
string(REPLACE "_HAL_Driver" "" FAMILY ${HAL_NAME})         # STM32F1xx

target_compile_definitions(firmware PRIVATE ${BOARD_DEFS} USE_HAL_DRIVER)
target_include_directories(firmware PRIVATE
    boards/${BOARD}
    ${BOARD_HAL_DIR}/Inc
    Drivers/CMSIS/Device/ST/${FAMILY}/Include)
```

为什么不在运行时判断系列？因为跨系列工程的 HAL 头文件本来就只能编进一套，运行时分支写了也编不过，还会白白多占 Flash。编译期选择的好处是：选错板子时直接在编译阶段报错，而不是烧进去以后靠示波器找问题。这一点对我这种手上有三块不同系列板子的人来说非常实用，`cmake -DBOARD=f407_min ..` 就是一次完整切换。

板级头文件也只放「这块板有什么」，不放下拉电阻怎么接这类细节：

```c
/* boards/f103_min/board.h */
#define BOARD_USART_BAUD   115200
#define BOARD_LED_PORT     GPIOC
#define BOARD_LED_PIN      GPIO_PIN_13   /* 低电平点亮 */
```

## 五、调试顺序：先量电平，再谈协议

这次事故之后，我给自己定了一个固定的排查顺序，每次卡住都按这个来：

1. 量引脚空闲电平。UART 的 TX 在空闲时应该是高电平，如果一上电就是低，说明引脚根本没配成复用输出，后面全不用看。
2. 查时钟。GPIOA 和 USART1 的时钟位是否置起；F1 上还要确认 AFIO 时钟没有被漏掉。
3. 发固定字节 0x55。它的二进制是 0101 0101，示波器上一眼就能数出每个位的宽度，比发 0x00 或 0xFF 好判断得多。
4. 把 TX 和 RX 短接做回环，先确认 USART 外设自己能收发，再怀疑外部模块。
5. 最后才接 USB-TTL 或传感器，同时检查共地和电平是否匹配。

这个顺序的底层逻辑是「每次只改变一个变量」。物理层没通就去调波特率，等于在一个已知有问题的链路上做随机实验，越试越乱。

## 小结

厂商推统一平台，对跨产品线复用的价值是实打实的，但抽象层不会自动长出来，还是得自己在寄存器差异上裁一刀。我现在的验收标准很简单：同一份业务代码，换一个板级目录、换一个 `BOARD` 变量就能编译通过，并且第一步先量电平就能确认引脚活了。这套 BSP 后来帮我把 F103 上的红外输入捕获也搬到了 F407 上，改的只是 board 目录和一个定时器通道号。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

