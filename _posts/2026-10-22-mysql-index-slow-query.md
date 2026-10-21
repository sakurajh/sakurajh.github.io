---
layout: post
title: "MySQL 索引为什么会让查询变慢：最左前缀、回表与选择性"
date: 2026-10-22 06:02:00 +0800
categories: 学习笔记
tags: MySQL 索引 B+树 最左前缀 回表
description: "订单列表加了索引却没变快，写入反而更慢。这篇从 InnoDB 的 B+ 树讲起，把最左前缀、回表和索引选择性串起来，解释索引何时帮倒忙，并给出能直接照着改的 SQL 与 EXPLAIN 检查方法。"
---

上周我在给课程项目的 BookShop 补后台订单页。测试库只有几十条订单时，列表接口一点就开；把订单表灌到几万条之后，同样一页要等好几秒。我的第一反应很直接：`status` 字段没索引，加上就行。结果查询没有明显变快，反倒是下单接口开始变慢。那天晚上我对着 `EXPLAIN` 把索引重新学了一遍，才发现问题不在"有没有索引"，而在索引长什么样、查询能不能顺着它走。

## 一、InnoDB 的索引是一棵排好序的树

MySQL 的 InnoDB 用 B+ 树组织索引。可以把每个索引理解成一份独立的、按索引列排好序的目录：非叶子节点只放用来比较的键，叶子节点放键和指向数据的指针，叶子之间再用链表串起来，所以范围查询可以顺着链表扫。

InnoDB 有两类索引。主键索引也叫聚簇索引，叶子节点直接存整行数据；二级索引也就是我们平时说的普通索引，叶子节点存的是"索引列的值 + 主键值"。这个设计带来两个直接后果：

- 一张表的数据物理上按主键顺序组织，所以主键要尽量短、尽量递增；
- 通过二级索引查到主键之后，如果还要取其他列，就得拿主键再回聚簇索引查一次，这就是"回表"。

B+ 树为什么适合做索引？因为它的每个节点能放很多键，树的层数很低，查一条记录只需要几次磁盘页读取；而且叶子有序，范围查询和排序都有便宜可占。理解这一点，后面的"最左前缀"和"回表"就不是背诵条目，而是这棵树自然长出来的性质。

## 二、联合索引的顺序就是排序的顺序

我给订单表建的联合索引是这样的：

```sql
CREATE TABLE `orders` (
  `id`         BIGINT        NOT NULL AUTO_INCREMENT,
  `user_id`    BIGINT        NOT NULL,
  `status`     TINYINT       NOT NULL COMMENT '0待付款 1已付款 2已发货 3已完成',
  `amount`     DECIMAL(10,2) NOT NULL,
  `created_at` DATETIME      NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_user_status_time` (`user_id`, `status`, `created_at`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

`idx_user_status_time` 的排序规则是：先按 `user_id` 排，`user_id` 相同的再按 `status` 排，前两列都相同的再按 `created_at` 排。这就像电话簿先按姓排、同姓再按名排。你只知道名字、不知道姓，是没法在电话簿里直接定位的，只能一页页翻。这就是最左前缀原则的由来，不是 MySQL 额外加的规矩。

所以对这条索引：

- `WHERE user_id = 42` 能用，命中第一列；
- `WHERE user_id = 42 AND status = 1` 能用，连续命中前两列；
- `WHERE status = 1` 用不上，因为跳过了第一列；
- `WHERE user_id = 42 AND created_at > '2026-10-01'` 只能用 `user_id` 定位，`created_at` 无法在索引里继续缩小范围，因为中间的 `status` 缺失。

MySQL 8.0 确实有索引跳跃扫描（skip scan），在首列取值很少时能绕过最左列，但它是优化器的补救手段，不是可以依赖的设计。写 SQL 时仍然应该按"等值条件在前、范围条件在后"去安排联合索引的列顺序。

## 三、回表：二级索引的固定成本

订单列表页要显示金额，于是查询通常是这样的：

```sql
-- 查询 A：只取索引里有的列
SELECT id, user_id, status, created_at
FROM orders
WHERE user_id = 42 AND status = 1
ORDER BY created_at DESC
LIMIT 20;

-- 查询 B：还要取 amount
SELECT id, user_id, status, created_at, amount
FROM orders
WHERE user_id = 42 AND status = 1
ORDER BY created_at DESC
LIMIT 20;
```

查询 A 需要的列全在 `idx_user_status_time` 里，扫描索引就能拿到结果，`EXPLAIN` 的 `Extra` 会显示 `Using index`，这叫覆盖索引，完全不用回表。查询 B 多了 `amount`，而 `amount` 不在索引里，每找到一条候选记录都要拿主键回聚簇索引取整行。

回表本身不是问题，问题是回表的次数。如果 `user_id = 42` 名下有几千条订单，`status = 1` 又过滤不掉多少，MySQL 可能先按索引把几千条主键都找出来，再一条条回表、排序、取前 20 条。此时"用索引"反而比直接顺序扫全表更贵，优化器就会放弃索引。我当初加 `idx_status` 没效果，原因也在这里：`status` 只有几个取值，用它定位等于扫掉一大片数据，再叠加大量回表，成本并不低。

覆盖索引能消除回表，但代价是索引变宽。把 `amount` 也塞进联合索引，列表查询确实能变成覆盖索引，可每一行索引都多存一个 `DECIMAL`，写入和维护成本都会上升。这笔账要按真实查询频率来算，不能为了一个偶尔跑一次的报表把索引撑得很大。

## 四、选择性：优化器也在算账

选择性等于不重复的值数量除以总行数。`status` 只有 0 到 3 四个值，选择性极低；`user_id` 有大量不同用户，选择性高；主键和唯一键的选择性是 1。优化器会根据统计信息估算"走索引要读多少行、回表多少次"，再和全表扫描比成本。选择性低的列建索引，通常只在覆盖索引、并且只查少量列的场景下才有意义。

这也解释了我遇到的另一个现象：索引建多了，下单反而慢。每次 `INSERT` 都要往聚簇索引和每一个二级索引里各插一条记录，索引越多，写放大越明显；更新被索引的列还会引起页分裂和额外的日志写入。索引是用写换读的工具，不是免费的加速器。

可以通过下面这条 SQL 看索引的基数，判断值分布：

```sql
SHOW INDEX FROM orders;
-- 关注 Cardinality 列：它只是采样估算值，不是精确去重数

SELECT COUNT(DISTINCT status) AS status_kinds,
       COUNT(DISTINCT user_id) AS user_kinds,
       COUNT(*) AS total
FROM orders;
```

`Cardinality` 是采样估算，表数据变化很大时会失真，必要时用 `ANALYZE TABLE orders;` 让 InnoDB 重新统计。统计信息不准时，优化器可能选错索引，表现就是同一个查询昨天还快、今天突然变慢。

## 五、这些写法会让索引白建

下面这张表是我这轮排查里整理出来的，基本覆盖了订单查询中遇到的写法：

| SQL 写法 | 是否能用上 idx_user_status_time | 原因 |
|---|---|---|
| `WHERE user_id = 42` | 能 | 命中联合索引第一列 |
| `WHERE user_id = 42 AND status = 1` | 能 | 连续命中前两列 |
| `WHERE status = 1` | 不能 | 跳过最左列 `user_id` |
| `WHERE user_id = 42 AND created_at > '2026-10-01'` | 部分 | 只能定位 `user_id`，`created_at` 不能继续缩范围 |
| `WHERE user_id = 42 ORDER BY created_at DESC` | 部分 | `status` 未定，索引顺序不能直接满足排序 |
| `WHERE DATE(created_at) = '2026-10-22'` | 不能 | 函数包住索引列，无法按原值比较 |
| `WHERE phone = 13800000000`（`phone` 是 VARCHAR） | 不能 | 隐式类型转换发生在列上，索引失效 |
| `WHERE user_id = 42 OR status = 1` | 通常不能 | 两个条件分属不同索引，可能退化为全表扫描 |

几个容易忽略的点：

- `DATE(created_at) = '2026-10-22'` 应改写成范围：`created_at >= '2026-10-22 00:00:00' AND created_at < '2026-10-23 00:00:00'`。让列保持"裸"的，函数只作用在常量一侧。
- `VARCHAR` 列和数字比较时，MySQL 会把列转成数字再比，转换后的值不再对应索引里的顺序。反过来，`BIGINT` 列和字符串常量比较时通常是把常量转成数字，索引仍可用，但不要依赖这种细节，类型对齐最稳。
- `LIKE '关键字%'` 能用索引，`LIKE '%关键字'` 不能；`OR` 两边若都能走同一个索引，可能走索引合并，否则容易全表扫描。
- 排序方向也影响索引利用。联合索引里前序列是等值条件时，后序列的 `ASC` 或 `DESC` 才能顺着索引顺序读；中间列是范围条件，后面的列就排不上序了。

## 六、我最后的改法与检查方式

我把 `idx_status` 删了，因为它选择性低，又和真实查询不匹配；保留了 `(user_id, status, created_at)`，并让列表页只查索引里已有的列，确实需要 `amount` 时再单独优化。所有查询上线前先用 `EXPLAIN` 看一眼：

```sql
EXPLAIN ANALYZE
SELECT id, user_id, status, created_at, amount
FROM orders
WHERE user_id = 42 AND status = 1
ORDER BY created_at DESC
LIMIT 20;
```

看执行计划时我主要看四个地方：`type` 是不是从 `ALL` 变成了 `ref` 或 `range`；`key` 是不是预期的索引；`rows` 的估算量级是否合理；`Extra` 里有没有 `Using index`、`Using filesort`、`Using temporary`。`EXPLAIN ANALYZE` 从 MySQL 8.0.18 起支持，会给出实际执行时间和实际行数，比单纯的 `EXPLAIN` 更接近真相，但要注意它真的会执行查询，别在写库上随便跑。

深分页是另一个坑。`LIMIT 100000, 20` 并不是只读 20 行，前面的 100000 行也要在索引里数过去，还要回表，越翻越慢。我最终把后台列表改成了基于游标的分页：

```sql
SELECT id, user_id, status, created_at, amount
FROM orders
WHERE user_id = 42
  AND status = 1
  AND created_at < '2026-10-01 12:00:00'
ORDER BY created_at DESC
LIMIT 20;
```

上一页最后一条的 `created_at` 作为下一页的起点，查询始终从索引的某个位置开始顺序读 20 条，代价和翻到第几页无关。前提是排序键要唯一，或者像 `(created_at, id)` 这样组合起来唯一，否则时间相同的记录可能漏掉或重复。如果暂时不能改接口，至少可以用延迟关联，先只查主键再回表：

```sql
SELECT o.*
FROM orders o
JOIN (
  SELECT id
  FROM orders
  WHERE user_id = 42 AND status = 1
  ORDER BY created_at DESC
  LIMIT 100000, 20
) t ON o.id = t.id;
```

子查询仍然要数过前面那些索引项，但省掉了被跳过行的回表，深页码下差别会很明显。

## 小结

这轮排查让我把索引这件事重新排了序：先看 B+ 树的排序规则，再判断查询能不能顺着树走；能走之后，再算回表次数和选择性划不划算；最后还要把写入成本算进去。索引不是"给字段加上就快"的开关，它是一份要维护的有序副本。联合索引的列顺序按真实查询的等值、范围、排序来排，列表页尽量做成覆盖索引，低选择性的列不要单独建索引，上线前用 `EXPLAIN` 确认执行计划。想清楚这几件事，比盲目加十个索引有用得多。

