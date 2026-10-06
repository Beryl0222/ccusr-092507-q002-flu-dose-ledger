# 领域约定

儿童流感季剂次账回答一个问题：**在某个流行季、某版接种策略下，某名儿童当前到底完成了哪一剂，下一步该做什么，依据的是哪版规则与哪些接种事实。**

所有时间必须携带时区；日历判断统一使用 `Asia/Shanghai` 日历日。版本号从 1 开始递增。校验层不替调用方改写输入。

## 分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| 交换契约 | `contracts/domain.schema.json`、`src/contracts.js` | 事件信封、枚举、时间/日期/必填载荷校验 |
| 事件日志 | `src/io.js` | JSONL 读取，逐行报错，绝不静默丢弃 |
| 确定性折叠 | `src/domain/fold.js` | 乱序/重复/跨机构事件 → 不可变事实台账 |
| 状态计算 | `src/domain/status.js` | 策略选择、剂次核对、禁忌/迟到、保护窗、解释 |
| 角色投影 | `src/domain/projections.js` | 监护人证明、学校三桶、疾控运营、批次影响 |
| 命令/查询 | `src/day-end.js`、`src/query.js` | 确定性日终、只读查询 |

## 聚合与事件

- 聚合：`season_policy`、`child_record`、`dose_event`、`dose_plan`、`batch_notice`。
- 事件：`POLICY_PUBLISHED`、`CHILD_REGISTERED`、`DOSE_RECORDED`、`DOSE_REPORTS_RECONCILED`、`RECORD_MATCHED`、`BATCH_SUSPENDED`、`DEFERRAL_RECORDED`、`DEFERRAL_CLEARED`、`CONSENT_UPDATED`、`PLAN_PROPOSED`、`PLAN_CANCELLED`、`PROOF_ISSUED`。

业务键为 `儿童记录 | 流行季 | 剂位`，**不含姓名**。接种回传键为 `地区码 | 机构回单号`。

## 策略与程序

`POLICY_PUBLISHED.payload.rules`：

- `season_start` / `season_end`：流行季边界（季末关账，不是禁种）。
- `age_as_of`：选档年龄基准日；`min_age_months`：起种月龄。
- `recommended_complete_by`：**建议**完成日（如 10-31）。
- `onset_days_after_final_dose`：末剂后形成保护所需天数。
- `min_interval_days_for_second_dose`：两剂最小间隔。
- `schedule[]`：按年龄区间与既往季剂次选档，`dose_count` 为本季应种剂次。

策略版本按查询时刻选择：取 `effective_at <= as_of` 中生效最晚者；并发同刻时取先发布者。**已发布的 `(季, 版本)` 内容不可变**，重发相同内容幂等，内容不同告警并保留先发布者。

## 状态机

`computeChildStatus` 输出的 `status`：

| 状态 | 含义 |
| --- | --- |
| `DUE` | 第 1 剂待接种 |
| `IN_PROGRESS` | 已有计数剂，下一剂待接种 |
| `WAITING_INTERVAL` | 剂次间隔未满，到 `not_before` 后可种 |
| `COMPLETE` | 本季应种剂次全部计数完成，附保护窗 |
| `LATE` 标记 | 不单独成态；晚于建议日时在 `DUE/IN_PROGRESS` 上置 `late=true` |
| `DEFERRED_TEMPORARY` | 临时暂缓（患病/用药等），到期或清除后恢复接种 |
| `DEFERRED_MEDICAL` | 医学禁忌，不予接种 |
| `NOT_YET_ELIGIBLE` | 未满起种月龄，给到龄日 |
| `CLOSED_INCOMPLETE` | 流行季已结束仍未完成，关账 |
| `NOT_APPLICABLE` | 无适用程序行 |
| `NEEDS_VERIFICATION` | 记录冲突/缺登记/缺策略/跨季史存疑，系统无法判定 |

关键区分：

- **“建议十月底前完成”不是禁种令。** 晚于建议日只是 `late=true`，季内仍可接种；只有过了 `season_end` 才 `CLOSED_INCOMPLETE`。
- **医学禁忌 ≠ 普通迟到/暂缓。** 禁忌为 `DEFERRED_MEDICAL`，临时暂缓为 `DEFERRED_TEMPORARY`，后者有 `valid_until`，到期自动失效，也可被 `DEFERRAL_CLEARED` 清除。

## 剂次核对

同一业务键下多份回传：

1. 内容完全相同（同批号/同接种时刻/同执行人/同品种）→ 幂等自动去重，其余留痕不计数。
2. 任一不同 → `NEEDS_VERIFICATION`，进入核对队列，候选 `report_key` 全部列出。
3. `DOSE_REPORTS_RECONCILED`：
   - `CONFIRMED_DUPLICATE`：指定唯一采信报告，其余留痕；
   - `DISTINCT_DOSES`：确认为两次真实接种，按 `assignments` 重派剂位。
   - 采信报告无法唯一确定或指派缺失，仍保持 `NEEDS_VERIFICATION`。

间隔不足的一剂**不计数但事实保留**（`counts=false` + `DOSE_INTERVAL_TOO_SHORT`），需补种。

## 身份合并与隐私

- 跨地区记录只有在 `RECORD_MATCHED`（带 `authorization_id`）后才合并；系统没有、也不使用姓名做匹配键。
- 合并带环路检测；合并后同业务键若出现不同报告，转入人工核对而非自动并剂。
- `CONSENT_UPDATED / EXTRA_DATA_USE granted=false`：撤回的是**额外数据用途**。撤回后监护人仍能取得完整剂次证明，但一切 `extra` 字段从投影剥离；核心接种事实与证明签发不受影响。

## 角色视图

- **GUARDIAN**：完整证明（规则版本、有效事实、留痕事实、保护窗、理由、`proof_digest`）。
- **SCHOOL**：每名儿童仅 `COMPLETED` / `DEFERRED` / `NEEDS_VERIFICATION` 三桶；禁忌、暂缓原因、批号、时间窗一律不可见。明确未完成但记录无问题（含禁忌、迟到、不足龄、等待间隔、季末）归入 `DEFERRED`，只有系统无法判定才 `NEEDS_VERIFICATION`。
- **CDC**：全量运营视图（同样尊重 extra 撤回），含核对队列与批次影响。

## 批次停用

`BATCH_SUSPENDED` 只影响**尚未执行**的计划：

- 已完成的接种事实**不可删除**；停用生效后仍使用该批号接种者，在事实标注 `LOT_SUSPENDED_RECIPIENT` 并列入真实受种者随访，停用前接种者不随访。
- 未来计划进入 `batch-impact.pending_plans`（`CANCEL_OR_RELOT`）；已 `PLAN_CANCELLED` 的进入 `cancelled_plans` 留痕。

## 保护时间窗

`COMPLETE` 时：`starts_on = 末剂接种日 + onset_days_after_final_dose`，`ends_on = season_end`；查询日早于起始日为 `EXPECTED`，否则 `ACTIVE`。

## 确定性与恢复

- 折叠恒按 `occurred_at` 升序、`event_id` 升序处理；文件分片、乱序、重复投递不改变结果。
- 相同 `event_id` 且相同内容是幂等重投，静默无操作；相同 `event_id` 不同内容判为标识碰撞并告警。
- 日终始终从事件日志全量重放（恢复 = 重跑），不依赖按到达顺序物化的中间态；产物先写临时目录，清单落盘后原子替换输出目录。
- 清单 `manifest.json` 含输入文件指纹、每个产物的 sha256、排序说明与自身摘要，供跨进程/跨年核对。
