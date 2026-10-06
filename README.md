# 儿童流感季剂次账

记录儿童流感季剂次、规则版本和批次状态，为跨机构交换提供稳定的接种事实信封，并在契约层之上提供确定性的状态计算与日终快照。

## 目录

- `contracts/domain.schema.json`：事件信封、对象类型和事件载荷约定。
- `data/sample.json`：可直接校验的中文联调样例。
- `data/events.sample.jsonl`：可重放的日终场景样例（建档、同意、剂次、计划、批次停用、异地授权匹配、撤回）。
- `src/`：契约校验、台账归并、状态计算、视图与命令行入口。
- `tests/`：契约边界测试与领域行为测试。
- `docs/domain.md`：领域对象、事件语义、状态口径与确定性约定。

## 测试

```bash
npm test
```

## 编译检查

```bash
npm run build
```

## 样例校验

```bash
npm run check:sample
```

命令成功时输出 `valid`；校验失败时逐行输出字段、代码和中文说明，并以非零状态结束。

## 日终快照

```bash
npm run check:dayend
# 等价于 node src/cli.js dayend data/events.sample.jsonl 2026-11-15
```

输出每名儿童在每个流行季的状态（完成 / 暂缓 / 待接种 / 需核验）、保护时间窗、批次停用处置、异地隔离区与内容摘要 `digest`。同一事件日志任意乱序、重复送达或进程重启重放，得到的 `digest` 相同。
