---
layout: post
title: "SpringBoot 三层架构里 DTO 该放哪一层：从鸿蒙登录接口返回密码说起"
date: 2026-10-26 06:03:00 +0800
categories: 软件实战
tags: SpringBoot MyBatis DTO 接口分层 HarmonyOS
description: "给鸿蒙 App 写的 SpringBoot 后端，登录接口直接返回 User 实体，password 也一起回了客户端。这篇按三层拆开，讲清实体、DTO、VO 各该待在哪一层，校验注解为什么不能写在实体上。"
---

答辩前一周，我给鸿蒙 App 配的后端 `lifeApp0110` 已经跑通了登录、待办和图标三个模块。技术栈很普通：SpringBoot 2.3.4、MyBatis 2.1.4、MySQL 5.x，包名 `com.qf.lifeapp0110`，用 `@Controller + @ResponseBody` 把对象直接转成 JSON 回给客户端。答辩前一天我打开 Swagger 核对接口，`/user/one` 的响应示例里赫然列着 `password`。再看代码，这个登录接口连密码比对都没写，只按用户名查了一次，就把整行数据交了出去。

我一开始以为补一行密码判断就完了，真正改起来才发现问题不在那一行 `if`，而在接口的"形状"是由数据库表决定的：表里有什么列，客户端就能收到什么字段。这篇把那次改造完整写一遍，重点不是背分层口诀，而是说清每一类对象为什么只能待在一个地方。

## 一、实体为什么不能直接出网关

实体（Entity）的定义很简单：一个类对应一张表，一个对象对应一行记录。项目里 `user` 表只有 `id`、`username`、`password` 三列，MyBatis 的 `queryByName` 返回的就是这个实体。问题在于，实体一旦被 `@ResponseBody` 序列化，它就从"数据库的投影"变成了"对外契约"。当时的代码大致是这样：

```java
@RequestMapping("/one")
@ResponseBody
public Map queryOne(@RequestBody User user1) {
    Map map = new HashMap();
    User user = userMapper.queryByName(user1.getUsername());
    if (user != null) {
        map.put("user", user);          // 整个实体进了 JSON
        map.put("message", "ok");
    } else {
        map.put("user", new User());    // 失败也用空对象兜底
        map.put("message", "error");
    }
    return map;
}
```

这段代码有三个隐患，而且都不是改一行能解决的。

第一，返回体里带着 `password`。只要字段在实体上，任何返回实体的接口都会带上它，今天是登录，明天是"查个人资料"，后天是"管理员看用户列表"。靠每个接口手动置空，迟早漏一个，而漏的那次通常没人发现。

第二，表结构和 API 绑死。以后给 `user` 加 `phone`、`is_deleted`，客户端收到的 JSON 立刻多出字段；反过来，客户端想要的"昵称 + 头像"如果不在表里，接口就拼不出来。接口本应描述业务能力，现在却成了 DDL 的镜像。

第三，`new User()` 把"没查到"编码成了"一个 id 为 0 的空对象"。鸿蒙端必须知道"id 为 0 就表示失败"这个隐含约定，编译器不检查，Swagger 也写不出来。这类约定一旦散落在客户端代码里，后端想改错误码都改不动。

## 二、三类对象，三种生命周期

改造时我先把对象按职责分开，而不是急着建一堆类：

| 对象 | 所在包 | 由谁创建 | 字段从哪来 | 能不能出网关 |
|---|---|---|---|---|
| Entity / PO | `entity` | MyBatis 映射 | 数据库表的列 | 不能 |
| DTO（入参） | `dto` | Spring MVC 反序列化 | 客户端请求体 | 只在入方向 |
| VO（出参） | `vo` | Service 组装 | 业务需要展示的字段 | 可以，且只暴露必要字段 |

这张表里最关键的是最后一列。实体不能出网关，不是因为它"层次低"，而是它的字段集合由 DDL 决定，对外字段集合应该由接口设计决定，这两个集合的变更节奏根本不同。表可以为了查询性能加冗余列，接口却不能因为这个就把冗余列抖给客户端。

还要说明一点：不是每个接口都得配三个类。这个项目里我只有 `LoginRequest` 和 `UserVO` 两个，够用了。真正不能破的是方向——Controller 可以依赖 DTO 和 Service，Service 不能依赖 `HttpServletRequest`，Mapper 更不能认识 VO。

## 三、入参 DTO：校验注解跟着契约走

登录接口的入参单独抽出来，校验注解放这里：

```java
public class LoginRequest {
    @NotBlank(message = "用户名不能为空")
    private String username;

    @NotBlank(message = "密码不能为空")
    private String password;

    // getter / setter 省略
}

@PostMapping("/login")
public UserVO login(@Valid @RequestBody LoginRequest req) {
    return userService.login(req);
}
```

为什么校验不写在 `User` 实体上？因为这个实体同时被注册、改资料、后台编辑复用，三处对字段的要求并不一样：注册时用户名密码都必填，改昵称时密码根本不该出现。注解写在实体上，就得引入 validation groups 按场景分组，分组一多，注解比字段还长，后来接手的人也不敢删。更重要的是，校验规则属于接口契约，接口改规则就改 DTO，不该逼着表一起动。

入参 DTO 还只放客户端能决定的东西。`id`、`create_time` 这类字段不要出现在请求对象里：它们要么由数据库生成，要么由服务端赋值。请求对象里没有这个字段，客户端就没法伪造，这比在 Service 里补一堆 `if (id != null) throw` 省事得多。

## 四、出参 VO：转换放在 Service

出参单独定义，并且把"哪些字段可以出门"这条规则收在一处：

```java
public class UserVO {
    private Integer id;
    private String username;

    public static UserVO from(User user) {
        UserVO vo = new UserVO();
        vo.setId(user.getId());
        vo.setUsername(user.getUsername());
        return vo;
    }
}

@Service
public class UserService {
    @Autowired
    private UserMapper userMapper;
    @Autowired
    private PasswordEncoder passwordEncoder;

    public UserVO login(LoginRequest req) {
        User user = userMapper.queryByName(req.getUsername());
        if (user == null || !passwordEncoder.matches(req.getPassword(), user.getPassword())) {
            throw new BizException("用户名或密码错误");
        }
        return UserVO.from(user);
    }
}
```

为什么转换放在 Service 而不是 Controller？因为 Controller 的职责是把 HTTP 翻译成方法调用，它不该知道"哪个字段敏感"。让 Controller 转换，每加一个接口就要重新判断一次该脱哪些字段，漏一次就是一次事故；放在 Service，规则只有一份，登录、资料页、后台列表都走同一个 `UserVO.from`。

这里有个我踩过的细节：一开始图省事用了 `BeanUtils.copyProperties(user, vo)`，后来 VO 的 `id` 写成 `Long`，实体是 `Integer`，类型不匹配时它直接静默跳过，`id` 一直是 null。接口返回 200，前端拿到空值，排查了半天。字段少的时候手写 `from()` 最稳；字段多了上 MapStruct，它是编译期生成代码，源字段对不上会给出警告，配置成 ERROR 就直接编译失败，比运行时才发现强。

顺带说密码。表里存的还是明文（列定义是 `varchar(32)`），这次我只把接口改造和密码存储拆成两件事：接口先改成不返回密码、比对走 `PasswordEncoder.matches`（引入 `spring-security-crypto` 这个独立包就够，不必把整个 Spring Security 拖进来），哈希迁移单独排期。两件事混在一个提交里，出问题很难判断是哪一步导致的。

## 五、包结构和依赖方向

改造后的目录是这样的，每个包只做一件事：

```text
com.qf.lifeapp0110
├── controller     UserController   只依赖 dto 和 service
├── service        UserService      业务规则、实体转 VO
├── dao            UserMapper       只进出 Entity
├── entity         User             与表一一对应
├── dto            LoginRequest     入参 + 校验注解
├── vo             UserVO           出参
└── common         BizException     统一异常
```

依赖方向只有一条：controller → service → dao。`dto` 和 `vo` 被上层依赖，自己不反过来依赖 mapper。只要在 `vo` 包里看到 `import com.qf.lifeapp0110.dao.UserMapper`，分层就已经破了，而且这种破坏往往是从"顺手查一下"开始的。

DAO 的入参也要守住。`queryByName(String username)` 是对的，`query(LoginRequest req)` 就不对——DAO 一旦认识 HTTP 契约，将来接口从 REST 换成内部 RPC 或者定时任务调用，DAO 都得跟着改。

常见放错位置的现象，我整理成了这样一张表：

| 现象 | 根因 | 后果 |
|---|---|---|
| Controller 直接返回 User 实体 | 出参用了 PO | 表字段即 API，password 顺手带出 |
| 校验注解写在实体上 | 契约规则和表约束混在一起 | 改单个字段也要整对象校验 |
| Service 返回 `Map` | 没有出参类型 | 前端靠猜字段，Swagger 生成不出来 |
| DTO 放进 `dao` 包 | 层间依赖反了 | 换调用方式要连 DAO 一起改 |
| VO 里塞 `UserMapper` | 出参层偷偷查库 | 循环依赖、事务边界混乱 |

## 六、改造顺序：先加，再切，最后删

这次改造最怕的不是写错，是鸿蒙端的老版本还在读 `user.password` 判断登录成功。所以我没做"一把梭"：

1. Service 新增 `login` 返回 `UserVO`，旧接口原样保留，先让新接口在 Swagger 里跑通；
2. 鸿蒙端 `LoginPage.ets` 切到新接口，用 `message` 字段判断结果，不再看 `id` 是否为 0；
3. 观察一段时间旧路径的调用日志，确认没有存量版本还在用，再删旧接口；
4. 最后打开 `/swagger-ui.html` 搜一遍 `password`，响应示例里搜不到才算收尾。

兼容老客户端的原则是"加字段可以，改语义要慢"。给 VO 新增一个字段，老版本无感；把 `user` 从对象换成字符串，老版本立刻解析失败。判据不是"我这边编译通过"，而是"用户手机上的那个版本还认不认"。

## 小结

实体是表的影子，DTO 是接口的契约，VO 是业务的输出。三者混用时不会立刻报错，但每加一个字段、每改一次表、每上一个接口，风险都会沿着这条缝扩散。最小可行的做法就三条：Mapper 只碰实体；Controller 只收 DTO、只返回 VO；Service 负责把实体翻译成 VO，顺手把不该出门的字段留在里面。至于密码，它从始至终都不该出现在任何返回对象里——这一点靠纪律不如靠类型，因为类型不会忘。

