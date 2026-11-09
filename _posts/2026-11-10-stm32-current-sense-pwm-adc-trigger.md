---
layout: post
title: "STM32 电流采样为什么在开关沿抖：低边电阻、PWM 触发与 ADC 窗口"
date: 2026-11-10 06:03:00 +0800
categories: 硬件设计
tags: STM32 电流采样 ADC 电机控制 嵌入式
description: "给 F103 驱动板加电流环时，采样值总在开关沿乱跳，改 PID 和加滤波都没用。这篇从示波器波形讲起，说明低边采样电阻、运放、PWM 触发与 ADC 注入组怎样对齐，以及采样窗口和 RC 滤波为什么不能互相替代。"
---

上周给 Stm32 仓库里那块 F103 驱动板补电流环，遇到一个很典型的现象：电机空载时电流读数很稳，一加上负载，采样值就开始上下跳，PID 输出跟着抖，电机发出低频啸叫。我一开始按常规思路改 PID 参数，又把测速换成了更细的分频，甚至加了一阶低通，结果只是把抖动换了个样子，响应还变慢了。真正让我转向的是把示波器两个通道同时接上：一个夹在采样电阻两端，一个夹在运放输出，触发源选 PWM。波形上看得清清楚楚——采样点根本不在低边导通的平稳段，而是压在开关沿上，运放输出正在振铃。

这件事和 11 月初的 STM32 峰会放在一起看挺有对照感。厂商这次把新平台往工业、机器人、数字电源这些方向推，STM32G5 这颗混合信号 MCU 的线上专场定在 11 月 17 日，主题是数字电源与电机控制的精度。我手上没有 G5 的板子，也没打算替它背书，但这条消息提醒了我一件事：混合信号 MCU 的卖点不该只看 ADC 有多少位，而要看 PWM、ADC、运放、比较器能不能在同一个时序域里对齐。我那块板子的问题，恰好就出在对齐上。

## 一、先分清：抖的是电流，还是采样时刻

电流是瞬时量。电机驱动和开关电源里，采样电阻上的电压在开关沿附近有很强的 di/dt 尖峰，这是功率回路寄生电感造成的，跟真实负载电流不是一回事。如果 ADC 恰好在这个窗口采样，读到的是尖峰和振铃，不是电流。此时无论 PID 怎么调、滤波器加多重，都只是在处理一个错误时刻的量。

我后来给自己定了一个很笨但有效的判断顺序：

1. 示波器双通道，一个看采样电阻两端，一个看运放输出，触发源选 PWM 通道。
2. 在运放输出上找 ADC 的采样时刻，看它落在平稳段还是开关沿。
3. 把占空比从 10% 扫到 90%，观察读数是否在同一电流下漂移。漂移大，说明采样窗口或前端带宽有问题。
4. 最后才动 PID 和数字滤波。

第 3 步很关键。占空比变化会改变低边导通的时间长度，如果采样窗口本来就贴着边沿，占空比一挪，采样点就落到振铃里，读数自然跟着变。这一步能直接把「控制算法问题」和「采样时序问题」分开。

## 二、低边、高边、相内联：拓扑决定你能测到什么

我最初想当然地觉得低边采样「便宜但精度差」，后来发现这个说法太粗。三种位置真正的差别是共模电压、损耗和可见区间，精度反而更多取决于前端器件和布局。

| 采样位置 | 共模电压 | 附加损耗 | 能看到什么 | 前端成本 | 适合场景 |
|---|---|---|---|---|---|
| 低边电阻 | 接近地 | 全部计入，正比于电流平方 | 下管导通期间的电流 | 普通运放或固定增益放大器 | 小功率、成本敏感 |
| 高边电阻 | 接近母线 | 同上 | 全周期电流，可做开路短路诊断 | 高压共模电流检测放大器 | 大功率、需要保护 |
| 相内联 | 随相电压摆动 | 同上 | 部分区间，需要双向处理 | 隔离或双向放大器 | 高要求伺服 |

我选的是低边 10 mΩ 加一颗固定增益 50 的电流检测放大器。按我的板子算，10 mΩ 乘 50 等于 0.5 V/A，偏置放在 1.65 V，量程大约正负 3.3 A；ADC 满量程 4095 码对应 3.3 V，折算下来约 620 码每安，分辨率约 1.6 mA。我的电机堵转电流接近 2 A，这个量程够用，又不至于把分辨率浪费掉。

这里有个很实际的取舍：如果换成 20 mΩ，分辨率翻倍，但量程只剩正负 1.65 A，堵转时直接削顶；反过来用 5 mΩ，量程很宽，分辨率却掉到 3 mA 左右，低速小电流时信噪比很难看。低边采样还有一个绕不开的代价——下管关断、上管导通的区间里，采样电阻上没有电流，这段信息是丢的。所以它适合做平均电流环，不适合做逐周期过流保护；后者得靠比较器或者高边采样。

## 三、把触发点钉在低边导通窗口里

我的 PWM 是 20 kHz，周期 50 µs。定时器用边沿对齐、向上计数，CH1 配成 PWM 模式 2，这样计数器归零时高边关断、低边导通，低边采样电阻从这一刻开始有电流。问题在于，归零瞬间也是开关沿，振铃还没结束。直接拿更新事件触发 ADC，等于专门挑最脏的时刻采样。

我的做法是借 CH4 产生一个延迟触发：CH4 不接引脚，只把比较值设成 72，72 MHz 下大约 1 µs，等死区和振铃过去，再把 TRGO 设成 OC4REF。边沿对齐模式下，这个比较点每个周期只出现一次，正好落在低边导通窗口内部。

```c
/* TIM1：20 kHz，边沿对齐；CH1/CH1N 互补，CH4 只负责采样触发 */
htim1.Instance                = TIM1;
htim1.Init.Prescaler          = 0;        /* 72 MHz */
htim1.Init.Period             = 3599;     /* 72 MHz / 3600 = 20 kHz */
htim1.Init.CounterMode        = TIM_COUNTERMODE_UP;
htim1.Init.ClockDivision      = TIM_CLOCKDIVISION_DIV1;
htim1.Init.RepetitionCounter  = 0;
HAL_TIM_PWM_Init(&htim1);

TIM_OC_InitTypeDef oc = {0};
oc.OCMode      = TIM_OCMODE_PWM2;         /* CNT < CCR 时高边关断 */
oc.Pulse       = duty_ticks;
oc.OCPolarity  = TIM_OCPOLARITY_HIGH;
oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_1);

oc.OCMode = TIM_OCMODE_PWM1;
oc.Pulse  = 72;                           /* 约 1 µs，避开开关振铃 */
HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_4);

TIM_MasterConfigTypeDef ms = {0};
ms.MasterOutputTrigger = TIM_TRGO_OC4REF; /* 每周期一次 TRGO */
HAL_TIMEx_MasterConfigSynchronization(&htim1, &ms);

HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1);
HAL_TIMEx_PWMN_Start(&htim1, TIM_CHANNEL_1);
HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_4); /* 不接引脚，只为让 OC4 逻辑运行 */
```

ADC 这一侧我用注入组，而不是规则组加 DMA。注入组有自己的触发源和结果寄存器，PWM 一来就转换，不会被规则组的通道序列排队拖后；读 `JDR` 也是确定的。规则组加 DMA 更适合温度、母线电压这类慢变量的多通道巡检，两者不是替代关系。

| 读取方式 | 采样时刻由谁决定 | CPU 占用 | 我把它用在哪 |
|---|---|---|---|
| 主循环软件启动 | 主循环节奏，不确定 | 高 | 温度、电池电压 |
| 规则组 + DMA 循环 | 定时器触发，但多通道要排队 | 低 | 多路慢变量巡检 |
| 注入组 + TIM1_TRGO | PWM 硬件决定，抖动最小 | 最低 | 电流环 |

```c
/* ADC1 注入组：只采一路电流，由 TIM1_TRGO 触发 */
hadc1.Instance                   = ADC1;
hadc1.Init.Resolution            = ADC_RESOLUTION_12B;
hadc1.Init.ScanConvMode          = DISABLE;
hadc1.Init.ContinuousConvMode    = DISABLE;
hadc1.Init.DiscontinuousConvMode = DISABLE;
hadc1.Init.ExternalTrigConv      = ADC_SOFTWARE_START;  /* 规则组不用 */
hadc1.Init.DataAlign             = ADC_DATAALIGN_RIGHT;
hadc1.Init.NbrOfConversion       = 1;
HAL_ADC_Init(&hadc1);

ADC_InjectionConfTypeDef inj = {0};
inj.InjectedChannel           = ADC_CHANNEL_1;   /* PA1 接运放输出 */
inj.InjectedRank              = 1;
inj.InjectedSamplingTime      = ADC_SAMPLETIME_28CYCLES;
inj.InjectedOffset            = 0;
inj.InjectedNbrOfConversion   = 1;
inj.InjectedTrig              = ADC_EXTERNALTRIGINJEC_T1_TRGO; /* F1 宏名带 CONV 后缀 */
inj.ExternalTrigInjecConvEdge = ADC_EXTERNALTRIGINJECCONV_EDGE_RISING;
inj.AutoInjectedConv          = DISABLE;
HAL_ADCEx_InjectedConfigChannel(&hadc1, &inj);

HAL_ADC_Start(&hadc1);              /* 使能 ADC */
HAL_ADCEx_InjectedStart(&hadc1);    /* 武装注入组，等 TIM1_TRGO */
```

1 µs 这个延迟不是拍脑袋定的。它要大于死区加振铃时间，又要小于最小低边导通时间。我的死区设的是几百纳秒，示波器上看振铃大约在 600 ns 内衰减完，所以取 1 µs 留一点余量。如果你的死区更大、母线更高、寄生电感更大，这个值要往上调，而且必须用示波器确认，不能只看代码。

## 四、采样窗口和 RC 滤波：两个时间常数要分开算

采样点对了，还有第二个坑：采样保持窗口不够。ADC 内部采样电容要在采样时间里充到接近输入电压，12 位大约需要 8.3 个时间常数。源阻抗越高、采样时间越短，读数越偏低。我最早把采样时间设成 1.5 个周期，前端又串了 1 kΩ，读数在小电流段明显偏小，而且随温度变，这就是典型的没充够。

更隐蔽的问题在 RC 滤波。我一开始在运放输出后面放了 1 kΩ 加 100 nF，想着把电流纹波滤平。算一下时间常数就是 100 µs，比我 50 µs 的开关周期还长。结果 ADC 采到的其实是前面好几个周期的平均，相位滞后很大，电流环一带负载就震荡。后来改成 100 Ω 加 1 nF，时间常数降到 0.1 µs，只负责压掉高频尖峰；真正的纹波交给「采样点对齐 + 按周期做数字平均」处理。

这里的原则是：RC 是抗混叠和抗尖峰用的，不是用来把电流滤成一条直线的。把 RC 做大了，看似波形干净，实际是把相位裕度吃掉了，最后只能降低电流环带宽，动态性能反过来变差。

采样窗口还有一个和 PWM 频率直接相关的约束。12 位、ADC 时钟 12 MHz 时，28.5 个采样周期加 12.5 个转换周期大约 3.4 µs。20 kHz 下，90% 占空比时低边导通只有 5 µs，减去 1 µs 延迟和 3.4 µs 转换，余量已经很小；95% 占空比就放不下了。解决办法无非三条：降低 PWM 频率换更宽的窗口，但电流纹波会变大；把 ADC 时钟提到 14 MHz；或者降低源阻抗、缩短采样时间。我最后把目标占空比上限压在 90%，并接受在极端占空比下电流环降级，而不是硬把一个放不下的采样塞进去。

## 五、校零和验收：别让一个点骗过你

前端和时序都对了，最后是标定。低边采样在零电流时，运放输出并不正好是 1.65 V，电阻公差、运放失调、ADC 偏移都会贡献几个到几十个码。我的做法是把占空比设成 0，让低边常通、桥臂不开关，等电机电流衰减到零，再连续采 256 次求平均。此时 CH4 的触发还在跑，注入组照常工作，不用临时改触发源。

```c
#define SHUNT_OHM  0.010f
#define AMP_GAIN   50.0f
#define VREF_V     3.3f

static float zero_counts;      /* 0 A 对应的码值 */
static float counts_per_amp;   /* 每安培对应多少码 */

/* 调用前把占空比设为 0：低边常通，电流归零，触发仍在继续 */
float current_offset_cal(void)
{
    uint32_t sum = 0;
    for (int i = 0; i < 256; i++) {
        while (!__HAL_ADC_GET_FLAG(&hadc1, ADC_FLAG_JEOC)) { }
        __HAL_ADC_CLEAR_FLAG(&hadc1, ADC_FLAG_JEOC);
        sum += HAL_ADCEx_InjectedGetValue(&hadc1, ADC_INJECTED_RANK_1);
    }
    return sum / 256.0f;
}

void current_init(float zero_cnt)
{
    zero_counts    = zero_cnt;
    counts_per_amp = (4095.0f / VREF_V) * SHUNT_OHM * AMP_GAIN;
}

float current_read_a(void)
{
    uint16_t raw = HAL_ADCEx_InjectedGetValue(&hadc1, ADC_INJECTED_RANK_1);
    return (raw - zero_counts) / counts_per_amp;
}
```

增益我没有只信算出来的 620 码每安。电阻是 1% 的，放大器增益也有误差，我会再用一个已知负载或者串联电流表做一次单点核对；如果偏差超过几个百分点，就把 `counts_per_amp` 按实测值修正。只做零点校准、不做增益核对，在大电流段会系统性地偏。

验收我固定做四件事：示波器确认采样点落在低边导通窗口中央附近；占空比 10%、50%、90% 三点在同一电流下读数一致；堵转时读数不削顶；连续跑十分钟，零点和温漂在可接受范围内。这四件事过了，我才敢把电流环闭合。

## 小结

这次排查让我改变了一个看法：电流采样的精度，主要不是由 ADC 位数决定的，而是由「采样时刻、采样窗口、前端带宽」三件事能不能对上决定的。混合信号 MCU 把 PWM、ADC、运放和比较器放进同一颗芯片，真正的价值也在这里——触发链路短、时序确定，而不是单纯堆分辨率。以后选这类芯片，我会先看它的定时器能不能产生确定的单次触发、注入组能不能独立于规则组工作，再看 ADC 的位数和采样率。

如果你也在调电机电流环，建议先别动 PID。拿示波器看一眼采样点落在哪，很多问题当场就能解释清楚。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

