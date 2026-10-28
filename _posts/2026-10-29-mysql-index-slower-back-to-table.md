---
layout: post
title: "MySQL 给订单表加了索引反而更慢：回表、选择性与最左前缀"
date: 2026-10-29 06:01:00 +0800
categories: 学习笔记
tags: MySQL 索引优化 EXPLAIN InnoDB 回表
description: "后台订单列表翻到后面几页明显变卡，我给 create_time 加了索引，结果更慢。这篇用 EXPLAIN 一步步拆开：二级索引为什么要回表、选择性低的列为什么会被优化器放弃、联合索引的顺序为什么决定成败，以及索引本身的写入代价。"
---

做 BookShop 课程设计的时候，后台有个订单列表页，条件是两个：按状态筛选、按时间倒序分页。前期数据少，怎么写都不卡；等订单表慢慢涨起来，翻到第二三十页就开始转圈。我第一反应很朴素——`create_time` 上没有索引，加一个不就完了。

加完索引，第一页确实快了。但翻到中后段反而比之前更卡，而且页码越大越明显。这件事让我第一次认真去看执行计划，也第一次意识到：索引不是"加了就快"的开关，它只是给了优化器一个新的选项，而这个选项有时候比全表扫更差。

## 一、先看执行计划，别对着 SQL 猜

我当时的 SQL 大概是这个样子：

```sql
SELECT id, order_no, user_id, total_amount, status, create_time
FROM order_info
WHERE status = 1
  AND create_time >= '2026-09-01'
ORDER BY create_time DESC
LIMIT 40 OFFSET 800;
```

问题在于这条语句有三个诉求同时存在：一个等值过滤（`status = 1`）、一个范围过滤（`create_time >= ...`）、一个排序（`ORDER BY create_time DESC`）。而我加的索引只有 `create_time` 一列。

用 `EXPLAIN` 看一眼就清楚了。MySQL 8 里我习惯用 `EXPLAIN ANALYZE`，它会把估算行数和实际行数一起打出来：

```sql
EXPLAIN ANALYZE
SELECT id, order_no, total_amount
FROM order_info
WHERE status = 1 AND create_time >= '2026-09-01'
ORDER BY create_time DESC
LIMIT 40 OFFSET 800;
```

几个字段要会读，其余的可以慢慢补：

| 字段 | 看什么 |
|---|---|
| `type` | 访问方式，`ALL` 是全表扫，`range` 是索引范围扫，`ref` 是等值匹配 |
| `key` | 实际用了哪个索引，为空说明没用索引 |
| `rows` | 优化器估算要扫多少行，注意是估算 |
| `filtered` | 扫出来的行里有多少能通过剩余条件 |
| `Extra` | `Using index` 是覆盖索引，`Using filesort` 是额外排序，`Using index condition` 是索引条件下推 |

我那次的结果是 `type=range`、`key=idx_create_time`，但 `rows` 很大，`Extra` 里是 `Using where`。翻译一下：它确实走了我加的索引，沿着索引从新到旧扫，然后每扫到一条就回主键索引取整行，取回来再判断 `status` 是不是 1。扫描量一点没少，反而多了一层回表。

## 二、回表：二级索引里没有你要的列

InnoDB 的表是按主键组织的聚簇索引，叶子节点存的是完整行数据。二级索引（我们自己建的那些普通索引）的叶子节点只存两样东西：索引列的值，加上主键值。

所以走 `idx_create_time` 查 `order_no`、`total_amount` 这些列，必须拿主键再去聚簇索引里捞一次，这就是回表。回表的代价不在次数本身，而在**它是随机 IO**：索引按时间顺序扫，主键却可能是乱序的，每一条都可能落在不同的数据页上。

而全表扫虽然是顺序读，但读的是连续的页，还能被预读机制批量拉进 Buffer Pool。数据量大、过滤条件又筛不掉多少行的时候，"顺序全表扫"完全可能比"索引扫 + 大量随机回表"更快。这就是我遇到的情况。

想少回表，思路是让查询需要的列都在索引里，也就是覆盖索引。既然过滤条件有 `status`，排序有 `create_time`，那就把它们放进同一个联合索引：

```sql
ALTER TABLE order_info
  ADD INDEX idx_status_create (status, create_time);

-- 只取索引里已有的列，Extra 会出现 Using index
SELECT id, status, create_time
FROM order_info
WHERE status = 1 AND create_time >= '2026-09-01'
ORDER BY create_time DESC
LIMIT 40;
```

这里 `id` 也在索引里，因为二级索引叶子节点天然带主键，所以这个查询不需要回表。如果业务确实要 `total_amount`，那就把它也加进索引；但索引列越多，索引越大，写入越贵，这是后面要算的账。

## 三、选择性：优化器也会主动放弃索引

还有一种"加了索引却没用上"的情况更隐蔽：索引存在，`possible_keys` 里也有它，但 `key` 是空的。这不是 MySQL 出错，是它算过账，觉得不值。

优化器判断的依据是**选择性**，也就是"这个列能把数据筛到多细"。给 `status` 这种只有几个取值的列单独建索引，基本没有意义：如果九成订单都是已完成状态，走索引扫出来的行数接近全表，却还要逐条回表，不如直接顺序扫。

这个判断依赖统计信息里的基数（Cardinality），可以用 `SHOW INDEX FROM order_info` 看。它是采样估算出来的，不是精确值；大批量导入数据之后往往还没来得及更新，估算就会严重失真，优化器可能因此选错索引。

```sql
-- 大批量导入或删除数据后，刷新统计信息
ANALYZE TABLE order_info;

-- 确认基数是否合理
SHOW INDEX FROM order_info;
```

我吃过一次这个亏：批量灌了几万条测试订单之后，查询突然从走索引变成全表扫。当时以为是索引坏了，其实是统计信息还停留在"表里只有几百行"的状态。`ANALYZE TABLE` 之后执行计划立刻恢复正常。

所以要记住一点：**低选择性的列不适合单独建索引**，它更适合作为联合索引的前缀，用来缩小范围，而不是单独承担过滤。

## 四、联合索引的顺序决定它能干什么

联合索引 `(a, b)` 不是一个"包含 a 和 b 的索引"，它是一棵按 a 排序、a 相同再按 b 排序的树。这决定了它能支持哪些查询：

| 查询条件 | `(status, create_time)` | `(create_time, status)` |
|---|---|---|
| `status = 1 AND create_time > ?` | 能用，且排序可复用索引 | 只能用 `create_time` 范围 |
| 只有 `create_time > ?` | 用不上 | 能用 |
| 只有 `status = 1` | 能用（最左前缀） | 用不上 |
| `status = 1 ORDER BY create_time` | 排序免费 | 需要额外排序 |

关键在"范围条件会截断后面的列"。在 `(status, create_time)` 里，`status` 是等值，定位到一段连续区间后，区间内部本来就是按 `create_time` 有序的，所以范围过滤和 `ORDER BY` 都能顺着索引走，`Extra` 里不会出现 `Using filesort`。

反过来，如果把范围列放在前面，`create_time > ?` 之后的那一段在索引里对 `status` 是无序的，后面的列就只能当作过滤条件逐条判断，排序也用不上索引。

这也是我最终选 `(status, create_time)` 而不是反过来的原因：等值列在前，范围列和排序列在后。

## 五、函数和隐式转换会让索引直接失效

有两类写法非常常见，而且一旦出现，索引基本等于白建。

第一类是在索引列上套函数。比如按天统计时写成 `WHERE DATE(create_time) = '2026-10-01'`，MySQL 必须对每一行先算 `DATE()` 才能比较，索引上的有序性用不上。改成范围查询就能走索引：

```sql
-- 不要这样：索引列被函数包住
SELECT COUNT(*) FROM order_info WHERE DATE(create_time) = '2026-10-01';

-- 改成左闭右开区间
SELECT COUNT(*) FROM order_info
WHERE create_time >= '2026-10-01'
  AND create_time <  '2026-10-02';
```

第二类是隐式类型转换。如果 `order_no` 是 `VARCHAR`，却写成 `WHERE order_no = 20261029001`，MySQL 会把列的值转成数字再比较，等于在列上套了一层转换函数，索引失效。反过来，`INT` 列和字符串比较时是把字符串转成数字，索引还能用。所以规则是：**参数类型和列类型保持一致**，不要指望数据库帮你兜。

顺带说一句，深分页本身也是这类问题的重灾区。`LIMIT 40 OFFSET 800` 的意思是"扫描 840 行，扔掉前 800 行"，页码越大扫得越多。用游标分页可以绕开：

```sql
-- 记住上一页最后一条的 create_time，下一页从它之后开始
SELECT id, order_no, total_amount
FROM order_info
WHERE status = 1 AND create_time < '2026-10-20 12:00:00'
ORDER BY create_time DESC
LIMIT 40;
```

## 六、小结：先算账，再建索引

最后要说清楚代价，否则很容易走向"到处加索引"的另一个极端。

每个二级索引都是一棵独立的 B+ 树。插入一行要维护所有相关索引；更新被索引的列，可能要删除再插入索引项；索引本身也占磁盘、占 Buffer Pool，挤占本该缓存数据页的内存。索引越多，写入越慢，这一点在批量导入时非常明显。

所以我的判断顺序是：先看这条查询跑得多不多，再决定要不要为它建索引；建之前先确认它真的走索引（看 `key`），建之后再看扫描行数有没有下降（看 `rows` 和 `filtered`）。如果优化器偶尔选错，`USE INDEX` 可以作为临时兜底，但它只是绕过统计信息，不解决根本问题——真正该做的是让统计信息保持新鲜、让索引顺序贴合查询。

回过头看，我第一次加索引的错误不在技术细节，而在思路上：把索引当成"加速按钮"，而不是"给优化器多一个选项，并为此付出写入代价"。

现在再遇到慢查询，我会按这个顺序走一遍，而不是先 `ALTER TABLE`：

1. 用 `EXPLAIN` 确认是 `type=ALL` 还是走了索引，先分清"没索引"和"索引用错"；
2. 看 `rows × filtered` 估算的扫描量，判断是扫得太多还是回表太重；
3. 把等值过滤列放最前、范围列和排序列放后面，考虑能不能做成覆盖索引；
4. 检查 SQL 里有没有在索引列上套函数、类型不一致的情况；
5. 新建索引后用 `EXPLAIN ANALYZE` 对比实际行数，数据变动大时记得 `ANALYZE TABLE`。

想清楚这条查询的过滤列、排序列、返回列分别是什么，再决定索引怎么排，基本就不会出现"加了反而更慢"这种事。

