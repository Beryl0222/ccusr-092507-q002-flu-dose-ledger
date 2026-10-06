// 角色投影与运营分析。
//
// 视图规则：
// - 监护人（GUARDIAN）：完整剂次证明，含策略版本、有效事实、保护窗、核对留痕。
// - 学校（SCHOOL）：每名儿童只有 完成 / 暂缓 / 需核验 三桶，绝无诊断、批号、时间窗。
// - 疾控（CDC）：运营视图，含核对队列、批次影响、计划取消、系统通知。
// 家长撤回额外数据用途（CONSENT_UPDATED/EXTRA_DATA_USE granted=false）后，
// extra 字段不进入任何投影，但核心接种事实照常出证明。

import { createHash } from "node:crypto";

import { rootOf } from "./fold.js";
import { computeChildStatus, schoolBucket } from "./status.js";
import { toInstant } from "./time.js";

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortValue(value[key])]));
  }
  return value;
}

export function digestOf(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function consentGranted(state, rootId, scope = "EXTRA_DATA_USE") {
  const consent = state.consents[`${rootId}|${scope}`];
  return !consent || consent.granted;
}

function stripExtra(value) {
  if (Array.isArray(value)) return value.map(stripExtra);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "extra")
        .map(([key, v]) => [key, stripExtra(v)]),
    );
  }
  return value;
}

function rootChildren(state) {
  const roots = new Set();
  for (const id of Object.keys(state.children)) roots.add(rootOf(state, id));
  return [...roots].sort();
}

// 影响某儿童记录的事件数，作为证明 record_version（单调、确定）。
function recordVersion(state, rootId) {
  const touches = new Set();
  for (const r of Object.values(state.reports)) if (rootOf(state, r.childRecordId) === rootId) touches.add(r.eventId);
  for (const d of state.decisions) {
    const childPart = d.businessKey.split("|")[0];
    if (rootOf(state, childPart) === rootId) touches.add(d.eventId);
  }
  for (const d of Object.values(state.deferrals)) if (rootOf(state, d.childRecordId) === rootId) touches.add(d.eventId);
  if (state.consents[`${rootId}|EXTRA_DATA_USE`]) touches.add(state.consents[`${rootId}|EXTRA_DATA_USE`].eventId);
  for (const m of state.merges) if (rootOf(state, m.targetRecordId) === rootId || rootOf(state, m.sourceRecordId) === rootId) touches.add(m.eventId);
  for (const p of Object.values(state.plans)) if (rootOf(state, p.childRecordId) === rootId) touches.add(p.planEventId);
  const child = state.children[rootId];
  if (child) touches.add(child.eventId);
  return touches.size;
}

// 监护人证明：即使撤回额外数据用途也照常签发。
export function guardianProof(state, childRecordId, seasonId, asOf) {
  const explanation = computeChildStatus(state, childRecordId, seasonId, asOf);
  const rootId = explanation.child_record_id;
  const body = consentGranted(state, rootId) ? explanation : stripExtra(explanation);
  const version = recordVersion(state, rootId);
  const proof = {
    document_type: "CHILD_FLU_DOSE_PROOF",
    record_version: version,
    issued_for_season: seasonId,
    generated_at: asOf,
    body,
    explanation_summary: body.reasons.map((r) => r.text),
  };
  return { ...proof, proof_digest: digestOf({ ...proof, proof_digest: undefined }) };
}

// 学校花名册：只有三桶与查询时刻，不含任何医学细节。
export function schoolRoster(state, seasonId, asOf) {
  return {
    view: "SCHOOL_ROSTER",
    season_id: seasonId,
    generated_at: asOf,
    buckets: ["COMPLETED", "DEFERRED", "NEEDS_VERIFICATION"],
    children: rootChildren(state).map((rootId) => {
      const status = computeChildStatus(state, rootId, seasonId, asOf);
      return {
        child_record_id: rootId,
        result: schoolBucket(status.status),
        record_version: recordVersion(state, rootId),
      };
    }),
  };
}

export function cdcRoster(state, seasonId, asOf) {
  return {
    view: "CDC_OPERATIONAL",
    season_id: seasonId,
    generated_at: asOf,
    children: rootChildren(state).map((rootId) => {
      const explanation = computeChildStatus(state, rootId, seasonId, asOf);
      return consentGranted(state, rootId) ? explanation : stripExtra(explanation);
    }),
  };
}

// 核对队列：所有处于 NEEDS_VERIFICATION 的儿童与候选报告。
export function reconciliationQueue(state, seasonId, asOf) {
  const items = [];
  for (const rootId of rootChildren(state)) {
    const status = computeChildStatus(state, rootId, seasonId, asOf);
    if (status.status === "NEEDS_VERIFICATION") {
      items.push({
        child_record_id: rootId,
        status: status.status,
        conflicts: status.conflicts,
        reasons: status.reasons,
      });
    }
  }
  return { view: "RECONCILIATION_QUEUE", season_id: seasonId, generated_at: asOf, items };
}

// 批次停用影响：事实不删除；找出真实受种者（含停用生效后接种的随访对象），
// 以及尚未执行、应取消/已取消的计划。
export function batchImpact(state, asOf) {
  const asOfInstant = toInstant(asOf);
  const lots = [];
  for (const lotNo of Object.keys(state.lots).sort()) {
    const notice = state.lots[lotNo];
    const effectiveInstant = toInstant(notice.effectiveAt);
    const recipients = Object.values(state.reports)
      .filter((r) => r.lotNo === lotNo)
      .map((r) => ({
        child_record_id: rootOf(state, r.childRecordId),
        report_key: r.reportKey,
        administered_at: r.administeredAt,
        administered_before_notice: toInstant(r.administeredAt) < effectiveInstant,
        administered_by: r.administeredBy,
        follow_up_required: toInstant(r.administeredAt) >= effectiveInstant,
      }))
      .sort((a, b) => a.report_key.localeCompare(b.report_key));
    const pendingPlans = [];
    const cancelledPlans = [];
    for (const plan of Object.values(state.plans)) {
      if (plan.lotNo !== lotNo) continue;
      const item = {
        plan_event_id: plan.planEventId,
        child_record_id: rootOf(state, plan.childRecordId),
        scheduled_at: plan.scheduledAt,
        season_id: plan.seasonId,
      };
      if (plan.cancelled) {
        cancelledPlans.push({
          ...item,
          reason_code: plan.cancelled.reasonCode,
          cancelled_at: plan.cancelled.at,
          cancel_event_id: plan.cancelled.eventId,
        });
      } else if (toInstant(plan.scheduledAt) >= effectiveInstant && toInstant(plan.scheduledAt) <= asOfInstant + 365 * 24 * 3600 * 1000) {
        pendingPlans.push({ ...item, action_required: "CANCEL_OR_RELOT", reason: "批次停用仅影响尚未执行的计划" });
      }
    }
    lots.push({
      lot_no: lotNo,
      suspended_effective_at: notice.effectiveAt,
      reason_code: notice.reasonCode,
      notice_event_id: notice.eventId,
      completed_facts_retained: recipients.length,
      recipients,
      pending_plans: pendingPlans.sort((a, b) => a.plan_event_id.localeCompare(b.plan_event_id)),
      cancelled_plans: cancelledPlans.sort((a, b) => a.plan_event_id.localeCompare(b.plan_event_id)),
    });
  }
  return { view: "BATCH_IMPACT", generated_at: asOf, lots };
}

// 已签发证明审计（PROOF_ISSUED 留痕）。
export function proofAuditLog(state) {
  return {
    view: "PROOF_AUDIT",
    issuances: [...state.proofs].sort((a, b) => a.eventId.localeCompare(b.eventId)),
  };
}

// 数据完整性巡检：折叠层告警之外，找出指向不存在儿童的报告/计划等悬空引用，
// 避免晚登记或错误 ID 让事实在投影中“静默消失”。
export function integrityFindings(state) {
  const findings = [...state.notices];
  for (const r of Object.values(state.reports)) {
    const rootId = rootOf(state, r.childRecordId);
    if (!state.children[rootId]) {
      findings.push({
        code: "ORPHAN_DOSE_REPORT",
        message: `接种报告指向未登记儿童记录 ${rootId}，需先补登记或核对 ID`,
        event_id: r.eventId,
        report_key: r.reportKey,
        child_record_id: rootId,
      });
    }
  }
  for (const plan of Object.values(state.plans)) {
    if (!state.children[rootOf(state, plan.childRecordId)]) {
      findings.push({
        code: "ORPHAN_PLAN",
        message: `接种计划指向未登记儿童记录 ${plan.childRecordId}`,
        event_id: plan.planEventId,
        child_record_id: plan.childRecordId,
      });
    }
  }
  for (const d of state.decisions) {
    const childPart = d.businessKey.split("|")[0];
    if (!state.children[rootOf(state, childPart)]) {
      findings.push({
        code: "ORPHAN_DECISION",
        message: `核对结论指向未登记儿童记录 ${childPart}`,
        event_id: d.eventId,
        business_key: d.businessKey,
      });
    }
  }
  return findings.sort((a, b) => (a.event_id ?? "").localeCompare(b.event_id ?? "") || a.code.localeCompare(b.code));
}
