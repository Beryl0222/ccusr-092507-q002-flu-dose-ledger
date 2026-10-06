# 领域约定

记录儿童流感季剂次、规则版本和批次状态，为跨机构交换提供稳定的接种事实信封。所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。

## 聚合与事件

聚合对象：`season_policy`、`child_record`、`dose_event`、`dose_plan`、`batch_notice`。

| 事件 | 聚合 | 语义 | 额外必填载荷 |
| --- | --- | --- | --- |
| `CHILD_REGISTERED` | child_record | 儿童建档 | `birth_date`, `home_region` |
| `POLICY_PUBLISHED` | season_policy | 发布某流行季的指南版本与日程参数 | `guideline_version`, `season_start`, `season_end`, `advisory_complete_by` |
| `CONSENT_RECORDED` | child_record | 知情同意或数据用途授权（`scope`: `vaccination` / `data_sharing`） | `scope`, `granted` |
| `DEFERRAL_RECORDED` | child_record | 暂缓登记，同一流行季后到覆盖先到 | `season_id`, `reason_kind`（`medical_contraindication` / `ordinary`） |
| `DOSE_RECORDED` | dose_event | 实际接种事实 | `child_ref`, `season_id`, `dose_seq`, `administered_at`, `lot_no`, `origin`, `executor_id` |
| `RECORD_MATCHED` | child_record | 异地记录经授权后并入本地档案 | `external_ref`, `source_region`, `match_auth_id` |
| `DOSE_RECONCILED` | child_record | 冲突核对结论：保留哪条事实 | `season_id`, `dose_seq`, `kept_event_id` |
| `PLAN_CREATED` | dose_plan | 尚未执行的接种计划 | `child_id`, `season_id`, `lot_no`, `planned_for` |
| `BATCH_SUSPENDED` | batch_notice | 批次停用 | `lot_no`, `effective_at` |
| `PROOF_ISSUED` | child_record | 出具证明的事实记录（只读动作，不改状态） | `viewer_role`, `record_version` |

政策参数缺省值：9 岁及以上 1 剂；既往累计满 2 剂者本季 1 剂，否则 2 剂；两剂间隔 28 天；接种后 14 天形成保护，保护期 240 天。政策事件可用同名字段覆盖。

## 归并与核对

- 事件按（发生时刻，事件标识）排序归并，离线回传乱序不影响结果；同一 `event_id` 相同内容重复送达直接跳过，不同内容记入 `issues` 待人工处理。
- 剂次业务键为（儿童，流行季，剂次序号）。键相同但批号、接种时间、执行人或品种不同 → 冲突，相关事实全部排除出计数，状态进入“需核验”，由 `DOSE_RECONCILED` 指定保留事实后解除；被排除的事实标记 `superseded`，永不删除。
- 异地记录（`origin: external`）必须存在携带授权编号的 `RECORD_MATCHED` 才能并入本地档案；不做姓名或标识符字面去重，未授权的记录留在隔离区（`quarantined_external`）。
- 知情同意是剂次有效的条件：存在 `vaccination` 同意或事实自带 `consent_ref`，否则该剂次不计入并触发“需核验”。

## 状态语义

每名儿童在每个流行季的状态为以下之一：

- `completed`（完成）：有效剂次达到指南要求，给出保护时间窗（末剂 +14 天起，持续 240 天）。
- `deferred`（暂缓）：存在未过期的暂缓登记。`medical_contraindication` 暂停催种、需医学评估清除；`ordinary` 普通迟到继续催种、流行季内仍可接种。
- `in_progress`（待接种）：给出剩余剂次与下一剂最早日期。`advisory_complete_by` 仅为建议，逾期 `advisory_passed=true` 但 `can_vaccinate` 仍为真，绝不解释为禁止接种。
- `needs_review`（需核验）：存在未决冲突、缺知情同意、缺政策或缺出生日期。

每份状态都带 `explanation`：采用的指南版本与政策事件、年龄、既往剂次、计入的事实标识、被排除的事实及原因。

## 批次停用

`BATCH_SUSPENDED` 只影响尚未执行的计划（`affected_pending_plans`）；已执行事实的真实使用者列入 `recipients` 供随访，事实本身保留且状态不变。

## 视图与同意

- 学校只看到 `完成 / 暂缓 / 需核验` 三种结论（待接种在学校侧归入“需核验”跟进口径），不暴露暂缓原因、批号等细节。
- 家长撤回 `data_sharing` 后，本人取证（`parent`）与学校、疾控的基本目的视图不受影响；额外用途角色（如 `research`）拒绝出具。

## 确定性日终

`runDayEnd(events, asOf)` 是纯函数：相同事件集合在任意到达顺序、任意重复送达、并发补录与进程重启重放下得到相同快照与 `digest`。`log_digest` 只对去重后接受的事件计算，对重复送达免疫。跨年流行季各自独立计算，既往剂次按季初日期跨季累计；指南改版以最新 `POLICY_PUBLISHED` 为准并写入解释。
