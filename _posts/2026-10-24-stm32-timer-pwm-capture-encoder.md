---
layout: post
title: "STM32F103 定时器的三种用法：PWM 输出、输入捕获与编码器接口"
date: 2026-10-24 09:26:00 +0800
categories: 硬件设计
tags: STM32 定时器 PWM 输入捕获 编码器 嵌入式
description: "从小车项目里三个定时器互相打架的现场出发，讲清 STM32F103 的 PWM、输入捕获和编码器模式在信号链上各自做了什么，HAL 配置怎么写，以及预装载、16 位回绕、引脚复用这些容易翻车的地方。"
---

上个月把实验室那台老小车主控换成了 STM32F103C8T6，需求不复杂：两路 PWM 驱动 L298N 的两个电机，一路接红外接收头解 NEC 协议，另外还要读左右两个霍尔编码器测速。第一版代码写得很顺，想着 C8T6 上有四个定时器，一个功能分一个就够了。结果上车跑了十分钟，问题全来了——电机转速忽快忽慢，遥控十次里有两三次没反应，最要命的是里程数越跑越偏，直行两百米能歪出去半米。

一开始我以为是电机和编码器的机械问题，换了轮子、紧了联轴器都没用。后来把逻辑分析仪挂上去才看明白：不是代码逻辑写错了，而是 PWM、捕获、编码器这三种模式对定时器和引脚的要求完全不一样，我把它们当成三个可以随意摆放的模块，结果通道和引脚撞在了一起。

这篇把这件事拆开讲：三种模式在硬件上到底做了什么，HAL 该怎么写，以及各自有哪些不看手册就想不明白的坑。

## 一、三种模式共用一套时基，只是信号链不同

先建立一个统一的心智模型。一个定时器由**计数单元**和**通道**两部分组成：

- 计数单元：PSC 分频、CNT 计数、ARR 决定数到多少归零；
- 通道：每个通道有一个 CCR 寄存器，它和 CNT 比较，或者被外部边沿写入。

三种模式的区别，只是"谁在驱动谁"：

| 模式 | 数据方向 | 谁触发 | 典型用途 |
|---|---|---|---|
| PWM 输出 | CNT/CCR → 引脚 | 计数器自己 | 电机调速、LED 调光、舵机 |
| 输入捕获 | 引脚 → CCR 快照 | 外部边沿 | 测频率、测脉宽、解红外 |
| 编码器接口 | 引脚 → CNT 加减 | A/B 相边沿 | 测转速、测位移 |

所以配置顺序永远是先时基（PSC/ARR）、再通道（CCR/极性），最后才是启动。很多人（包括当时的我）一上来就抄通道配置，忘了时基决定了后面所有数字的含义。

## 二、PWM：频率和占空比是两个独立的旋钮

先看公式，这三个式子决定了所有参数：

- 计数频率 `f_cnt = f_timer / (PSC + 1)`
- PWM 频率 `f_pwm = f_cnt / (ARR + 1)`
- 占空比 `= CCR / (ARR + 1)`

我要 1 kHz 的 PWM 驱动 L298N。这里第一个坑就来了：F103 的 APB1 总线是 36 MHz，**但挂在上面的定时器时钟会自动乘 2，是 72 MHz**。如果按 36 MHz 去算分频，实际输出会差一倍，电机听起来会有一点点啸叫，用示波器一量才发现是 2 kHz。

```c
#include "stm32f1xx_hal.h"

TIM_HandleTypeDef htim1;                // TIM1 是高级定时器，CH1/CH2 = PA8/PA9
TIM_OC_InitTypeDef sConfigOC = {0};

void MotorPWM_Init(void)
{
    htim1.Instance = TIM1;
    htim1.Init.Prescaler = 71;          // 72MHz / 72 = 1MHz 计数
    htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
    htim1.Init.Period = 999;            // 1MHz / 1000 = 1kHz
    htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
    htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
    HAL_TIM_PWM_Init(&htim1);

    sConfigOC.OCMode = TIM_OCMODE_PWM1;
    sConfigOC.Pulse = 0;
    sConfigOC.OCPolarity = TIM_OCPOLARITY_HIGH;
    sConfigOC.OCFastMode = TIM_OCFAST_DISABLE;
    HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_1);
    HAL_TIM_PWM_ConfigChannel(&htim1, &sConfigOC, TIM_CHANNEL_2);

    HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);   // 内部会顺带打开 MOE
    HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_2);
}

/* 0~100 的百分比，转成 0~1000 的比较值 */
void Motor_SetSpeed(uint8_t percent)
{
    if (percent > 100) percent = 100;
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, percent * 10);
}

void Motor_Stop(void)
{
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, 0);
    __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_2, 0);
}
```

把 PWM 放在 TIM1 上不是随手选的。高级定时器有主输出使能（MOE）和刹车、死区这些功能，HAL 的 `HAL_TIM_PWM_Start` 会顺带把 MOE 打开；哪天要换成 H 桥做互补输出，不用换定时器也不用改引脚，加上死区时间就行。

第二个坑藏在 `__HAL_TIM_SET_COMPARE` 里。HAL 在配置通道时默认打开了 CCR 预装载（OCxPE 位），也就是说你写进 CCR 的值不会立刻生效，而是等下一个更新事件（计数器归零）才搬进影子寄存器。好处是不会在周期中间改出半个脉冲的毛刺，坏处是：如果你在一个周期里连写两次，实际只有最后一次算数。我在加减速算法里连续调了两次占空比，还以为第一次被"吃掉"是硬件坏了。

还有一点，L298N 是双极性驱动，方向靠另外两根 IO 控制，PWM 只负责大小。如果直接给 0% 就相当于"滑行"，急停要改成两边都拉低或者用刹车模式，这个和定时器无关，但确实是我第一次调试时"电机停不下来"的原因。

## 三、输入捕获：轮询一定会漏，因为你的主循环不够快

红外接收头解 NEC，一帧大约 67.5 ms，其中最短的位间隔是 560 µs。我最初图省事，在主循环里读 GPIO 电平、用 `HAL_GetTick()` 算时间。只要主循环里加一句 OLED 刷新或者串口打印，一次就是几毫秒，560 µs 的位宽根本记不住，遥控自然时灵时不灵。

捕获模式的思路完全不同：**边沿到来时，硬件把当前 CNT 的值直接抄进 CCR**，CPU 只需要事后去取。误差只取决于定时器时钟，和主循环忙不忙毫无关系。

```c
static volatile uint16_t lastEdge = 0;
static volatile uint8_t  phase = 0;     // 0: 等引导码下降沿，1: 已见到引导码
static volatile uint8_t  bitCount = 0;

void IR_Init(void)
{
    htim2.Instance = TIM2;
    htim2.Init.Prescaler = 71;          // 同样 1MHz，1 个计数 = 1us
    htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
    htim2.Init.Period = 0xFFFF;
    HAL_TIM_IC_Init(&htim2);

    TIM_IC_InitTypeDef sIC = {0};
    sIC.ICPolarity  = TIM_INPUTCHANNELPOLARITY_FALLING;
    sIC.ICSelection = TIM_ICSELECTION_DIRECTTI;
    sIC.ICPrescaler = TIM_ICPSC_DIV1;
    sIC.ICFilter    = 10;               // 滤掉接收头上的毛刺
    HAL_TIM_IC_ConfigChannel(&htim2, &sIC, TIM_CHANNEL_1);
    HAL_TIM_IC_Start_IT(&htim2, TIM_CHANNEL_1);
}

void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim)
{
    if (htim->Instance != TIM2) return;

    uint16_t now   = (uint16_t)__HAL_TIM_GET_CAPTURE1(htim);
    uint16_t width = (uint16_t)(now - lastEdge);   // 无符号减法自动处理回绕
    lastEdge = now;

    if (phase == 0) {                   // 9ms 低电平引导码
        phase = 1;
    } else {
        NecBit_OnPulse(width);          // 560us 为 0，1690us 为 1
        if (++bitCount >= 32) {
            bitCount = 0;
            phase = 0;
        }
    }

    /* F103 的通用定时器没有 CCxNP 位，硬件双边沿只在 TIM1 上有，
       所以这里在中断里手动切换下一次要捕获的边沿 */
    __HAL_TIM_SET_CAPTUREPOLARITY(htim, TIM_CHANNEL_1,
        (phase & 1) ? TIM_INPUTCHANNELPOLARITY_RISING
                    : TIM_INPUTCHANNELPOLARITY_FALLING);
}
```

这段代码有三个值得说的地方。为了把重点放在捕获上，位判断只保留了骨架，实际解码时还要用宽度区分 4.5 ms 的引导高电平和 560/1690 µs 的数据位，这里用 `NecBit_OnPulse` 概括了。

第一，`uint16_t` 的无符号减法天然处理了 16 位计数器回绕。`now - lastEdge` 即使跨过了 0xFFFF 也是对的，不需要额外判断方向。

第二，切换极性是在中断里做的，这要求两次边沿之间的间隔大于中断响应时间。NEC 最短 560 µs，完全够用；但如果拿这套代码去解 38 kHz 载波或者更快的信号，就得上 TIM1 的硬件双边沿，或者干脆用 DMA 采样。

第三，帧与帧之间有 40 ms 以上的空闲。如果不处理，下一帧的第一个下降沿会被当成"上一帧最后一位的延续"，宽度算出来是个荒唐的大数。我的做法是开更新中断，在 `HAL_TIM_PeriodElapsedCallback` 里看计数是否超过某个阈值，超了就复位状态机。这也是我一开始漏掉的，表现是"按一次键出两个码"。

## 四、编码器模式：把计数交给硬件，别用 EXTI 硬扛

编码器最初我是用外部中断做的：A 相上升沿进一次中断，读 B 相电平判断方向，自己加一减一。台面上手拨轮子一切正常，装到车上跑起来里程就偏小，而且速度越快偏得越多。

原因很直接。第一，中断太频繁，两个轮子同时转，每转一圈几十个脉冲乘四倍频，CPU 大量时间在进出中断；第二，中断响应不及时就会漏掉边沿，而漏掉的计数补不回来。这类"低速准、高速偏小"的现象，基本可以直接怀疑是软件计数丢脉冲。

编码器模式是另一条路：A/B 两相的边沿直接驱动 CNT 加减，全程不经过 CPU。

```c
void Encoder_Init(void)
{
    TIM_Encoder_InitTypeDef sEnc = {0};

    htim4.Instance = TIM4;
    htim4.Init.Prescaler = 0;              // 编码器不要分频
    htim4.Init.CounterMode = TIM_COUNTERMODE_UP;
    htim4.Init.Period = 0xFFFF;
    htim4.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
    htim4.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;

    sEnc.EncoderMode  = TIM_ENCODERMODE_TI12;   // 4 倍频
    sEnc.IC1Polarity  = TIM_ICPOLARITY_RISING;
    sEnc.IC1Selection = TIM_ICSELECTION_DIRECTTI;
    sEnc.IC1Prescaler = TIM_ICPSC_DIV1;
    sEnc.IC1Filter    = 10;
    sEnc.IC2Polarity  = TIM_ICPOLARITY_RISING;
    sEnc.IC2Selection = TIM_ICSELECTION_DIRECTTI;
    sEnc.IC2Prescaler = TIM_ICPSC_DIV1;
    sEnc.IC2Filter    = 10;

    HAL_TIM_Encoder_Init(&htim4, &sEnc);
    HAL_TIM_Encoder_Start(&htim4, TIM_CHANNEL_ALL);
}

/* 每 10ms 调一次，返回这 10ms 内的增量 */
int16_t Encoder_ReadDelta(void)
{
    int16_t delta = (int16_t)__HAL_TIM_GET_COUNTER(&htim4);  // 16 位读是单条指令
    __HAL_TIM_SET_COUNTER(&htim4, 0);
    return delta;
}
```

`TIM_ENCODERMODE_TI12` 是四倍频：A、B 两相各两个边沿都计数，所以一圈的计数是编码器线数的四倍。分辨率上去了，代价是低速时更容易被抖动误触发，所以滤波器 `IC1Filter` 不能省——我在电机静止时看到 CNT 偶尔自己跳一两个数，就是引脚上的噪声。

读计数这里也有个细节：读数用 `int16_t` 强制转换，是因为反向旋转时 CNT 会从 0 减到 65535，按有符号解释就是 -1。不清零、只算两次读数之差也完全可以，而且不会在"读"和"清"之间丢掉一个计数；但只要周期固定，每次最多丢 ±1，对测速几乎没影响。真正要小心的是长时间不清零导致 16 位回绕，跑了很久之后增量会突然变成一个大数，我一开始没做类型转换，看到速度表瞬间爆表就是这么来的。

## 五、我的定时器分配与选型对照

三个功能都理清之后，分配就变成了资源问题。F103C8T6 上能用的定时器就那几个，还要和引脚复用一起考虑。

| 功能 | 定时器 | 默认引脚 | 为什么选它 |
|---|---|---|---|
| 双电机 PWM | TIM1 CH1/CH2 | PA8 / PA9 | 高级定时器，两通道同频，以后加死区不用换 |
| 红外 NEC 捕获 | TIM2 CH1 | PA0 | 16 位、1 MHz 计数足够，单独占用便于调状态机 |
| 左轮编码器 | TIM3 CH1/CH2 | PA6 / PA7 | 通用定时器，两通道刚好够一对 A/B 相 |
| 右轮编码器 | TIM4 CH1/CH2 | PB6 / PB7 | 同上，两个轮子必须各占一个定时器 |

两条硬约束必须记住：

1. **编码器模式占用的是"通道对"**。你不可能用 TIM3 的 CH1 输出 PWM、同时用 CH1 和 CH2 做编码器，因为 CH1 的 CCR 只能有一个用途。两个轮子也同理，一套 A/B 相就要吃掉一个定时器，这就是三个功能和四个定时器刚好对上的原因。这也是我第一版失败的直接原因——PWM 和左轮编码器都在 TIM3 上，编译没问题，运行起来就是互相抢通道。
2. **PB6/PB7 默认还是 I2C1 的 SCL/SDA**。如果板子上还挂着 OLED，要么把 I2C1 重映射到 PB8/PB9，要么把编码器换到 TIM2 的 CH1/CH2（PA0/PA1），然后红外改用别的口。这张引脚表建议在画板子之前就画完，别等焊完了才发现冲突。

调完之后还有一个不是定时器的问题值得提一句：电机在很低的占空比下不转。不是 PWM 配错了，而是这个占空比下电机绕组里的平均电流还克服不了静摩擦和 L298N 自身的压降。所以调速要给一个死区补偿，低于某个阈值直接给最小值，否则摇杆推了一小段车不动，推过某个点突然窜出去，手感非常差。

## 小结

三种模式看起来是三个外设功能，本质上是同一条信号链的三种方向：PWM 是计数器写引脚，捕获是引脚写寄存器，编码器是引脚直接驱动计数器。配置前先把时基算清楚（尤其别忘了 APB1 定时器时钟乘 2），再把"谁独占哪个通道"分配好，剩下的都是细节。至于那些不看手册绝对想不到的点——CCR 预装载、通用定时器没有 CCxNP、16 位 CNT 的回绕——踩过一次，下次画原理图的时候就会先想起来了。

