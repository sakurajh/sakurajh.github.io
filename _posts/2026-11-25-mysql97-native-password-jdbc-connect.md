---
layout: post
title: "MySQL 9.7 移除旧认证插件后，老 JDBC 项目连不上库的排查"
date: 2026-11-25 06:03:00 +0800
categories: 踩坑修复
tags: MySQL JDBC caching_sha2_password 数据库迁移 Java 踩坑
description: "8.0 今年 4 月 EOL，我把 BookShop 的库迁到 9.7.0 LTS，结果导入 dump 第一步就报 Plugin 'mysql_native_password' is not loaded，改完账号后老 JDBC 又报另一条"
---

上周末我把实验室 BookShop 的数据库从 MySQL 8.0.46 换到了 9.7.0 LTS。起因很直接：8.0 系列今年 4 月已经走到生命周期终点，最后一个版本就是 8.0.46；9.7.0 是同月发布的 LTS，官方把它当作 8.4 之后的长期支持线。课程项目虽然不急，但我不想等到某天安全补丁停了再被动迁移。

按老习惯，我先在旧库上 `mysqldump` 导出一份完整备份，装好 9.7，再用新客户端导入。原以为半小时能收工，结果卡了整整一个下午，而且错误分两层：第一层发生在导入阶段，第二层发生在 Java 项目启动阶段。两个报错看起来都是"认证失败"，根因却一个在服务端、一个在客户端。

## 一、导入 dump 第一步就停住

导出命令没什么特别：

```bash
mysqldump -u root -p --databases bookshop --routines --triggers > bookshop.sql
```

导入到 9.7 时，第一条建用户的语句就失败了：

```
ERROR 1524 (HY000): Plugin 'mysql_native_password' is not loaded
```

我先怀疑是 dump 文件坏了，用编辑器打开一看，里面确实有这样几行：

```sql
CREATE USER 'bookshop'@'localhost' IDENTIFIED WITH mysql_native_password BY '...';
```

这条语句在 8.0 上完全合法。8.0 的默认认证插件已经是 `caching_sha2_password`，但 `mysql_native_password` 作为旧插件仍然随服务端一起编译、可以使用，只是被标记为弃用。我当年建库时图省事，显式写了旧插件，dump 就原样带过来了。

而 9.x 的路线是把旧插件彻底清出去：8.4 先默认禁用，到 9.7 LTS 已经不再提供。所以 9.7 的服务器读到 `IDENTIFIED WITH mysql_native_password` 时，不是"拒绝这个密码"，而是"根本没有这个插件可以加载"。

这里有个容易误判的点：报错说的是 plugin not loaded，很容易让人以为改个配置项就能打开。实际上 8.4 还能通过启动参数把插件放回来，9.7 已经没有这个开关了——二进制里就没有这个插件，配置写得再对也没用。想靠"把插件开回来"绕过迁移，在 9.7 上是走不通的。

从安全角度看，这件事也不算"官方故意为难人"。旧插件用的是基于 SHA1 的挑战应答，握手时只交换哈希，但整体设计年代久远；新插件用 SHA256，并且把"完整认证"和"缓存认证"分开，前者要求加密通道或 RSA 公钥交换。删掉旧插件，等于把一条弱认证路径从服务端彻底移除，而不是留个开关让人继续用。

## 二、账号改完，Java 项目还是连不上

既然旧插件没了，那就统一改成新插件。我把 dump 里的建用户语句删掉，先导入表结构和数据，再单独建账号：

```sql
CREATE USER 'bookshop'@'localhost' IDENTIFIED BY '...';
GRANT ALL PRIVILEGES ON bookshop.* TO 'bookshop'@'localhost';
FLUSH PRIVILEGES;
```

不写 `IDENTIFIED WITH` 时，9.7 会用默认的 `caching_sha2_password`。命令行客户端能正常登录，`SELECT user, host, plugin FROM mysql.user` 也确认账号已经是新插件。我以为完事了，结果启动 Java 项目，连接池初始化直接抛异常：

```
java.sql.SQLException: Unable to load authentication plugin 'caching_sha2_password'.
```

这次报错的是客户端，不是服务端。项目 `pom.xml` 里锁着很老的 Connector/J 5.1.x——课程作业年代留下的版本，后来一直没人动。这个驱动在编译时内置了一份"认识的认证插件名单"，里面只有 `mysql_native_password`；服务端在握手阶段报出 `caching_sha2_password`，驱动查表查不到，连接还没真正开始就断了。

同一个"连不上"，前后是两个完全相反的方向：

- 导入阶段：**服务端**不认识旧插件，因为 9.7 删掉了它；
- 启动阶段：**客户端**不认识新插件，因为驱动太老。

这也是我后来复查其他项目时最有用的一条经验：看到认证类报错，先分清是 server 端找不到插件，还是 client 端不认识插件，两者的修法完全不重叠。

握手顺序值得记一下：TCP 连上之后，服务端先发 greeting 包，里面写明它准备用哪个认证插件；客户端拿这个名字去自己的实现里查，查不到就直接抛异常。密码在这轮对话里根本还没参与。所以 `Unable to load authentication plugin` 描述的不是"密码错了"，而是"我不认识这套认证方式"，这时候改密码、加权限都不会有任何效果。

顺带说一句，Connector/J 从 8.0.9 起就支持 `caching_sha2_password`，官方发布说明里写得很清楚。也就是说，这个坑不是新坑，只是老项目一直没升级驱动，直到服务端把旧插件删掉才暴露出来。

## 三、正确的修法：驱动、连接串、账号三件事一起改

我先确认依赖树里没有别的库把 5.1 驱动间接带回来：

```bash
mvn dependency:tree | findstr mysql
```

确认只有一处之后，把驱动换成支持新插件的版本（8.0.9 是门槛，我直接用了中央仓库的当前稳定版），再改连接串。本地开发库没开 TLS，连接串要显式允许客户端向服务端索取 RSA 公钥：

```java
String url = "jdbc:mysql://127.0.0.1:3306/bookshop"
        + "?sslMode=DISABLED"
        + "&allowPublicKeyRetrieval=true"
        + "&serverTimezone=Asia/Shanghai"
        + "&characterEncoding=UTF-8";

try (Connection conn = DriverManager.getConnection(url, "bookshop", "***");
     Statement st = conn.createStatement();
     ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM books")) {
    rs.next();
    System.out.println("books = " + rs.getInt(1));
}
```

`allowPublicKeyRetrieval=true` 不是随手加的。`caching_sha2_password` 在"完整认证"阶段需要把密码用服务端的 RSA 公钥加密后再发；如果连接没走 TLS，客户端就得先向服务端要公钥。老版本驱动默认不允许这个动作，因为它意味着客户端无条件信任对面递过来的公钥——中间人可以伪造服务端、换掉公钥，进而拿到密码。本地回环地址上这么用没问题，生产环境绝对不行。

生产的正确姿势是走 TLS，让公钥交换发生在已经验证过的加密通道里：

```java
String url = "jdbc:mysql://db.internal:3306/bookshop"
        + "?sslMode=VERIFY_IDENTITY"
        + "&serverTimezone=Asia/Shanghai"
        + "&characterEncoding=UTF-8";
```

`VERIFY_IDENTITY` 会校验证书链和主机名，比 `REQUIRED` 更严格，也更适合内网之外的环境。这种情况下不需要 `allowPublicKeyRetrieval`，因为完整认证可以直接在 TLS 通道里完成。

账号这边，我把 dump 里所有 `IDENTIFIED WITH mysql_native_password` 都改成了默认写法，并在导入后重新执行一次 `ALTER USER`，确保旧哈希没有残留。9.7 只认真实支持的新插件，留着旧哈希的账号在迁移后大概率直接登不进去。

## 四、版本差异整理成一张表

这次迁移踩的坑，本质是三个版本对同一个插件的处理方式不同。整理出来，以后再遇到"升级数据库后连不上"，可以直接对号入座：

| 版本 | 默认认证插件 | mysql_native_password | 老 JDBC 驱动的表现 | 处理方式 |
|---|---|---|---|---|
| 8.0.x | caching_sha2_password | 内置可用，但已弃用 | 可连旧账号，连新账号报 Unable to load authentication plugin | 升级驱动，或暂时保留旧插件 |
| 8.4 LTS | caching_sha2_password | 默认禁用，可用参数启用 | 同上 | 升驱动；临时场景才考虑启用旧插件 |
| 9.7 LTS | caching_sha2_password | 已移除，无法启用 | 任何不支持新插件的客户端都连不上 | 必须升驱动与客户端，并改写 dump 里的建用户语句 |

还有两处容易漏：

- **dump 文件是跨版本的**。备份里保存的不是"当前服务器状态"，而是当年写下的语句。跨大版本恢复时，建用户、授权这类语句要单独审一遍，不能指望导入工具自动翻译。
- **图形客户端也会中招**。老版本 Navicat、SQLyog 这类工具同样内置了固定的插件名单，服务端一换就可能报 2058 或公钥相关的错。它们不是坏了，只是同样需要升级。

## 五、验证不只看"能启动"

改完驱动和连接串，我没有只看项目启动成功就收工，而是按下面几项逐条验证：

1. `SHOW PLUGINS` 输出里确认没有 `mysql_native_password`，证明服务端确实是 9.7 的行为；
2. `SELECT user, host, plugin FROM mysql.user WHERE user='bookshop'`，确认账号插件为 `caching_sha2_password`；
3. 依赖树里只剩一个 MySQL 驱动，且版本满足要求；
4. 跑一遍 BookShop 的登录、下单、订单查询三条链路，确认不是只有健康检查能过；
5. 重启一次数据库，再连一次。第一次连接走完整认证，之后走 fast auth 缓存，这两个阶段的行为不一样，只测其中一种容易漏问题。

第 5 条是这次新加的。`caching_sha2_password` 的完整认证要交换公钥或走 TLS，而 fast auth 只是查服务端缓存。刚重启时缓存是空的，配置里少一个参数就会在这时候暴露；等缓存热了再测，反而看不出来。

## 六、小结

这次事故没有一行业务代码的问题，全是环境迁移带出来的。我现在会把"升级数据库大版本"当成一次需要单独验证的变更：先读清楚这个版本删了什么，再检查 dump 里有没有被删对象的引用，最后确认客户端和驱动是不是跟得上。

真正的分水岭不是 9.7 本身，而是 8.0 结束支持这个时间点。旧插件在 8.0 上还能用，所以问题被藏了很多年；一旦服务端删掉它，老的账号、老的 dump、老的驱动会同时出问题。与其等到那天手忙脚乱，不如趁项目还小的时候把驱动升上去，把 `IDENTIFIED WITH mysql_native_password` 从脚本和文档里清掉。

> 个人博客：https://www.sakura.work.gd/ ｜ GitHub：https://github.com/sakurajh

