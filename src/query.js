// 只读查询接口：对事件日志做确定性重放后输出某个儿童/某季的状态解释或角色视图。
//   node src/query.js --schema ... --events a.jsonl b.jsonl \
//     --child child-001 --season 2026 [--role GUARDIAN|SCHOOL|CDC] [--as-of <ts>]
//
// 并发补录期间调用结果可能随后续事件变化，但对同一份事件日志永远一致；
// 输出中 policy 段说明采用了哪版规则，valid_facts/retained_facts 说明依据哪些事实。

import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import { foldEvents } from "./domain/fold.js";
import { loadEvents } from "./io.js";
import { computeChildStatus, schoolBucket } from "./domain/status.js";
import { guardianProof } from "./domain/projections.js";

const { values } = parseArgs({
  options: {
    schema: { type: "string" },
    events: { type: "string" },
    child: { type: "string" },
    season: { type: "string" },
    role: { type: "string", default: "GUARDIAN" },
    "as-of": { type: "string" },
  },
});

if (!values.schema || !values.events || !values.child || !values.season) {
  console.error("用法: query.js --schema <schema.json> --events <a.jsonl,b.jsonl> --child <id> --season <2026> [--role GUARDIAN|SCHOOL|CDC] [--as-of <ts>]");
  process.exitCode = 2;
} else {
  const asOf = values["as-of"] ?? new Date().toISOString();
  const schema = JSON.parse(await readFile(values.schema, "utf8"));
  const eventFiles = values.events.split(",").map((f) => f.trim()).filter(Boolean);
  const { events, errors } = await loadEvents(schema, eventFiles);
  if (errors.length > 0) {
    for (const e of errors) console.log(`${e.file}:${e.line}	${e.field}	${e.code}	${e.message}`);
    process.exitCode = 1;
  } else {
    const state = foldEvents(events);
    if (values.role === "SCHOOL") {
      const status = computeChildStatus(state, values.child, values.season, asOf);
      console.log(JSON.stringify({ child_record_id: status.child_record_id, season_id: values.season, result: schoolBucket(status.status), as_of: asOf }, null, 2));
    } else if (values.role === "GUARDIAN") {
      console.log(JSON.stringify(guardianProof(state, values.child, values.season, asOf), null, 2));
    } else {
      const status = computeChildStatus(state, values.child, values.season, asOf);
      console.log(JSON.stringify(status, null, 2));
    }
  }
}
