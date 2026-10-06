import assert from "node:assert/strict";
import test from "node:test";

import { buildLedger } from "../src/ledger.js";
import { computeChildStatus } from "../src/status.js";
import { issueProof } from "../src/views.js";
import { runDayEnd } from "../src/dayend.js";

const AGGREGATE = {
  CHILD_REGISTERED: "child_record",
  POLICY_PUBLISHED: "season_policy",
  CONSENT_RECORDED: "child_record",
  DEFERRAL_RECORDED: "child_record",
  DOSE_RECORDED: "dose_event",
  RECORD_MATCHED: "child_record",
  DOSE_RECONCILED: "child_record",
  PLAN_CREATED: "dose_plan",
  BATCH_SUSPENDED: "batch_notice",
  PROOF_ISSUED: "child_record",
};

function ev(id, type, aggregateId, occurredAt, payload, version = 1) {
  return {
    event_id: id,
    event_type: type,
    aggregate_type: AGGREGATE[type],
    aggregate_id: aggregateId,
    occurred_at: occurredAt,
    version,
    payload,
  };
}

const SEASON = "2026-2027";
const AS_OF = "2026-11-15";

function policy(id = "pol-1", guideline = "CN-FLU-2026", at = "2026-08-15T09:00:00+08:00", version = 1) {
  return ev(id, "POLICY_PUBLISHED", SEASON, at, {
    guideline_version: guideline,
    season_start: "2026-07-01",
    season_end: "2027-06-30",
    advisory_complete_by: "2026-10-31",
  }, version);
}

function register(id, childId, birthDate) {
  return ev(id, "CHILD_REGISTERED", childId, "2026-09-01T08:00:00+08:00", {
    birth_date: birthDate,
    home_region: "A",
  });
}

function consent(id, childId, scope = "vaccination", granted = true, at = "2026-09-10T09:00:00+08:00") {
  return ev(id, "CONSENT_RECORDED", childId, at, { scope, granted, guardian_ref: `g-${childId}` });
}

function dose(id, childRef, seq, administeredAt, lotNo, extra = {}) {
  return ev(id, "DOSE_RECORDED", `d-${id}`, administeredAt, {
    child_ref: childRef,
    season_id: SEASON,
    dose_seq: seq,
    administered_at: administeredAt,
    product: "四价流感裂解疫苗",
    lot_no: lotNo,
    origin: "local",
    executor_id: "nurse-01",
    ...extra,
  });
}

/** 2010 年出生：季初 16 岁，本季只需 1 剂。 */
function baseEvents(childId = "c-1") {
  return [policy(), register("reg-1", childId, "2010-05-01"), consent("con-1", childId)];
}

test("离线回传乱序与重复送达得到相同日终结果", () => {
  const events = [
    ...baseEvents(),
    dose("d1", "c-1", 1, "2026-09-20T10:00:00+08:00", "L100"),
    dose("d2", "c-1", 1, "2026-09-20T10:00:00+08:00", "L100"), // 内容完全相同的重发（不同事件标识）
  ];
  const ordered = runDayEnd(events, AS_OF);
  const shuffled = runDayEnd([...events].reverse(), AS_OF);
  assert.equal(shuffled.digest, ordered.digest);
  // 内容相同但事件标识不同的重发：只计一剂，另一条标记 duplicate
  const status = ordered.children.find((item) => item.child_id === "c-1");
  assert.equal(status.status, "completed");
  assert.deepEqual(status.explanation.counted_fact_event_ids, ["d1"]);
  assert.deepEqual(status.explanation.excluded_facts, [{ event_id: "d2", reason: "duplicate" }]);
  // 同一事件标识重复送达：跳过并计数，不影响结果
  const redelivered = runDayEnd([...events, events[3], events[4]], AS_OF);
  assert.equal(redelivered.duplicate_deliveries, 2);
  assert.deepEqual(redelivered.children, ordered.children);
  assert.equal(redelivered.log_digest, ordered.log_digest);
});

test("业务键相同但批号时间执行人不同进入核对，和解后计入", () => {
  const events = [
    ...baseEvents(),
    dose("d1", "c-1", 1, "2026-09-20T10:00:00+08:00", "L100"),
    dose("d2", "c-1", 1, "2026-09-21T10:00:00+08:00", "L100", { executor_id: "nurse-02" }),
  ];
  const conflicted = computeChildStatus(buildLedger(events), "c-1", SEASON, AS_OF);
  assert.equal(conflicted.status, "needs_review");
  assert.ok(conflicted.review_reasons.includes("dose_conflict"));
  assert.deepEqual(conflicted.explanation.counted_fact_event_ids, []);

  const resolved = [
    ...events,
    ev("rec-1", "DOSE_RECONCILED", "c-1", "2026-10-01T09:00:00+08:00", {
      season_id: SEASON,
      dose_seq: 1,
      kept_event_id: "d2",
    }),
  ];
  const status = computeChildStatus(buildLedger(resolved), "c-1", SEASON, AS_OF);
  assert.equal(status.status, "completed");
  assert.deepEqual(status.explanation.counted_fact_event_ids, ["d2"]);
  assert.deepEqual(status.explanation.excluded_facts, [{ event_id: "d1", reason: "superseded" }]);
});

test("异地记录经授权匹配后才合并，不做字面去重", () => {
  const externalDose = dose("d1", "ext-778", 1, "2026-10-02T10:00:00+08:00", "L300", {
    origin: "external",
    source_region: "B",
    consent_ref: "paper-55",
  });
  // child_ref 与本地档案号字面相同也不隐含同一儿童
  const lookalike = dose("d2", "c-1", 1, "2026-10-05T10:00:00+08:00", "L301", {
    origin: "external",
    source_region: "B",
    consent_ref: "paper-56",
  });
  const before = runDayEnd([...baseEvents(), externalDose, lookalike], AS_OF);
  const statusBefore = before.children.find((item) => item.child_id === "c-1");
  assert.equal(statusBefore.status, "in_progress");
  assert.deepEqual(statusBefore.explanation.counted_fact_event_ids, []);
  assert.deepEqual(
    before.quarantined_external.map((item) => item.external_ref).sort(),
    ["c-1", "ext-778"],
  );

  const matched = ev("m1", "RECORD_MATCHED", "c-1", "2026-10-12T16:00:00+08:00", {
    external_ref: "ext-778",
    source_region: "B",
    match_auth_id: "AUTH-2026-0315",
  });
  const after = runDayEnd([...baseEvents(), externalDose, lookalike, matched], AS_OF);
  const statusAfter = after.children.find((item) => item.child_id === "c-1");
  assert.equal(statusAfter.status, "completed");
  assert.deepEqual(statusAfter.explanation.counted_fact_event_ids, ["d1"]);
  assert.deepEqual(after.quarantined_external.map((item) => item.external_ref), ["c-1"]);
});

test("批次停用只阻断未执行计划，已完成事实保留并找出真实使用者", () => {
  const events = [
    ...baseEvents("c-1"),
    ...baseEvents("c-2").map((event) => ({ ...event, event_id: `${event.event_id}-b` })),
    dose("d1", "c-1", 1, "2026-09-20T10:00:00+08:00", "L900"),
    ev("p1", "PLAN_CREATED", "p-1", "2026-10-10T09:00:00+08:00", {
      child_id: "c-2",
      season_id: SEASON,
      lot_no: "L900",
      planned_for: "2026-11-01",
    }),
    ev("s1", "BATCH_SUSPENDED", "L900", "2026-10-20T18:00:00+08:00", {
      lot_no: "L900",
      effective_at: "2026-10-20",
      reason: "冷链温度超标",
    }),
  ];
  const snapshot = runDayEnd(events, AS_OF);
  const suspension = snapshot.suspensions.find((item) => item.lot_no === "L900");
  assert.deepEqual(suspension.recipients, ["c-1"]);
  assert.deepEqual(suspension.affected_pending_plans, ["c-2"]);
  const vaccinated = snapshot.children.find((item) => item.child_id === "c-1");
  assert.equal(vaccinated.status, "completed"); // 已完成事实不可删除
});

test("医学禁忌与普通迟到采用不同处置", () => {
  const events = [
    ...baseEvents("c-med"),
    ...baseEvents("c-late").map((event) => ({ ...event, event_id: `${event.event_id}-b` })),
    ev("df-1", "DEFERRAL_RECORDED", "c-med", "2026-10-05T09:00:00+08:00", {
      season_id: SEASON,
      reason_kind: "medical_contraindication",
    }),
    ev("df-2", "DEFERRAL_RECORDED", "c-late", "2026-10-05T09:00:00+08:00", {
      season_id: SEASON,
      reason_kind: "ordinary",
      until: "2026-12-01",
    }),
  ];
  const ledger = buildLedger(events);
  const medical = computeChildStatus(ledger, "c-med", SEASON, AS_OF);
  assert.equal(medical.status, "deferred");
  assert.equal(medical.deferral.reason_kind, "medical_contraindication");
  assert.match(medical.deferral.disposition, /医学评估/);
  const ordinary = computeChildStatus(ledger, "c-late", SEASON, AS_OF);
  assert.equal(ordinary.status, "deferred");
  assert.match(ordinary.deferral.disposition, /仍可预约接种/);
});

test("建议十月底前完成不是逾期禁止接种", () => {
  const ledger = buildLedger(baseEvents());
  const status = computeChildStatus(ledger, "c-1", SEASON, AS_OF); // as_of 已过 10-31
  assert.equal(status.status, "in_progress");
  assert.equal(status.advisory_passed, true);
  assert.equal(status.advisory_only, true);
  assert.equal(status.can_vaccinate, true);
});

test("家长撤回额外数据用途后仍能取得自己的剂次证明", () => {
  const events = [
    ...baseEvents(),
    dose("d1", "c-1", 1, "2026-09-20T10:00:00+08:00", "L100"),
    consent("con-2", "c-1", "data_sharing", false, "2026-10-15T09:00:00+08:00"),
  ];
  const ledger = buildLedger(events);
  const parent = issueProof(ledger, "c-1", SEASON, "parent", AS_OF);
  assert.equal(parent.issued, true);
  assert.equal(parent.proof.status, "completed");
  assert.equal(parent.event.event_type, "PROOF_ISSUED");
  assert.equal(parent.event.payload.viewer_role, "parent");
  const research = issueProof(ledger, "c-1", SEASON, "research", AS_OF);
  assert.equal(research.issued, false);
  assert.equal(research.reason, "data_sharing_withdrawn");
});

test("学校只看到完成暂缓需核验，看不到诊断细节", () => {
  const events = [
    ...baseEvents(),
    ev("df-1", "DEFERRAL_RECORDED", "c-1", "2026-10-05T09:00:00+08:00", {
      season_id: SEASON,
      reason_kind: "medical_contraindication",
    }),
  ];
  const ledger = buildLedger(events);
  const school = issueProof(ledger, "c-1", SEASON, "school", AS_OF);
  assert.equal(school.issued, true);
  assert.deepEqual(Object.keys(school.proof).sort(), ["category", "child_id", "season_id"]);
  assert.equal(school.proof.category, "暂缓");
  assert.ok(!JSON.stringify(school.proof).includes("medical_contraindication"));
});

test("指南改版采用最新版本并在解释中留痕", () => {
  const events = [
    policy("pol-1", "CN-FLU-2026"),
    policy("pol-2", "CN-FLU-2026-r2", "2026-09-30T09:00:00+08:00", 2),
    register("reg-1", "c-1", "2010-05-01"),
    consent("con-1", "c-1"),
    dose("d1", "c-1", 1, "2026-09-20T10:00:00+08:00", "L100"),
  ];
  const status = computeChildStatus(buildLedger(events), "c-1", SEASON, AS_OF);
  assert.equal(status.explanation.guideline_version, "CN-FLU-2026-r2");
  assert.equal(status.explanation.policy_event_id, "pol-2");
  assert.equal(status.explanation.policy_version, 2);
});

test("跨年流行季独立计算，既往剂次跨季累计", () => {
  const prevSeason = ev("pol-0", "POLICY_PUBLISHED", "2025-2026", "2025-08-15T09:00:00+08:00", {
    guideline_version: "CN-FLU-2025",
    season_start: "2025-07-01",
    season_end: "2026-06-30",
    advisory_complete_by: "2025-10-31",
  });
  const events = [
    prevSeason,
    policy(),
    register("reg-1", "c-1", "2019-06-01"), // 季初 7 岁：既往满 2 剂则本季 1 剂
    consent("con-1", "c-1"),
    dose("d1", "c-1", 1, "2025-09-10T10:00:00+08:00", "L050", { season_id: "2025-2026" }),
    dose("d2", "c-1", 2, "2025-10-15T10:00:00+08:00", "L051", { season_id: "2025-2026" }),
  ];
  const ledger = buildLedger(events);
  const prev = computeChildStatus(ledger, "c-1", "2025-2026", AS_OF);
  assert.equal(prev.status, "completed");
  assert.equal(prev.explanation.required_doses, 2);
  const current = computeChildStatus(ledger, "c-1", SEASON, AS_OF);
  assert.equal(current.explanation.prior_doses, 2);
  assert.equal(current.explanation.required_doses, 1);
  assert.equal(current.status, "in_progress");
});

test("两剂间隔不足的事实不计入", () => {
  const events = [
    policy(),
    register("reg-1", "c-1", "2021-01-01"), // 季初 5 岁，需 2 剂
    consent("con-1", "c-1"),
    dose("d1", "c-1", 1, "2026-09-01T10:00:00+08:00", "L100"),
    dose("d2", "c-1", 2, "2026-09-10T10:00:00+08:00", "L101"),
  ];
  const status = computeChildStatus(buildLedger(events), "c-1", SEASON, AS_OF);
  assert.equal(status.status, "in_progress");
  assert.equal(status.remaining_doses, 1);
  assert.equal(status.next_due, "2026-09-29");
  assert.deepEqual(status.explanation.excluded_facts, [{ event_id: "d2", reason: "interval_too_short" }]);
});

test("缺知情同意的剂次不计入并触发需核验", () => {
  const events = [
    policy(),
    register("reg-1", "c-1", "2010-05-01"),
    dose("d1", "c-1", 1, "2026-09-20T10:00:00+08:00", "L100"),
  ];
  const missing = computeChildStatus(buildLedger(events), "c-1", SEASON, AS_OF);
  assert.equal(missing.status, "needs_review");
  assert.ok(missing.review_reasons.includes("consent_missing"));
  const withConsent = computeChildStatus(buildLedger([...events, consent("con-1", "c-1")]), "c-1", SEASON, AS_OF);
  assert.equal(withConsent.status, "completed");
});

test("确定性日终：重放与并发补录结果一致", () => {
  const events = [
    ...baseEvents("c-1"),
    ...baseEvents("c-2").map((event) => ({ ...event, event_id: `${event.event_id}-b` })),
    dose("d1", "c-1", 1, "2026-09-20T10:00:00+08:00", "L100"),
  ];
  const first = runDayEnd(events, AS_OF);
  const replayed = runDayEnd(events, AS_OF); // 进程恢复后重放
  assert.equal(replayed.digest, first.digest);
  // 并发补录：同一事件集合分批到达，合并后结果相同
  const backfill = runDayEnd([events[3], events[0], events[2], events[1], events[4], events[5], events[6]], AS_OF);
  assert.equal(backfill.digest, first.digest);
  assert.equal(backfill.log_digest, first.log_digest);
});
