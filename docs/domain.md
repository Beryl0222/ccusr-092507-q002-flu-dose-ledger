# 领域约定

记录儿童流感季剂次、规则版本和批次状态，为跨机构交换提供稳定的接种事实信封。

聚合对象包括`season_policy`、`child_record`、`dose_event`、`batch_notice`。事件类型包括`POLICY_PUBLISHED`、`DOSE_RECORDED`、`RECORD_MATCHED`、`BATCH_SUSPENDED`、`PROOF_ISSUED`。所有时间都必须携带时区，版本号从 1 开始递增，校验层不会替调用方改写输入。

## 事件载荷

- `DOSE_RECORDED`：还需包含 `season_id`, `lot_no`。
- `BATCH_SUSPENDED`：还需包含 `lot_no`, `effective_at`。
- `PROOF_ISSUED`：还需包含 `viewer_role`, `record_version`。

同一事件标识的幂等与冲突处理属于上层业务服务职责；交换层只负责稳定报告结构、枚举、时间、版本和必需载荷问题。
