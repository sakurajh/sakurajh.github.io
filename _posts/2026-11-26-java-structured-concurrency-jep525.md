---
layout: post
title: "JDK 26 结构化并发讲透：StructuredTaskScope 如何避免孤儿线程"
date: 2026-11-26 06:04:00 +0800
categories: 学习笔记
tags: Java 结构化并发 JEP 525 虚拟线程 并发编程
description: "订单详情页 fan-out 超时后任务还在跑，线程池活动线程降不下来。这篇从一次孤儿线程排查讲起，把 JDK 26 的 StructuredTaskScope 与线程池加 Future 的差别、超时与取消语义，以及落地时的边界一次讲清。"
---

上个月给 BookShop 的订单详情页收拾超时问题。页面要同时调用户、库存、优惠三个下游服务，原来的写法是一个固定线程池加 `Future.get(800, MILLISECONDS)`。上线后 504 不少，但监控上更奇怪的是：线程池的活动线程数一直降不下来，数据库连接偶尔被打满。后来抓了一次线程 dump 才看明白，请求早就返回了，它提交出去的任务还在池子里跑。这就是线程池最容易被忽略的地方：它对"一次请求"这件事没有任何概念。

## ExecutorService 的 submit 漏掉了什么

当时的代码大概是这样：

```java
ExecutorService pool = Executors.newFixedThreadPool(16);

Future<User> userF  = pool.submit(() -> userClient.get(uid));
Future<Stock> stockF = pool.submit(() -> stockClient.get(sku));
Future<Price> priceF = pool.submit(() -> priceClient.get(sku));

try {
    User user   = userF.get(800, TimeUnit.MILLISECONDS);
    Stock stock = stockF.get(800, TimeUnit.MILLISECONDS);
    Price price = priceF.get(800, TimeUnit.MILLISECONDS);
    return new OrderDetail(user, stock, price);
} catch (TimeoutException e) {
    userF.cancel(true);
    stockF.cancel(true);
    priceF.cancel(true);
    throw new GatewayTimeoutException();
}
```

问题出在三个地方。第一，`get` 是串行调用的，三个 800 毫秒的等待是叠加的，实际最坏要 2.4 秒才能放弃。第二，`cancel(true)` 只是往目标线程发一个中断信号，它不会杀死任务；我当时用的 HTTP 客户端阻塞在 socket 读上，对中断没有响应，所以 cancel 形同虚设。第三，也是根因：线程池按"执行资源"设计，把任务看成彼此独立的工作项，它不知道这三个 Future 属于同一次请求。请求结束时，没有任何机制告诉池子"这一组任务可以收尾了"。

所以这类任务会一直跑到下游服务自己超时、或者任务自己出错为止。请求越多，孤儿任务越多，线程和连接都被它们占着。异常传播也一样，必须逐个 `get` 才会暴露，漏掉一个 Future 就等于漏掉一次排查线索。另外固定线程池默认用无界队列，任务积压时不会拒绝，只会让延迟悄悄变大，这些问题平时不显眼，一到流量高峰就集中爆发。

## 结构化并发把一组任务变成一个工作单元

结构化并发的思路很直接：把"一组子任务"当成一个语法上的工作单元，它的生命周期和代码块的作用域绑在一起。JDK 19 以孵化 API 引入，到 JDK 26 是第六次预览。用起来是这样：

```java
try (var scope = StructuredTaskScope.open()) {
    Subtask<User>  user  = scope.fork(() -> userClient.get(uid));
    Subtask<Stock> stock = scope.fork(() -> stockClient.get(sku));
    Subtask<Price> price = scope.fork(() -> priceClient.get(sku));

    scope.join();          // 等所有子任务结束；任一失败会在这里抛出
    return new OrderDetail(user.get(), stock.get(), price.get());
}   // 离开作用域：若还有未完成的任务，在这里统一取消并等待收尾
```

`StructuredTaskScope` 实现了 `AutoCloseable`，所以 `try-with-resources` 的语义就是它的语义：只要走进这个块，fork 出去的子任务就必须在离开之前完成或者被取消，父线程才能继续。这一点和 Go 的 `errgroup`、Python 3.11 的 `TaskGroup` 是同一个思想，只是 Java 把它做进了语言结构里。

为什么这比"记得手动 cancel"可靠？因为取消不再依赖调用方的自觉。超时也好、异常也好，作用域关闭时都会统一收口；失败的兄弟任务会被取消，父线程拿到的异常也是聚合后的，不用再猜哪个 Future 出了事。默认的 `open()` 配的是 `awaitAllSuccessfulOrThrow` 策略，任一子任务失败就取消其余任务并抛出，对订单详情页这种"缺一个就不能渲染"的场景正好。

同一个 API 还能换策略。比如优惠服务做了双活，两个地址谁先返回用谁，就可以用 `anySuccessfulOrThrow()`：第一个成功的结果一出来，作用域就取消剩下的请求。线程池也能做到类似效果，但要自己写 `CompletionService` 再手动 cancel 一轮，代码量和出错概率都高得多。

配合虚拟线程就更顺了：fork 出来的子任务默认跑在虚拟线程上，阻塞等下游不会被池子的线程数卡住。结构化并发解决"生命周期"，虚拟线程解决"并发成本"，两件事刚好互补。

## JDK 26 的 JEP 525 改了什么

JDK 26（2026 年 3 月 17 日发布）里这个特性仍是预览状态，编译运行需要 `--enable-preview --release 26`，生产上要确认构建链和框架支持。第六次预览的主要变化是 API 收口：

- `Joiner` 接口新增 `onTimeout()`，超时发生时可以返回一个兜底结果，而不是一律抛异常；
- `allSuccessfulOrThrow()` 现在直接返回结果列表，不再是子任务流；
- `anySuccessfulResultOrThrow()` 简化为 `anySuccessfulOrThrow()`。

其中超时最值得单独看。原来的 `join()` 只能"等到全部结束"，JDK 26 之前要自己做 `future.get(timeout)` 那种"放弃等待但不取消"的妥协。现在可以直接给作用域设截止时间：

```java
try (var scope = StructuredTaskScope.open()) {
    Subtask<User>  user  = scope.fork(() -> userClient.get(uid));
    Subtask<Stock> stock = scope.fork(() -> stockClient.get(sku));

    scope.joinUntil(Instant.now().plusMillis(800));
    return new OrderDetail(user.get(), stock.get());
} catch (TimeoutException e) {
    // 离开 try 时作用域已经关闭：没跑完的子任务被取消并等待退出
    throw new GatewayTimeoutException();
}
```

注意这里和线程池版本的本质差别：`joinUntil` 超时抛异常后，`try-with-resources` 会在关闭作用域时取消还没完成的子任务，并且等它们真正结束（包括响应中断的过程）。线程池版本里，超时只是调用方不再等，任务还在跑。一个是"收口"，一个是"放手"。

| 维度 | ExecutorService + Future | StructuredTaskScope |
|---|---|---|
| 任务关系 | 任务与提交者无父子关系，池子只负责执行 | fork 出的子任务挂在作用域下 |
| 超时 | 只作用于 `get()`，调用方放弃等待，任务照跑 | `joinUntil` 超时后关闭作用域，统一取消 |
| 失败传播 | 要逐个 `get()` 才暴露 | 任一失败即取消兄弟任务并抛出 |
| 取消 | `cancel(true)` 只是中断信号，阻塞 I/O 可能不理 | 关闭作用域时取消并等待收尾，语义明确 |
| 可观测性 | 线程 dump 里只有 `pool-1-thread-N` | 子任务有明确的组归属，异常聚合后可追溯 |
| 结果获取 | 每个 Future 各自取 | `Subtask.get()` 在 join 之后取，生命周期受控 |
| 适合场景 | 长期存活的任务队列、后台异步任务 | 一次请求内的 fan-out / fan-in |

## 我在 BookShop 里落地的几条边界

换成结构化并发后，超时不再留下孤儿任务，活动线程数也回到了正常水位。但落地过程中踩了几个边界，值得写下来：

1. **不要把 Subtask 带出作用域。** 离开 `try` 块时作用域已经关闭，子任务要么完成要么被取消，把 `Subtask` 存到成员变量或者返回给上层，拿到的结果没有意义。结构化并发的价值就在于"结果只能在作用域内消费"。

2. **并发度不等于下游连接数。** fork 一千次就是一千个虚拟线程，看起来很爽，但下游连接池、限流器还是按原来的容量算。虚拟线程便宜的是线程本身，不是网络连接和数据库会话。我在订单页只 fork 三个任务，就是因为它对应三个下游，不需要再拆细。

3. **它不适合 fire-and-forget。** 发通知、写日志、刷新缓存这类"请求结束还要继续跑"的任务，本来就该交给消息队列或者任务表，硬塞进请求作用域只会把接口拖慢。结构化并发的前提是"这些任务必须在请求内结束"。

4. **取消是协作式的，下游客户端要配合。** 作用域关闭会 interrupt 子任务，但如果下游客户端不响应中断，就只能等它自己的 socket 超时。所以我在 HTTP 客户端上单独设了连接和读取超时，双重保险，作用域负责"该取消谁"，客户端负责"尽快退出来"。另外子任务的异常我都带上了服务名再抛出，否则聚合异常只告诉我"失败了"，还得翻日志反查是哪个下游挂了。

5. **预览特性要算升级成本。** 需要 `--enable-preview`，字节码目标版本也要跟着调，团队里如果有老框架或者字节码增强工具，先确认兼容性。我的做法是先在订单详情这种只读接口上灰度，出问题回滚成本低。

## 小结

线程池解决的是"线程复用"，不是"任务归属"。一次请求 fan-out 出去的子任务，如果没人负责收口，超时只会让调用方放手，任务本身还在跑。结构化并发把这些任务绑到一个作用域上，成功一起成功，失败一起取消，超时一起收尾。JDK 26 的 JEP 525 仍是预览，但 `joinUntil` 和 `Joiner.onTimeout()` 已经把超时这块补齐了。判断标准其实很简单：问自己一句——请求返回时，这组任务是不是必须已经结束？如果是，就交给作用域；如果不是，就别硬塞进请求里。如果你手上也有"一个接口调三个下游、超时后线程降不下来"的项目，这个特性值得先在只读接口上试一次。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

