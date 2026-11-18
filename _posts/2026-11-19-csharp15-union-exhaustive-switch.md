---
layout: post
title: "C# 15 联合类型 union 讲透：.NET 11 里让 switch 穷尽检查兜底"
date: 2026-11-19 06:04:00 +0800
categories: 学习笔记
tags: C# 联合类型 .NET 11 模式匹配 类型系统
description: "串口帧解析工具里漏写一个分支，日志静默空白，查了两个小时。本文用 .NET 11 / C# 15 的 union 声明重写结果类型，讲清它和抽象类、枚举的边界，null 分支与默认值的陷阱，装箱代价，以及从旧写法迁移的顺序。"
---

我给实验室的 STM32 板子写了一个串口采集的小上位机，核心是一个帧解析器。一帧数据解析完，结果只有四种：正常帧、校验失败、等待超时、半包未收齐。早先我用一个抽象基类加几个子类表示这四种情况，在日志函数里用 `switch` 分支输出。用了大半年都没事，直到我加了第四种"半包"状态。

上线那天，日志里凡是半包的行全是空白，既没有内容也没有异常。我第一反应是写日志的线程挂了，查了半小时才发现：那个 `switch` 里根本没有 `Incomplete` 分支，落进了 `_ => "unknown"`。编译器一声没吭。从那一刻起我就明白，抽象类这套写法在 C# 里天然兜不住"全集"这件事。

最近 .NET 11 正式发布（2026 年 11 月 10 日），C# 15 把 `union` 联合类型带了进来。我拿 SDK 建了个 `net11.0` 的试作项目，把这套结果类型重写了一遍，也顺便把几个边界问题搞清楚了。这篇就按我当时的顺序写。

## 旧写法为什么兜不住

先还原我最初的设计：

```csharp
public abstract record FrameOutcome;
public record Ok(byte[] Payload) : FrameOutcome;
public record ChecksumError(byte[] Raw) : FrameOutcome;
public record Timeout(int Ms) : FrameOutcome;
public record Incomplete(int Received, int Expected) : FrameOutcome;

static string Describe(FrameOutcome o) => o switch
{
    Ok ok => $"ok:{ok.Payload.Length}",
    ChecksumError e => "checksum",
    Timeout t => $"timeout after {t.Ms}ms",
    _ => "unknown",
};
```

这段代码能编译、能跑，问题在于最后那个 `_` 分支。C# 的抽象类不是封闭的，任何程序集里都能再写一个 `public record Noise : FrameOutcome;`，编译器无法知道全集有几个成员，所以只能要求你写一个兜底分支。兜底分支一旦写上，新增子类时编译器就没有理由提醒你，错误被悄悄吞掉。

接口也一样：接口是"可被实现"的承诺，不是"只有这几种"的清单。枚举加字段的方案能穷尽，但它把"是哪种情况"和"带了什么数据"拆成两个东西，取数据还得强制转换，类型系统帮不上忙。

我需要的是这样一种声明：把候选项写死在类型里，让编译器知道一共几种，漏一种就报错。

## union 声明长什么样

C# 15 的写法很直接，先声明四种结果类型，再用 `union` 把它们组合起来：

```csharp
public record Ok(byte[] Payload);
public record ChecksumError(byte[] Raw, byte Expected, byte Actual);
public record Timeout(int Ms);
public record Incomplete(int Received, int Expected);

public union FrameOutcome(Ok, ChecksumError, Timeout, Incomplete);

static string Describe(FrameOutcome outcome) => outcome switch
{
    Ok ok => $"ok:{ok.Payload.Length}",
    ChecksumError e => $"checksum {e.Expected:X2}!={e.Actual:X2}",
    Timeout t => $"timeout after {t.Ms}ms",
    Incomplete i => $"incomplete {i.Received}/{i.Expected}",
    null => "empty",
};
```

三个关键点。第一，每种事例类型到 `FrameOutcome` 都有隐式转换，`FrameOutcome f = new Timeout(200);` 直接能写，内部是调用编译器生成的构造函数。第二，`switch` 必须覆盖全部事例类型，我把 `Incomplete` 那行故意删掉再编译，编译器立刻在 `Describe` 上报"未处理所有可能的值"，这正是我想要的提醒。第三，没有 `_` 分支也能编译通过，恶意兜底被彻底省掉了。

官方语言参考里有一句话概括得很准：union 不定义新的数据成员，它只是把现有类型组合成一组封闭的候选项。所以它不是继承，也不参与多态；它回答的问题只有一个——现在装的是哪一种？

## 它编译成了什么，代价在哪

这一点值得单独说，因为它决定了什么时候不该用。

编译器会把 `union` 声明转换成一个 `struct`，给它加上 `Union` 特性并实现 `IUnion` 接口，同时生成每种事例类型的构造函数和一个 `object?` 类型的 `Value` 属性。也就是说，如果事例类型是 `int` 这类值类型，值会被装箱成 `object?` 存起来。官方文档明确写了这个行为，不是我猜的。

我当时的取舍是：帧率不高，每帧只解析一次，这层装箱开销我判断可以接受，先换正确性；如果以后真要做高频采集，官方也给了出路——手写一个带 `TryGetValue` 和 `HasValue` 的自定义联合类型，模式匹配时可以不装箱。但我没有测过装箱对吞吐的具体影响，所以这里只说方向，不给数字。

四种常见方案横向对比一下：

| 方案 | 编译期穷尽检查 | 能否携带数据 | 新增情况时是否提醒 | 额外开销 |
|---|---|---|---|---|
| 抽象类 + `_` 兜底 | 否 | 能 | 不会 | 继承，无装箱 |
| 接口 + 模式匹配 | 否 | 能 | 不会 | 与实现相关 |
| 枚举 + 附加字段 | 能 | 靠强转，易错 | 不会 | 无 |
| C# 15 `union` | 是 | 能 | 会，编译警告 | 值类型事例会装箱 |

注意最后一行也和 `closed` 有关，下面单独说。这张表也是我选 union 的直接理由：在"结果只有几种"的场景里，它是唯一能同时保证带数据和穷尽的写法。

## null 与默认值：穷尽里的漏网之鱼

穷尽检查有个容易被忽略的角落：默认值。

`default(FrameOutcome)` 是一个合法的联合值，但它的内容 `Value` 是 `null`。如果你的 `switch` 只写了四种事例类型、没写 `null` 分支，编译器未必会警告（取决于可空性跟踪的结论），运行时却会抛 `SwitchExpressionException`。这比旧写法更危险一点：旧写法有 `_` 兜底，不会抛，只是悄悄走错分支；新写法把问题从"静默"变成了"崩溃"，其实是好事，但前提是你要在测试里让它发生一次。

我的做法是每个联合的 `switch` 都显式写 `null` 分支，而不是用 `_` 或 `var` 兜底。原因很实在：`null` 分支表明"我知道空值存在"，并且新增事例类型时，编译器仍然会对缺少该类型的 `switch` 报警；如果换成 `var` 放弃分支，它接受任何新情况，编译器就再也不会提醒你了。官方文档也建议优先用 `null` 而不是 `_`。

还有两个容易写错的点。用 `outcome is FrameOutcome` 判断是编译错误（CS8121），因为类型模式测的是联合的内容，而 `FrameOutcome` 不是任何一个事例类型；要判断有没有值，用 `is not null` 或 `Value is not null`。另外，当某个事例类型本身可空时（比如 `Cat?`），省略 `null` 分支会直接触发警告（CS8655）。

## 已经有了继承树，还要不要换 union

C# 15 同时给了另一个选项：`closed` 修饰符。

```csharp
public closed record class GateState;
public record class Closed : GateState;
public record class Open(float Percent) : GateState;

static string Describe(GateState state) => state switch
{
    Closed => "closed",
    Open(var percent) => $"{percent}% open",
};
```

`closed` 表示这个类只能在其声明程序集内被派生。因为编译器能看到直接后代的完整列表，`switch` 处理完每个子代就算穷尽，不需要默认分支。它是上下文关键字，类隐式抽象，不能和 `sealed`、`static`、显式 `abstract` 一起用，而且封闭性不传递：中间后代如果不也标 `closed`，它在其他程序集里仍然可以被继续派生。

我的判断标准很朴素：如果几种情况之间需要共享方法、共享字段、按继承层次扩展行为，就用 `closed` 继承树，改动量也最小；如果只是"一个函数返回几种结果之一"，没有共享行为，就用 `union`。两条路都能让编译器替你记住全集，区别在于是想要"家族"还是"变量"。

## 我的迁移顺序与版本选择

最后说落地，这部分比语法重要。

版本上要清醒：.NET 11 是标准支持期版本（STS），不是 LTS；按微软的发布节奏，长期支持仍然是 .NET 10。我在试作项目里验证语法用的是 `net11.0`，生产上的采集工具没有跟着切，等这一版逻辑跑上两周、测试补齐了再谈升级。C# 15 是以 `net11.0` 为目标的项目的默认语言版本，这点不用额外配 `LangVersion`。

迁移顺序我分四步：

1. 先挑"返回值只有几种可能"的类型换，比如解析结果、命令执行结果、下载状态；有共享逻辑的类型先不动。
2. 把 `union` 里每个 `switch` 的 `_` 分支删掉，补上显式的 `null` 分支。
3. 在测试里塞一个 `default` 值，确认运行时异常能被接住，而不是悄悄走错分支。
4. 真有高频路径再考虑自定义联合类型或非装箱访问模式，不要一上来就为性能把代码写复杂。

我自己的帧解析器按这个顺序改完，最直观的收益不是代码变短，而是"新增一种结果"从此变成一件编译器会管的事。上次那两个小时的排查，在改完之后就再也不会发生了。

## 小结

C# 15 的 `union` 不是给继承体系加的新语法糖，而是补上了一个 C# 一直缺的东西：把"全集"写进类型声明。它的价值在编译期提醒，不在运行时多态；代价是值类型事例会装箱。想清楚这两点，再决定用 `union` 还是 `closed` 继承树，就不会选错。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

