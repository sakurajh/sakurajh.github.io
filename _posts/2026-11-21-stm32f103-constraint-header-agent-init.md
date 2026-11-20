---
layout: post
title: "AI 生成的 STM32F103 初始化代码，我把四个硬件约束写进头文件"
date: 2026-11-21 06:06:00 +0800
categories: 硬件设计
tags: STM32F103 嵌入式 ADC DMA 硬件约束 AI编程
description: "厂商刚把 STM32 手册和勘误做成 AI 助手能按需检索的 skills 与 MCP 服务，可它仍然不知道我的板子怎么接线。这篇记录我用一份引脚与 DMA 事实文件、两个编译期断言和一个检查脚本，把生成代码里的四类硬件错误挡在烧录之前。"
---

11 月初的 STM32 峰会之后，ST 放出了 STM32Cube for Agentic AI：把 STM32 的领域知识做成 skills，再配一个 MCP 服务器和一层 RAG，让 AI 助手按需去查手册和勘误，而不是由我往对话里整本贴 PDF。这个方向我认同，官方上下文总比模型自己回忆靠谱。当天我就试了一把，让它照着我的 F103 驱动板生成 ADC、调试串口和风扇 PWM 的初始化。

代码编译通过，烧进去却有三处不对：调试串口一声不吭，电池电压读数偏低，后来给霍尔捕获加 DMA 时，ADC 缓冲区干脆不再更新。最难受的是这三件事都不报错——没有 HardFault，没有外设错误标志，程序照常跑。我对着原理图和参考手册逐项核对，才发现问题全部出在「板级事实」上，而不是模型记错了寄存器。

## 一、官方上下文解决的是芯片问题，不是我的板子问题

skills 和 RAG 能告诉助手：F103 的 ADC 时钟上限是多少，某个外设有哪些寄存器位，CubeMX 怎么生成初始化。这些是芯片级知识，覆盖面很广。但它不知道我这块板子上 PA2 已经接了调试串口，不知道电池分压的戴维南电阻是 9 kΩ，也不知道我打算把哪几个外设挂到 DMA。

助手缺这部分信息时不会停下来问，而是从例程里挑一组看起来合理的引脚和通道填进去。所以我的做法是把它缺的那部分变成三样东西：一份机器可读的板级事实文件、几行编译期断言、一个提交前跑的检查脚本。前者告诉它约束是什么，后两者负责在它写错时让我立刻知道。

| 约束 | 我这次的实际翻车 | 运行时会报什么 | 我在哪里拦 |
|---|---|---|---|
| 引脚复用 | PA2 同时被配成 USART2_TX 和 TIM2_CH3 | 不报，后初始化的覆盖前面的 | 事实文件 + 脚本 |
| DMA1 通道 | ADC1 和 TIM4_CH1 都映射到通道 1 | 不报，缓冲区静默停更 | 脚本查固定映射 |
| ADCCLK | 72 MHz 下用了 /4 分频，得到 18 MHz | 能出数，但超出数据手册条件 | 编译期断言 |
| 采样时间 | 9 kΩ 源阻抗只给了 1.5 个周期 | 读数偏低，随温度漂移 | 编译期断言 + 查表 |

## 二、引脚：同一根脚被两个外设初始化，谁最后谁赢

先说出错最隐蔽的引脚。我的调试串口用 PA2/PA3，助手把风扇 PWM 放在了 TIM2_CH3 上——而 TIM2_CH3 的默认引脚正是 PA2。两段初始化各自调用 `HAL_GPIO_Init`，一段把 PA2 配成复用推挽给 USART，另一段又把它配成复用推挽给 TIM2。后执行的那段覆盖前面的配置，串口 TX 从此不再受 USART 控制，发出去的数据自然没有波形。

编译器不会管这件事，因为两段代码都合法；HAL 也不会管，因为每次 `HAL_GPIO_Init` 都只是老老实实写寄存器。要发现它，只能把「哪根脚干什么」集中到一处。我建了一个 `board.def`，用 X-macro 的形式同时给 C 和 Python 读：

```c
/* board.def —— 引脚与 DMA 分配的唯一事实来源 */
BOARD_PIN(PA0, ADC1_IN0,   "电池电压检测")
BOARD_PIN(PA2, USART2_TX,  "调试串口 TX")
BOARD_PIN(PA3, USART2_RX,  "调试串口 RX")
BOARD_PIN(PA6, TIM3_CH1,   "风扇 PWM")
BOARD_PIN(PB6, TIM4_CH1,   "霍尔 A 相捕获")
BOARD_PIN(PB7, TIM4_CH2,   "霍尔 B 相捕获")
BOARD_PIN(PB8, I2C1_SCL,   "EEPROM SCL，重映射")
BOARD_PIN(PB9, I2C1_SDA,   "EEPROM SDA，重映射")

BOARD_DMA(ADC1,     DMA1_CH1, "电池电压采样")
BOARD_DMA(USART2_TX, DMA1_CH7, "调试串口发送")
BOARD_DMA(USART2_RX, DMA1_CH6, "调试串口接收")
```

C 这边把 `BOARD_PIN` 展开成一张只读表，开机时打印一遍，和原理图对照；`BOARD_DMA` 展开成空，只给脚本用：

```c
/* board.h */
typedef struct {
    const char *pin;
    const char *func;
    const char *desc;
} board_pin_t;

#define BOARD_PIN(pin_, func_, desc_) { #pin_, #func_, desc_ },
#define BOARD_DMA(func_, ch_, desc_)

static const board_pin_t board_pins[] = {
#include "board.def"
};
```

注意这里没有用「把引脚写成宏再拼初始化代码」那套复杂做法。初始化仍由 CubeMX 或手写 HAL 完成，`board.def` 只承担一件事：声明事实。事实和实现分开，检查才有意义——如果事实文件本身是生成的，那就等于让生成器自己检查自己。

## 三、DMA：F103 的通道是固定映射，七个通道要当资源分配

第二个问题是 DMA。F103 没有后来的 DMAMUX 那种交叉开关，每个外设请求线焊死在固定的通道上。ADC1 固定走 DMA1 通道 1，TIM4_CH1 也走通道 1；我为了让霍尔捕获直接写时间戳，给它开了 DMA，结果和 ADC 抢同一个通道。现象是 ADC 的循环缓冲区在霍尔开始转动后不再更新，但 `HT`、`TC` 标志都不报错，因为通道被另一个请求占着，ADC 的请求根本没得到服务。

| DMA1 通道 | 固定请求线（部分） | 我的分配 |
|---|---|---|
| 1 | ADC1 / TIM2_CH3 / TIM4_CH1 | ADC1 电池电压 |
| 2 | SPI1_RX / TIM1_CH1 / TIM3_CH3 | 未用 |
| 3 | SPI1_TX / TIM1_CH2 / TIM3_CH4 | 未用 |
| 4 | USART1_TX / I2C2_TX / TIM1_CH4 | 未用 |
| 5 | USART1_RX / TIM2_CH1 / TIM4_CH3 | 未用 |
| 6 | USART2_RX / I2C1_TX / TIM3_CH1 | USART2_RX |
| 7 | USART2_TX / I2C1_RX / TIM2_CH2 | USART2_TX |

这张表逼着我做取舍。ADC 采样和串口收发是持续性的，必须留在 DMA 上；霍尔捕获每转只有几次事件，用捕获中断打时间戳完全够，CPU 开销可以接受。所以最后我把 TIM4_CH1 的 DMA 撤掉，通道 1 只留给 ADC。这个决定不是「哪个更高级」，而是按事件频率分配稀缺资源：七个通道里，高频、连续、不能丢的数据才配用 DMA。

助手出错的原因也很清楚：它分别看 ADC 例程和定时器捕获例程，两边都写着「用 DMA1 通道 1」，单看每段都对，合起来才冲突。这种跨外设的约束，只有把分配集中到一张表里才看得见。

## 四、ADCCLK 与采样时间：两个必须写死的数值约束

数值约束比引脚更容易被忽略，因为它们不会让程序跑飞，只会让数据悄悄变差。

先看 ADCCLK。F103 的 ADC 时钟由 PCLK2 分频得到，分频系数只有 2、4、6、8 四档，数据手册给的 ADC 时钟上限是 14 MHz。我的系统时钟 72 MHz，PCLK2 也是 72 MHz，助手沿用了某个例程里的 `/4`，得到 18 MHz。转换照样完成，读数照样出来，但已经超出数据手册规定的工作条件，精度指标不再有保证——小信号段偏、线性变差，而且不会报任何错。

| ADCPRE | PCLK2 = 72 MHz | PCLK2 = 56 MHz | 是否可用 |
|---|---|---|---|
| /2 | 36 MHz | 28 MHz | 都超限 |
| /4 | 18 MHz | 14 MHz | 72 MHz 超限，56 MHz 刚好 |
| /6 | 12 MHz | 9.3 MHz | 可用 |
| /8 | 9 MHz | 7 MHz | 可用 |

这种事不该靠 review 时盯代码，直接写成编译期断言最省心：

```c
/* board_config.h */
#define BOARD_PCLK2_HZ     72000000UL
#define BOARD_ADC_PRESC    6UL              /* RCC_ADCPCLK2_DIV6 */
#define BOARD_ADCCLK_HZ    (BOARD_PCLK2_HZ / BOARD_ADC_PRESC)

_Static_assert(BOARD_ADCCLK_HZ <= 14000000UL,
               "ADCCLK 超过 14 MHz，改 RCC 的 ADC 分频");

/* 13.5 个采样周期，按 14 向上取整比较 */
#define BOARD_ADC_SMP_CYCLES  14U
_Static_assert(BOARD_ADC_SMP_CYCLES >= 11U,
               "采样时间对 10 kΩ 源阻抗太短");
```

如果工程还停在 C99，可以用 `typedef char adc_clk_ok[(条件) ? 1 : -1];` 这种负数组大小的写法替代，效果一样。

第二个数值是采样时间。ADC 内部有一个采样保持电容，采样期间要靠外部源给它充电；源阻抗越高，充到 12 位精度所需的时间越长。数据手册给的估算式是 `t ≥ (R_AIN + R_ADC) × C_ADC × ln(2^(n+2))`，F103 的 `R_ADC` 最大约 1 kΩ、`C_ADC` 约 8 pF，12 位时 `ln(2^14)` 约 9.7。我的电池电压用 100 kΩ/10 kΩ 分压，戴维南电阻约 9.1 kΩ，再加上 ADC 引脚上并的 1 nF，源阻抗就按 10 kΩ 算。

| 源阻抗（戴维南） | 估算最小采样周期 | 我选的档位 | 说明 |
|---|---|---|---|
| ≤ 1 kΩ | 约 1.9 个周期 | 7.5 | 留几倍余量更稳 |
| 10 kΩ | 约 10.3 个周期 | 13.5 | 电池分压用这一档 |
| 22 kΩ | 约 21.4 个周期 | 28.5 | 高阻传感器 |
| 51 kΩ | 约 48.5 个周期 | 55.5 | 再高就该加缓冲 |

表中的周期数是按公式估的，前提是 ADCCLK 12 MHz、12 位分辨率，实际还要按精度要求和采样窗口留余量。助手给我的是 1.5 个周期——那是低阻抗信号源的习惯写法，落到 10 kΩ 上，采样电容根本充不满，读数系统性偏低，而且温度一变，漏电和电容特性跟着变，读数就漂。

采样时间也不是越长越好。一次转换的总时间等于采样周期加 12.5 个转换周期，如果 PWM 频率高、周期短，采样时间配得过大就会挤占控制窗口。我选 13.5 而不是 239.5，就是在「充得够」和「来得及」之间取的值。

## 五、把检查脚本放进提交前，而不是相信记忆

引脚和 DMA 的冲突，编译期断言管不了，因为它们是两张表之间的一致性。我写了一个三十来行的 Python 脚本，读同一份 `board.def`，把重复的引脚和重复的 DMA 通道打出来：

```python
import re
import sys
from collections import defaultdict
from pathlib import Path

text = Path("board.def").read_text(encoding="utf-8")
pin_re = re.compile(r'BOARD_PIN\(\s*(\w+)\s*,\s*(\w+)\s*,\s*"([^"]+)"\s*\)')
dma_re = re.compile(r'BOARD_DMA\(\s*(\w+)\s*,\s*DMA1_CH(\d)\s*,\s*"([^"]+)"\s*\)')

pins, chans = defaultdict(list), defaultdict(list)
for m in pin_re.finditer(text):
    pins[m.group(1)].append(f"{m.group(2)}（{m.group(3)}）")
for m in dma_re.finditer(text):
    chans[m.group(2)].append(f"{m.group(1)}（{m.group(3)}）")

bad = False
for pin, uses in pins.items():
    if len(uses) > 1:
        bad = True
        print(f"[引脚复用冲突] {pin}: " + " / ".join(uses))
for ch, uses in chans.items():
    if len(uses) > 1:
        bad = True
        print(f"[DMA1 通道 {ch} 冲突] " + " / ".join(uses))

sys.exit(1 if bad else 0)
```

把它挂在提交前的钩子或者 CI 里，失败就退出非零。之前在表里同时存在 `PA2/USART2_TX` 和 `PA2/TIM2_CH3` 时，脚本直接打印「[引脚复用冲突] PA2」，比烧进板子再拿示波器找快得多；`ADC1` 和 `TIM4_CH1` 同挂通道 1 时也一样，一眼就能看到。

现在我用助手的流程固定成三步：先把 `board.def` 和 `board_config.h` 一起给它，明确说「不要新增引脚，不要改 DMA 分配」；生成后先跑脚本，再编译；编译通过再烧录，烧录后示波器和串口各验一遍。脚本和断言只能拦住表里写清楚的约束，布线、地弹、电源纹波这些它一概不管，所以板子上的实测仍然不能省。

## 小结

这次让我改了对外部 AI 助手的期待：它擅长的是芯片级知识，官方 skills 和 RAG 也确实能让这部分更准；但板级事实是我的责任，包括哪根脚接了什么、哪个外设占了哪个 DMA 通道、信号源阻抗多大。这些信息不写进项目，助手只能猜，猜错了还不报错。

四个约束里，两个靠事实文件加脚本查一致性，两个靠编译期断言锁死数值。门槛都不高，但能把「编译通过、运行不报错、数据悄悄错」这类问题提前到改代码的那一刻。以后再让助手碰外设初始化，我会先问自己一句：`board.def` 更新了吗？

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

