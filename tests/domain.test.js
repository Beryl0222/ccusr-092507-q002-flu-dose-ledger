import assert from "node:assert/strict";
import test from "node:test";

import { foldEvents, rootOf } from "../src/domain/fold.js";
import { computeChildStatus, schoolBucket } from "../src/domain/status.js";
import { canonicalJson, digestOf, guardianProof, integrityFindings, schoolRoster } from "../src/domain/projections.js";
import {
  baseRules,
  batchEvent,
  childEvent,
  clearDeferralEvent,
  decisionEvent,
  deferralEvent,
  doseEvent,
  matchEvent,
  policyEvent,
  resetSeq,
} from "./helpers/fixtures.js";

const OCT = "2026-10-31T12:00:00+08:00";
const LATE_NOV = "2026-11-10T12:00:00+08:00";
const NEXT_SEASON = "2027-07-15T12:00:00+08:00";

function setup(events) {
  resetSeq();
  return foldEvents([policyEvent(), ...events]);
}

test("建议期限过期不等于禁止：十一月迟到仍可接种，季末才关账", () => {
  const state = setup([
    childEvent("c", { birth: "2020-01-01" }), // 既往无史 → 2 剂
  ]);
  const late = computeChildStatus(state, "c", "2026", LATE_NOV);
  assert.equal(late.status, "DUE");
  assert.equal(late.late, true);
  assert.equal(late.next_action.still_allowed_after_recommended_by, true);
  assert.ok(late.reasons.some((r) => r.code === "PAST_RECOMMENDED_DEADLINE"));

  const closed = computeChildStatus(state, "c", "2026", NEXT_SEASON);
  assert.equal(closed.status, "CLOSED_INCOMPLETE");
  assert.equal(closed.next_action, null); // 季末关账，不再给出接种动作
  assert.ok(closed.reasons.some((r) => r.code === "SEASON_ENDED"));
});

test("既往季完成1剂的9岁以下儿童本季只需1剂，并形成保护窗", () => {
  const state = setup([
    childEvent("c", { birth: "2020-01-01" }),
    doseEvent({ child: "c", season: "2025", at: "2025-10-01T10:00:00+08:00", lot: "L25", report: "r25" }),
    doseEvent({ child: "c", at: "2026-09-15T10:00:00+08:00", lot: "L26", report: "r26" }),
  ]);
  const s = computeChildStatus(state, "c", "2026", OCT);
  assert.equal(s.required_doses, 1);
  assert.equal(s.status, "COMPLETE");
  assert.equal(s.protection.starts_on, "2026-09-29"); // +14 天
  assert.equal(s.protection.state, "ACTIVE");
  assert.equal(s.policy.guideline_version, "2026.1");
  assert.equal(s.prior_facts.length, 1);
});

test("首次接种儿童需2剂且满足28天间隔；间隔不足不计数、事实保留", () => {
  const ok = setup([
    childEvent("c", { birth: "2022-01-01" }),
    doseEvent({ child: "c", at: "2026-09-01T10:00:00+08:00", report: "d1" }),
    doseEvent({ child: "c", seq: "2", at: "2026-09-20T10:00:00+08:00", report: "d2" }), // 仅19天
  ]);
  const short = computeChildStatus(ok, "c", "2026", OCT);
  assert.equal(short.valid_facts.length, 1);
  assert.equal(short.retained_facts.length, 2);
  assert.ok(short.retained_facts[1].flags.some((f) => f.code === "DOSE_INTERVAL_TOO_SHORT"));
  assert.equal(short.status, "IN_PROGRESS");

  const good = setup([
    childEvent("c", { birth: "2022-01-01" }),
    doseEvent({ child: "c", at: "2026-09-01T10:00:00+08:00", report: "d1" }),
    doseEvent({ child: "c", seq: "2", at: "2026-09-30T10:00:00+08:00", report: "d2" }), // 29天
  ]);
  assert.equal(computeChildStatus(good, "c", "2026", OCT).status, "COMPLETE");
});

test("内容完全相同的重复回传自动去重，不进入核对", () => {
  const state = setup([
    childEvent("c", { birth: "2017-01-01" }),
    doseEvent({ child: "c", at: "2026-09-15T10:00:00+08:00", report: "r1", eventId: "ev-a" }),
    doseEvent({ child: "c", at: "2026-09-15T10:00:00+08:00", report: "r2", eventId: "ev-b" }),
  ]);
  const s = computeChildStatus(state, "c", "2026", OCT);
  assert.equal(s.status, "COMPLETE");
  assert.ok(s.retained_facts[0].flags.some((f) => f.code === "DUPLICATE_REPORT_RETAINED"));
});

test("业务键相同但批号/时间/执行人不同必须进入核对", () => {
  const state = setup([
    childEvent("c", { birth: "2017-01-01" }),
    doseEvent({ child: "c", lot: "LA", at: "2026-09-15T10:00:00+08:00", by: "甲", report: "r1", eventId: "ev-a" }),
    doseEvent({ child: "c", lot: "LB", at: "2026-09-16T10:00:00+08:00", by: "乙", report: "r2", eventId: "ev-b" }),
  ]);
  const s = computeChildStatus(state, "c", "2026", OCT);
  assert.equal(s.status, "NEEDS_VERIFICATION");
  assert.equal(s.conflicts[0].candidate_report_keys.length, 2);
  assert.equal(schoolBucket(s.status), "NEEDS_VERIFICATION");
});

test("人工确认重复并指定采信报告后完成，落选报告留痕不计数", () => {
  const state = setup([
    childEvent("c", { birth: "2017-01-01" }),
    doseEvent({ child: "c", lot: "LA", at: "2026-09-15T10:00:00+08:00", report: "r1", eventId: "ev-a" }),
    doseEvent({ child: "c", lot: "LB", at: "2026-09-16T10:00:00+08:00", report: "r2", eventId: "ev-b" }),
    decisionEvent({ child: "c", resolution: "CONFIRMED_DUPLICATE", winner: { region: "3301", report: "r2" } }),
  ]);
  const s = computeChildStatus(state, "c", "2026", OCT);
  assert.equal(s.status, "COMPLETE");
  assert.equal(s.valid_facts[0].report_key, "3301|r2");
  assert.deepEqual(s.retained_facts[0].flags.map((f) => f.code), ["DUPLICATE_REPORT_RETAINED"]);
});

test("人工判定为两次不同接种后按指派重派剂位", () => {
  const state = setup([
    childEvent("c", { birth: "2022-01-01" }),
    doseEvent({ child: "c", seq: "1", lot: "LA", at: "2026-09-01T10:00:00+08:00", report: "r1", eventId: "ev-a" }),
    doseEvent({ child: "c", seq: "1", lot: "LB", at: "2026-09-30T10:00:00+08:00", report: "r2", eventId: "ev-b" }),
    decisionEvent({
      child: "c",
      seq: "1",
      resolution: "DISTINCT_DOSES",
      assignments: [
        { region_code: "3301", source_report_id: "r1", dose_seq: "1" },
        { region_code: "3301", source_report_id: "r2", dose_seq: "2" },
      ],
    }),
  ]);
  const s = computeChildStatus(state, "c", "2026", OCT);
  assert.equal(s.status, "COMPLETE");
  assert.deepEqual(s.valid_facts.map((f) => f.report_key), ["3301|r1", "3301|r2"]);
});

test("跨地区记录只有授权匹配后才合并；不能用姓名去重", () => {
  const state = setup([
    childEvent("home", { birth: "2017-01-01" }),
    childEvent("away", { birth: "2017-01-01", region: "3201" }),
    doseEvent({ child: "home", report: "rh" }),
    doseEvent({ child: "away", region: "3201", report: "ra", at: "2026-09-17T10:00:00+08:00", lot: "LX" }),
  ]);
  // 合并前是两条独立记录
  assert.equal(rootOf(state, "away"), "away");
  assert.equal(computeChildStatus(state, "home", "2026", OCT).status, "COMPLETE");
  assert.equal(computeChildStatus(state, "away", "2026", OCT).status, "COMPLETE");

  foldEvents([matchEvent({ source: "away", target: "home" })], state);
  assert.equal(rootOf(state, "away"), "home");
  // 合并后同一业务键出现两份不同报告 → 进入核对，而不是自动当成两剂
  const merged = computeChildStatus(state, "away", "2026", OCT);
  assert.equal(merged.status, "NEEDS_VERIFICATION");
  assert.equal(merged.child_record_id, "home");
});

test("批次停用不删除已完成事实；停用后接种者进入随访，停用前不随访", () => {
  const state = setup([
    childEvent("before", { birth: "2017-01-01" }),
    childEvent("after", { birth: "2017-01-01" }),
    doseEvent({ child: "before", lot: "LSTOP", at: "2026-09-10T10:00:00+08:00", report: "rb" }),
    doseEvent({ child: "after", lot: "LSTOP", at: "2026-09-25T10:00:00+08:00", report: "ra" }),
    batchEvent({ lot: "LSTOP", effective: "2026-09-20T08:00:00+08:00" }),
  ]);
  const sBefore = computeChildStatus(state, "before", "2026", OCT);
  const sAfter = computeChildStatus(state, "after", "2026", OCT);
  assert.equal(sBefore.status, "COMPLETE");
  assert.equal(sAfter.status, "COMPLETE"); // 事实仍计数（产品层面另作随访，不抹除）
  assert.ok(!sBefore.retained_facts[0].flags.some((f) => f.code === "LOT_SUSPENDED_RECIPIENT"));
  assert.ok(sAfter.retained_facts[0].flags.some((f) => f.code === "LOT_SUSPENDED_RECIPIENT"));
});

test("医学禁忌与临时暂缓分桶；暂缓到期自动恢复可接种", () => {
  const contra = setup([
    childEvent("m", { birth: "2022-01-01" }),
    deferralEvent({ child: "m", kind: "MEDICAL_CONTRAINDICATION", reason: "SEVERE_ALLERGY" }),
  ]);
  assert.equal(computeChildStatus(contra, "m", "2026", OCT).status, "DEFERRED_MEDICAL");

  const temp = setup([
    childEvent("t", { birth: "2022-01-01" }),
    deferralEvent({ child: "t", kind: "TEMPORARY_DEFERRAL", validUntil: "2026-10-20" }),
  ]);
  assert.equal(computeChildStatus(temp, "t", "2026", OCT).status, "DUE"); // 已过期自动失效
  assert.equal(computeChildStatus(temp, "t", "2026", "2026-10-15T12:00:00+08:00").status, "DEFERRED_TEMPORARY");
});

test("临时暂缓被清除后回到待接种", () => {
  const dId = "def-1";
  const state = setup([
    childEvent("c", { birth: "2022-01-01" }),
    deferralEvent({ child: "c", validUntil: "2026-12-01", eventId: dId }),
    clearDeferralEvent({ child: "c", season: "2026", deferralId: dId, at: "2026-10-01T09:00:00+08:00" }),
  ]);
  assert.equal(computeChildStatus(state, "c", "2026", OCT).status, "DUE");
});

test("撤回额外数据用途后监护人仍能取得完整剂次证明，但 extra 被剥离", () => {
  const state = setup([
    childEvent("c", { birth: "2017-01-01", extra: { id_last4: "9999" } }),
    doseEvent({ child: "c", report: "r1", extra: { site: "左上臂" } }),
    {
      event_id: "consent-off",
      event_type: "CONSENT_UPDATED",
      aggregate_type: "child_record",
      aggregate_id: "c",
      occurred_at: "2026-10-01T18:00:00+08:00",
      version: 1,
      payload: { child_record_id: "c", scope: "EXTRA_DATA_USE", granted: false, effective_at: "2026-10-01T18:00:00+08:00" },
    },
  ]);
  const proof = guardianProof(state, "c", "2026", OCT);
  assert.equal(proof.body.status, "COMPLETE");
  const json = canonicalJson(proof);
  assert.ok(!json.includes("id_last4"));
  assert.ok(!json.includes("左上臂"));
  assert.equal(proof.body.consent_extra_data_use.granted, false);
});

test("学校花名册只有三桶，不含诊断、批号与理由", () => {
  const state = setup([
    childEvent("done", { birth: "2017-01-01" }),
    doseEvent({ child: "done", report: "r1" }),
    childEvent("med", { birth: "2022-01-01" }),
    deferralEvent({ child: "med", kind: "MEDICAL_CONTRAINDICATION", reason: "SEVERE_ALLERGY" }),
    childEvent("conflict", { birth: "2017-01-01" }),
    doseEvent({ child: "conflict", lot: "A", report: "x", eventId: "x1" }),
    doseEvent({ child: "conflict", lot: "B", report: "y", eventId: "y1" }),
  ]);
  const roster = schoolRoster(state, "2026", OCT);
  const text = canonicalJson(roster);
  assert.ok(!text.includes("SEVERE_ALLERGY"));
  assert.ok(!text.includes("lot"));
  const byId = Object.fromEntries(roster.children.map((c) => [c.child_record_id, c.result]));
  assert.equal(byId.done, "COMPLETED");
  assert.equal(byId.med, "DEFERRED"); // 禁忌在学校只呈现为“暂缓”
  assert.equal(byId.conflict, "NEEDS_VERIFICATION");
});

test("跨年流感季：同一儿童跨季状态独立，季标识字典序区分既往史", () => {
  const state = foldEvents([
    policyEvent({ season: "2025", version: "2025.1", published: "2025-06-01T09:00:00+08:00", effective: "2025-07-01T00:00:00+08:00" }),
    policyEvent(),
    childEvent("c", { birth: "2016-01-01" }),
    doseEvent({ child: "c", season: "2025", at: "2025-10-01T10:00:00+08:00", report: "p25" }),
    doseEvent({ child: "c", season: "2026", at: "2026-09-15T10:00:00+08:00", report: "p26" }),
  ]);
  const s2025 = computeChildStatus(state, "c", "2025", "2025-10-20T12:00:00+08:00");
  assert.equal(s2025.policy.guideline_version, "2025.1");
  assert.equal(s2025.required_doses, 1);
  assert.equal(s2025.status, "COMPLETE");
  const s2026 = computeChildStatus(state, "c", "2026", OCT);
  assert.equal(s2026.required_doses, 1);
  assert.equal(s2026.status, "COMPLETE");
});

test("指南改版：查询时刻决定适用版本，改版前的完成结论带旧版本号", () => {
  const v2Rules = {
    ...baseRules,
    recommended_complete_by: "2026-11-15",
    schedule: baseRules.schedule.map((r) => (r.id === "u9-first" ? { ...r, dose_count: 1 } : r)),
  };
  const state = setup([
    policyEvent({
      version: "2026.2",
      published: "2026-10-25T10:00:00+08:00",
      effective: "2026-11-01T00:00:00+08:00",
      rules: v2Rules,
    }),
    childEvent("c", { birth: "2022-01-01" }),
    doseEvent({ child: "c", at: "2026-09-10T10:00:00+08:00", report: "r1" }),
  ]);
  const before = computeChildStatus(state, "c", "2026", "2026-10-31T12:00:00+08:00");
  assert.equal(before.policy.guideline_version, "2026.1");
  assert.equal(before.required_doses, 2);
  assert.equal(before.status, "IN_PROGRESS");
  const after = computeChildStatus(state, "c", "2026", "2026-11-05T12:00:00+08:00");
  assert.equal(after.policy.guideline_version, "2026.2");
  assert.equal(after.required_doses, 1);
  assert.equal(after.status, "COMPLETE");
});

test("乱序与重复投递：打乱事件数组后结果一致且哈希相同", () => {
  resetSeq();
  const events = [
    policyEvent(),
    childEvent("c", { birth: "2020-01-01" }),
    doseEvent({ child: "c", lot: "A", at: "2026-09-15T10:00:00+08:00", report: "r1", eventId: "e1" }),
    doseEvent({ child: "c", lot: "B", at: "2026-09-16T10:00:00+08:00", report: "r2", eventId: "e2" }),
    decisionEvent({ child: "c", resolution: "CONFIRMED_DUPLICATE", winner: { region: "3301", report: "r2" }, decidedAt: "2026-09-19T09:00:00+08:00" }),
  ];
  const a = foldEvents(events);
  const shuffled = [events[3], events[0], events[4], events[2], events[1], events[2] /* 重复 */];
  const b = foldEvents(shuffled);
  const sa = computeChildStatus(a, "c", "2026", OCT);
  const sb = computeChildStatus(b, "c", "2026", OCT);
  assert.equal(digestOf(sa), digestOf(sb));
  assert.equal(sa.valid_facts[0].report_key, "3301|r2");
});

test("进程恢复语义：从全量日志重放总是得到同一摘要（不依赖增量物化）", () => {
  const events = [
    policyEvent(),
    childEvent("c", { birth: "2020-01-01" }),
    doseEvent({ child: "c", report: "r1" }),
  ];
  const full = foldEvents(events);
  const partial = foldEvents(events.slice(0, 2));
  foldEvents(events.slice(2), partial); // 恢复后追加
  assert.equal(digestOf(computeChildStatus(full, "c", "2026", OCT)), digestOf(computeChildStatus(partial, "c", "2026", OCT)));
});

test("不足6月龄不到起种年龄，给出到龄日而非判为暂缓或完成", () => {
  const state = setup([childEvent("baby", { birth: "2026-06-01" })]);
  const s = computeChildStatus(state, "baby", "2026", OCT);
  assert.equal(s.status, "NOT_YET_ELIGIBLE");
  assert.equal(s.next_action.eligible_on, "2026-12-01"); // 满6月龄
  assert.equal(schoolBucket(s.status), "DEFERRED");
});

test("缺少生效策略版本时给需核验，而不是臆测规则", () => {
  resetSeq();
  const state = foldEvents([childEvent("c", { birth: "2020-01-01" })]);
  const s = computeChildStatus(state, "c", "2026", OCT);
  assert.equal(s.status, "NEEDS_VERIFICATION");
  assert.ok(s.reasons.some((r) => r.code === "POLICY_MISSING"));
});

test("证明携带规则版本与有效事实，可逐项解释", () => {
  const state = setup([
    childEvent("c", { birth: "2020-01-01" }),
    doseEvent({ child: "c", season: "2025", at: "2025-10-01T10:00:00+08:00", report: "old" }),
    doseEvent({ child: "c", at: "2026-09-15T10:00:00+08:00", report: "now" }),
  ]);
  const proof = guardianProof(state, "c", "2026", OCT);
  assert.equal(proof.document_type, "CHILD_FLU_DOSE_PROOF");
  assert.equal(proof.body.policy.guideline_version, "2026.1");
  assert.deepEqual(proof.body.valid_facts.map((f) => f.report_key), ["3301|now"]);
  assert.ok(proof.proof_digest && proof.proof_digest.length === 64);
  assert.ok(proof.explanation_summary.length > 0);
});

test("指向未登记儿童的接种报告会被完整性巡检捕获，不静默丢失", () => {
  const state = setup([
    doseEvent({ child: "ghost", report: "rg" }),
  ]);
  const findings = integrityFindings(state);
  assert.ok(findings.some((f) => f.code === "ORPHAN_DOSE_REPORT" && f.child_record_id === "ghost"));
  // 查询该儿童也应给需核验
  assert.equal(computeChildStatus(state, "ghost", "2026", OCT).status, "NEEDS_VERIFICATION");
});

test("相同 event_id 不同内容判为标识碰撞；相同内容重复投递静默幂等", () => {
  resetSeq();
  const base = [
    policyEvent(),
    childEvent("c", { birth: "2017-01-01" }),
    doseEvent({ child: "c", report: "r1", eventId: "same-id", lot: "LA", at: "2026-09-15T10:00:00+08:00" }),
  ];
  const state = foldEvents(base);
  // 相同内容再投一次：无新增告警
  foldEvents([base[2]], state);
  assert.ok(!state.notices.some((n) => n.code === "EVENT_ID_COLLISION"));
  // 同 id 但批号不同：碰撞告警
  foldEvents(
    [doseEvent({ child: "c", report: "r1", eventId: "same-id", lot: "LB", at: "2026-09-16T10:00:00+08:00" })],
    state,
  );
  assert.ok(state.notices.some((n) => n.code === "EVENT_ID_COLLISION"));
});
