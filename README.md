# 儿童流感季剂次账

以指南版本、流行季、年龄、既往剂次、疫苗品种批号、知情同意、暂缓与实际接种事实，计算每名儿童在本流感季的当前状态与保护时间窗。为家长纸质记录、社区补录、异地接种回执的乱序/重复回传提供确定性对账，并向监护人、学校、疾控给出权限不同的视图。

## 它保证什么

- “建议十月底前完成”只产生迟到标记，**不会被写成过期后禁止接种**；季末才关账。
- 业务键（儿童|流行季|剂位）相同但批号/时间/执行人不同的回传**进入核对**，不自动并剂；内容完全一致的重复回传安全去重。
- 跨地区记录经**授权匹配**后才合并，从不使用姓名去重。
- 批次停用只影响尚未执行的计划并找出真实受种者；**已完成的接种事实不可删除**。
- 医学禁忌与普通暂缓/迟到分状态处置；临时暂缓到期或清除后恢复接种。
- 家长撤回额外数据用途后仍能取得剂次证明，但 `extra` 字段从所有投影剥离。
- 学校只见 **完成 / 暂缓 / 需核验**，看不到诊断、批号与时间窗。
- 跨年流感季、指南改版、并发补录、进程恢复下，同一份事件日志永远得到同一结果（见 `manifest.json` 摘要）。
- 每个结论都注明采用了哪版 `guideline_version` 与哪些有效接种事实。

## 目录

- `contracts/domain.schema.json`：事件信封、枚举、时间/日期与事件专属载荷契约。
- `data/events.jsonl`：覆盖乱序、重复、跨地区合并、核对、批次停用、暂缓、同意撤回的中文联调样例。
- `src/contracts.js`：契约校验。
- `src/io.js`：事件日志读取（逐行报错）。
- `src/domain/time.js`：日历日、月龄、间隔、保护窗工具。
- `src/domain/fold.js`：确定性事件折叠。
- `src/domain/status.js`：状态计算与可解释依据。
- `src/domain/projections.js`：监护人/学校/疾控投影与批次影响。
- `src/day-end.js`：确定性日终命令（原子输出、清单摘要、可重放恢复）。
- `src/query.js`：只读状态查询。
- `tests/`：契约、领域与日终集成测试。
- `docs/domain.md`：领域对象、状态机与核对/隐私语义。

## 测试

```bash
npm test
```

## 编译检查

```bash
npm run build
```

## 样例契约校验

```bash
npm run check:sample
```

成功输出 `valid`；失败逐行输出字段、代码和中文说明，并以非零状态结束。

## 日终账

```bash
npm run day-end
# 或
node src/day-end.js --schema contracts/domain.schema.json \
  --events data/events.jsonl --season 2026 \
  --as-of 2026-10-31T12:00:00+08:00 --out-dir out/
```

`--events` 接受逗号分隔的多个 JSONL（分片/多机构回传）；重复运行或分片乱序输入，产物 sha256 集合保持一致。输出：

- `manifest.json`：输入指纹、各产物 sha256、排序说明与自身摘要。
- `school-roster.json`：学校三桶花名册。
- `cdc-roster.json`、`reconciliation-queue.json`、`batch-impact.json`、`proof-audit.json`、`system-notices.json`。
- `proofs/<儿童记录>.proof.json`：每名儿童的监护人证明。

## 单童查询

```bash
node src/query.js --schema contracts/domain.schema.json --events data/events.jsonl \
  --child child-zhao --season 2026 --role GUARDIAN \
  --as-of 2026-10-31T12:00:00+08:00
```

`--role` 为 `GUARDIAN`（默认，完整证明）、`SCHOOL`（三桶）或 `CDC`（完整状态）。
