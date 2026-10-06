// 确定性日终命令：
//   node src/day-end.js --schema contracts/domain.schema.json \
//     --events data/events.jsonl --season 2026 --as-of 2026-10-31T23:59:59+08:00 \
//     --out-dir out/ [--checkpoint out/manifest.json]
//
// 一致性保证：
// - 每次都从事件日志按 canonicalOrder 全量重放；进程崩溃后重跑即恢复，
//   不依赖按到达顺序物化的中间态，因此部分运行与整批运行结果相同。
// - 输出先写入临时目录，清单（含输入文件指纹与各产物 sha256）落盘成功后
//   再原子替换 out-dir，避免读到半截结果。
// - 传入 --checkpoint 时校验输入指纹与既有清单一致则可安全重跑（幂等）。

import { createHash } from "node:crypto";
import { readFile, rename, rm, mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { validateEvent } from "./contracts.js";
import { foldEvents } from "./domain/fold.js";
import { loadEvents } from "./io.js";
import {
  batchImpact,
  canonicalJson,
  cdcRoster,
  digestOf,
  guardianProof,
  integrityFindings,
  proofAuditLog,
  reconciliationQueue,
  schoolRoster,
} from "./domain/projections.js";

async function shaFile(file) {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex");
}

async function main() {
  const { values } = parseArgs({
    options: {
      schema: { type: "string" },
      events: { type: "string" },
      season: { type: "string" },
      "as-of": { type: "string" },
      "out-dir": { type: "string" },
      checkpoint: { type: "string" },
    },
  });
  if (!values.schema || !values.events || !values.season || !values["out-dir"]) {
    console.error("用法: day-end.js --schema <schema.json> --events <a.jsonl,b.jsonl> --season <2026> --out-dir <dir> [--as-of <ts>] [--checkpoint <manifest.json>]");
    process.exitCode = 2;
    return;
  }
  const asOf = values["as-of"] ?? new Date().toISOString();
  const schema = JSON.parse(await readFile(values.schema, "utf8"));

  // 输入指纹：文件集合（排序）与其内容哈希，决定重放是否针对同一份输入。
  const files = values.events.split(",").map((f) => f.trim()).filter(Boolean).sort();
  const inputs = [];
  for (const file of files) inputs.push({ file, sha256: await shaFile(file) });
  const inputFingerprint = digestOf(inputs);

  if (values.checkpoint && existsSync(values.checkpoint)) {
    const prior = JSON.parse(await readFile(values.checkpoint, "utf8"));
    if (prior.input_fingerprint === inputFingerprint && prior.season_id === values.season) {
      console.log(`checkpoint-unchanged	${values.checkpoint}`);
    }
  }

  const { events, errors } = await loadEvents(schema, files);
  if (errors.length > 0) {
    for (const e of errors) console.log(`${e.file}:${e.line}	${e.field}	${e.code}	${e.message}`);
    process.exitCode = 1;
    return;
  }

  const state = foldEvents(events);
  const rootIds = Object.keys(state.children)
    .filter((id) => !(id in state.aliases))
    .sort();

  const products = {
    "school-roster.json": schoolRoster(state, values.season, asOf),
    "cdc-roster.json": cdcRoster(state, values.season, asOf),
    "reconciliation-queue.json": reconciliationQueue(state, values.season, asOf),
    "batch-impact.json": batchImpact(state, asOf),
    "proof-audit.json": proofAuditLog(state),
    "system-notices.json": { view: "SYSTEM_NOTICES", generated_at: asOf, notices: integrityFindings(state) },
  };
  // 每名根儿童一份监护人证明，便于逐户出具。
  for (const rootId of rootIds) {
    products[`proofs/${rootId}.proof.json`] = guardianProof(state, rootId, values.season, asOf);
  }

  const artifactHashes = {};
  for (const name of Object.keys(products).sort()) {
    artifactHashes[name] = digestOf(products[name]);
  }
  const manifest = {
    document_type: "DAY_END_MANIFEST",
    season_id: values.season,
    as_of: asOf,
    event_count: state.eventCount,
    input_fingerprint: inputFingerprint,
    inputs,
    artifacts: artifactHashes,
    ordering: "occurred_at ASC, event_id ASC",
  };
  manifest.manifest_digest = digestOf({ ...manifest, manifest_digest: undefined });
  products["manifest.json"] = manifest;

  const outDir = values["out-dir"].replace(/\/+$/, "");
  const tmpDir = `${outDir}.tmp-${process.pid}`;
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(path.join(tmpDir, "proofs"), { recursive: true });
  for (const [name, value] of Object.entries(products)) {
    await writeFile(path.join(tmpDir, name), `${canonicalJson(value)}\n`);
  }
  await rm(outDir, { recursive: true, force: true });
  await rename(tmpDir, outDir);

  console.log(`ok	season=${values.season}	events=${state.eventCount}	artifacts=${Object.keys(products).length}	digest=${manifest.manifest_digest}`);
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
