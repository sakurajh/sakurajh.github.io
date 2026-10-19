---
layout: post
title: "STM32 的 I2C 卡死在 BUSY：从机按住 SDA 的成因与恢复时序"
date: 2026-10-20 06:02:00 +0800
categories: 硬件设计
tags: STM32 I2C 总线死锁 嵌入式 HAL库
description: "从一次 OLED 刷新卡死的现场出发，讲清 I2C 开漏总线为什么会停在 BUSY、从机为什么一直按住 SDA，以及用 9 个时钟脉冲加手动 STOP 恢复总线的完整代码与预防措施。"
---

去年给实验室的环境监测节点加了一块 0.96 寸 OLED，和温湿度传感器共用 I2C1。台面上调试一切正常，放到窗边连续跑了几天后，早上来发现串口没输出了，程序停在 OLED 刷新的 `HAL_I2C_Master_Transmit` 里面。看门狗复位之后又能跑，但过几个小时还会再来一次。换过传感器、换过杜邦线，问题依旧，最后用逻辑分析仪抓波形才发现：每次卡死时 SCL 是高电平，SDA 被从机一直拉低，总线根本发不出起始条件。

这篇文章把这件事拆开讲：BUSY 标志到底在等什么，从机为什么会按住 SDA 不放，以及怎么用软件把总线救回来。

## BUSY 位到底在等什么

STM32 的 HAL 库在阻塞式收发里会先检查 `I2C_FLAG_BUSY`。这个标志不是"外设正在忙"，而是**总线电平状态**的映射：只要 SCL 或 SDA 有一根被拉低，硬件就认为总线被占用，BUSY 置位。

问题在于，很多示例代码是这么写的：

```c
HAL_I2C_Master_Transmit(&hi2c1, addr, buf, len, HAL_MAX_DELAY);
```

`HAL_MAX_DELAY` 意味着永不超时。一旦总线被从机按住，这行代码就在 `while` 里等 BUSY 清零，等不到就永远不返回。主循环停了，喂狗停了，最后只能靠看门狗复位。所以第一个结论很直接：**所有 I2C 阻塞调用都必须给超时**，`HAL_MAX_DELAY` 在 I2C 上不是一个可以偷懒的选项。

给了超时之后，函数会返回 `HAL_BUSY` 或 `HAL_TIMEOUT`。但返回错误只是把"卡死"变成了"报错"，总线仍然是死的，下一次调用照样失败。要真正恢复，得先搞清楚从机为什么不肯松手。

还有一种常见写法是用 `HAL_I2C_IsDeviceReady` 在初始化时扫描地址，确认设备在线。这个函数同样依赖总线空闲，总线被按住时它只会一直返回 `HAL_BUSY`，既不能证明从机坏了，也不能把总线救活。把它当成上电自检可以，当成修复手段不行。

## 从机为什么会把 SDA 按住不放

I2C 的两根线都是开漏结构：器件只能把线拉低，拉高靠上拉电阻。也就是说，总线上任何一个器件拉低，整根线就是低电平，谁也抢不回来。

一次完整的字节传输是 8 个数据位加 1 个应答位。从机在输出数据时，会在 SCL 低电平期间把下一位放到 SDA 上；如果这一位是 0，它就把 SDA 拉低，然后等主机给出第 9 个时钟来读应答。**如果主机在这个节骨眼上复位了**，SCL 停在某个状态不再翻转，从机就会一直保持 SDA 为低，等那个永远不来的时钟。

这时候主机重新启动，想要发出起始条件：SCL 为高时让 SDA 由高变低。可 SDA 已经被从机拉低，主机根本无法制造这个下降沿，硬件看到 SDA 低就置 BUSY，于是卡住。除了 MCU 复位，下面几种情况也会造成同样的局面：

- 从机上电比 MCU 晚，MCU 已经开始扫描总线；
- 热插拔传感器，插头瞬间的毛刺被从机当成了时钟；
- 从机自身死机或供电跌落，输出级停在低电平；
- 多主机系统中 arbitration 丢失后状态机没有正确复位。

所以"换一根线就好了"往往是错觉，真正变化的是复位时机和上电顺序。

另外要区分两种"按住"：按住 SDA 和按住 SCL。前者是从机在等时钟，补时钟有效；后者是从机在做 clock stretching，或者 SCL 被短路，此时主机连一个高电平都发不出去，9 个时钟也无从谈起。所以恢复函数执行前先看一眼两根线的电平，能省掉很多无效尝试。

## 先用 9 个时钟把总线救回来

从机等的其实很简单：把当前这个字节剩下的时钟补完，它就会释放 SDA。一个字节最多 9 个时钟（8 位数据加 1 位应答），所以恢复的标准做法是：**把 I2C 外设关掉，用 GPIO 手动在 SCL 上打最多 9 个脉冲，SDA 保持释放，最后补一个 STOP**。

手动打脉冲之前要先 `HAL_I2C_DeInit`，否则外设还占着引脚。恢复完成后调用 `HAL_I2C_Init`，HAL 会通过 `MspInit` 把引脚切回复用开漏模式。

```c
#define I2C_SCL_PORT  GPIOB
#define I2C_SCL_PIN   GPIO_PIN_6
#define I2C_SDA_PORT  GPIOB
#define I2C_SDA_PIN   GPIO_PIN_7

/* 返回 1 表示恢复成功，0 表示 SDA 仍被拉低，多半是硬件问题 */
static uint8_t i2c_bus_recover(I2C_HandleTypeDef *hi2c)
{
    GPIO_InitTypeDef gpio = {0};
    uint8_t ok;

    HAL_I2C_DeInit(hi2c);                 /* 外设让出引脚 */

    gpio.Mode  = GPIO_MODE_OUTPUT_OD;     /* 开漏，和总线电气一致 */
    gpio.Pull  = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;

    gpio.Pin = I2C_SCL_PIN;
    HAL_GPIO_Init(I2C_SCL_PORT, &gpio);

    /* SDA 先设为输入，确保不会和从机对拉 */
    gpio.Pin  = I2C_SDA_PIN;
    gpio.Mode = GPIO_MODE_INPUT;
    HAL_GPIO_Init(I2C_SDA_PORT, &gpio);

    ok = (HAL_GPIO_ReadPin(I2C_SDA_PORT, I2C_SDA_PIN) == GPIO_PIN_SET);
    if (!ok) {
        for (uint8_t i = 0; i < 9; i++) {
            HAL_GPIO_WritePin(I2C_SCL_PORT, I2C_SCL_PIN, GPIO_PIN_RESET);
            i2c_delay_us(5);
            HAL_GPIO_WritePin(I2C_SCL_PORT, I2C_SCL_PIN, GPIO_PIN_SET);
            i2c_delay_us(5);
            if (HAL_GPIO_ReadPin(I2C_SDA_PORT, I2C_SDA_PIN) == GPIO_PIN_SET) {
                ok = 1;
                break;
            }
        }
    }

    if (ok) {
        /* SDA 已释放，补一个 STOP：SCL 高时 SDA 由低变高 */
        gpio.Pin  = I2C_SDA_PIN;
        gpio.Mode = GPIO_MODE_OUTPUT_OD;
        HAL_GPIO_Init(I2C_SDA_PORT, &gpio);

        HAL_GPIO_WritePin(I2C_SCL_PORT, I2C_SCL_PIN, GPIO_PIN_RESET);
        HAL_GPIO_WritePin(I2C_SDA_PORT, I2C_SDA_PIN, GPIO_PIN_RESET);
        i2c_delay_us(5);
        HAL_GPIO_WritePin(I2C_SCL_PORT, I2C_SCL_PIN, GPIO_PIN_SET);
        i2c_delay_us(5);
        HAL_GPIO_WritePin(I2C_SDA_PORT, I2C_SDA_PIN, GPIO_PIN_SET);
        i2c_delay_us(5);
    }

    HAL_I2C_Init(hi2c);                   /* MspInit 会把引脚切回复用模式 */
    return ok;
}
```

`i2c_delay_us` 可以用 DWT 计数器或者定时器实现。核心不是精确的 5 微秒，而是让 SCL 的低电平和高电平都足够宽，慢一点没关系，快到来不及被从机采样才会出问题。

调用方应该把"超时、恢复、重试一次"包在一起，并且限制重试次数：

```c
HAL_StatusTypeDef i2c_write_retry(uint16_t addr, uint8_t *buf, uint16_t len)
{
    HAL_StatusTypeDef st;

    st = HAL_I2C_Master_Transmit(&hi2c1, addr, buf, len, 10);
    if (st == HAL_OK) {
        return st;
    }

    if (!i2c_bus_recover(&hi2c1)) {
        return HAL_ERROR;                 /* 硬件层面没救回来，交给上层处理 */
    }
    return HAL_I2C_Master_Transmit(&hi2c1, addr, buf, len, 10);
}
```

这里有一个容易忽略的细节：恢复函数只负责把总线拉回空闲，不负责判断"为什么出错"。如果 `i2c_bus_recover` 返回 0，9 个时钟打完 SDA 还是低，那就不要再无限重试了，先查上拉电阻、查短路、查从机供电，再考虑给从机断电重启。

我现在习惯在 `main` 里、第一次访问任何 I2C 设备之前先调用一次恢复函数。因为上一次复位很可能就发生在传输中途，从机还停在半个字节里；如果等第一次读写失败再恢复，等于把故障推迟到业务代码里。代价只是启动时多花几十微秒。

如果板子空间允许，我还会留一路软件 I2C 作为兜底：GPIO 模拟的时序完全可控，遇到从机 clock stretching 也能自己决定等多久。它不是要替代硬件 I2C，而是在调试阶段用来对比——同一套读写逻辑，硬件外设失败、软件时序成功，基本就能把问题锁定在总线状态而不是从机寄存器。

## 恢复是补救，预防才是正事

把恢复函数加进去以后，那个节点确实不再整机卡死了，但偶尔还是会丢一帧显示数据。后来我按下面的顺序逐项检查，才把根因压下去。

| 现象 | 更可能的原因 | 怎么确认 | 处理 |
|---|---|---|---|
| 一上电就 BUSY，SDA 始终为低 | 从机供电晚于 MCU，或上次传输被打断 | 断电测 SDA 对地电阻，上电看电平 | 调整上电顺序；从机加复位脚；启动时先做一次总线恢复 |
| 偶发 `HAL_BUSY`，重新初始化就好 | 干扰、时钟被拉长、总线电容过大 | 逻辑分析仪抓 SCL/SDA 波形 | 加超时与恢复；缩短走线；检查上拉 |
| SCL 一直被拉低 | 从机 clock stretching 卡住或短路 | 断开从机看 SCL 是否释放 | 查从机状态；必要时断电重启从机 |
| 多设备时偶发丢数据 | 上拉偏弱或总线电容过大 | 看上升沿是否变缓 | 减小上拉阻值、降低速率、减少挂载设备 |

上拉电阻也不是越小越好。常见模块板上已经带了 4.7k 或 10k，多个模块并在一起，等效阻值会变小，低电平时的灌电流变大，反而可能把低电平抬高。我一般按总线和速率这样选：

| 上拉阻值 | 适用情况 | 代价 |
|---|---|---|
| 10k | 100kHz、短线、单从机 | 上升沿慢，400kHz 下波形容易变差 |
| 4.7k | 100–400kHz 的常见折中 | 模块自带时并联会偏小，需要算总阻值 |
| 2.2k | 400kHz、总线电容较小 | 灌电流大，对从机低电平驱动能力要求高 |

上电顺序这一点值得单独说：如果传感器和 MCU 共用 3.3V，但传感器板上有大电容，MCU 可能先启动并开始扫描，此时传感器还没准备好，SDA 被它拉低的概率就很高。我的做法是给传感器单独留一个 GPIO 控制的 MOSFET 或者直接用一个复位脚，等电源稳定后再释放。

除此之外，还有几件成本很低但很值的事：在 RTOS 里给 I2C 总线加互斥锁，避免两个任务同时发起传输；给从机留一个复位引脚，软件恢复失败时直接硬件复位；保留看门狗，但不要把看门狗当成 I2C 的常规恢复手段。看门狗复位整机，代价远大于恢复一条总线。

## 小结

I2C 卡死的本质不是"STM32 的 I2C 有 bug"，而是开漏总线上的状态机没有走完：从机在等时钟，主机在等 SDA 释放，双方互等。理解这一点之后，处理思路就很清楚了——给所有调用加超时，出错后用 9 个时钟加手动 STOP 把从机从当前字节里"推"出来，再重新初始化外设。恢复代码最好在系统启动时也主动跑一次，因为上一次复位很可能就是在传输中途发生的。这样即使现场再出现异常，最坏也只是丢一次读数，而不是整机停摆。

