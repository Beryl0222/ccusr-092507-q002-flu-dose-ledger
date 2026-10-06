import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const schema = path.join(root, "contracts/domain.schema.json");
const cli = path.join(root, "src/day-end.js");
const sourceLines = readFileSync(path.join(root, "data/events.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim());

function run(eventsFiles, outDir, asOf = "2026-10-31T12:00:00+08:00") {
  execFileSync(
    process.execPath,
    [cli, "--schema", schema, "--events", eventsFiles.join(","), "--season", "2026", "--as-of", asOf, "--out-dir", outDir],
    { cwd: root },
  );
}

function manifestDigest(outDir) {
  return JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8")).manifest_digest;
}

function artifactsDigest(outDir) {
  // 产物哈希集合只由事件内容决定，与文件分片/到达顺序无关。
  const { artifacts } = JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  return JSON.stringify(artifacts);
}

test("日终重复运行产出相同清单摘要（幂等）", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dedup-"));
  try {
    const events = path.join(dir, "events.jsonl");
    writeFileSync(events, `${sourceLines.join("\n")}\n`);
    const out1 = path.join(dir, "out1");
    const out2 = path.join(dir, "out2");
    run([events], out1);
    run([events], out2);
    assert.equal(manifestDigest(out1), manifestDigest(out2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("分片输入、乱序与重复行不改变结果；恢复=全量重放", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "split-"));
  try {
    const half = Math.ceil(sourceLines.length / 2);
    // 故意把后半段放在前、前半段放在后，并重复一行
    const partA = [...sourceLines.slice(half), sourceLines[half]];
    const partB = sourceLines.slice(0, half);
    const a = path.join(dir, "a.jsonl");
    const b = path.join(dir, "b.jsonl");
    writeFileSync(a, `${partA.join("\n")}\n`);
    writeFileSync(b, `${partB.join("\n")}\n`);
    const all = path.join(dir, "all.jsonl");
    writeFileSync(all, `${sourceLines.join("\n")}\n`);

    const outSplit = path.join(dir, "split");
    const outAll = path.join(dir, "all");
    run([a, b], outSplit);
    run([all], outAll);
    assert.equal(artifactsDigest(outSplit), artifactsDigest(outAll));

    const mSplit = JSON.parse(readFileSync(path.join(outSplit, "manifest.json"), "utf8"));
    const mAll = JSON.parse(readFileSync(path.join(outAll, "manifest.json"), "utf8"));
    assert.equal(mSplit.event_count, mAll.event_count);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("学校花名册不含任何诊断或批号字段", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "school-"));
  try {
    const events = path.join(dir, "events.jsonl");
    writeFileSync(events, `${sourceLines.join("\n")}\n`);
    const out = path.join(dir, "out");
    run([events], out);
    const roster = readFileSync(path.join(out, "school-roster.json"), "utf8");
    for (const forbidden of ["SEVERE_ALLERGY", "ACUTE_FEBRILE", "lot_no", "L2026", "reason_code", "protection"]) {
      assert.ok(!roster.includes(forbidden), `学校视图泄漏了 ${forbidden}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
