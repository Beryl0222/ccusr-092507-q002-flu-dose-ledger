// 确定性事件折叠：把乱序、重复、跨机构回传的事件归约为不可变事实台账。
//
// 设计约束：
// - foldEvents 始终在 canonicalOrder（发生时刻、事件标识）下处理；离线乱序
//   回传不影响结果。进程恢复通过重放事件日志重建，而不是按到达顺序增量物化，
//   因此“先折叠部分再恢复追加”与“一次性折叠全量”必然一致。
// - 已发生的接种事实不可删除；重复 event_id 去重，业务键冲突只标记、不裁决。
// - 跨地区合并且只承认授权匹配；姓名永远不出现在匹配键中。
// - 折叠层不做医学判断（状态计算在 status.js），只登记事实、决定、暂缓、同意、计划。

import { toInstant } from "./time.js";

export function emptyState() {
  return {
    schemaVersion: 1,
    eventCount: 0,
    policies: {}, // key: seasonId|guidelineVersion
    children: {}, // recordId -> 登记信息
    aliases: {}, // sourceRecordId -> targetRecordId（授权合并）
    merges: [],
    reports: {}, // key: regionCode|sourceReportId -> 接种报告（不可变事实）
    decisions: [], // 业务键人工核对结论
    lots: {}, // lotNo -> { effectiveAt, reasonCode, eventId }
    deferrals: {}, // deferralEventId -> 暂缓记录，含 cleared
    consents: {}, // childRecordId|scope -> { granted, effectiveAt, eventId }
    plans: {}, // planEventId -> 计划，含 cancelled
    proofs: [],
    notices: [],
    seenEventIds: {}, // event_id -> 规范化内容，用于幂等去重与 id 碰撞检测
  };
}

function notice(state, code, message, refs = {}) {
  state.notices.push({ code, message, ...refs });
}

// 事件定序：发生时刻优先，事件标识兜底。
export function canonicalOrder(events) {
  return [...events].sort((a, b) => {
    const ta = toInstant(a.occurred_at);
    const tb = toInstant(b.occurred_at);
    if (ta !== tb) return ta - tb;
    return a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0;
  });
}

export function rootOf(state, recordId) {
  let current = recordId;
  const seen = new Set();
  while (state.aliases[current] !== undefined) {
    if (seen.has(current)) return current; // 环保护
    seen.add(current);
    current = state.aliases[current];
  }
  return current;
}

export function reportKey(regionCode, sourceReportId) {
  return `${regionCode}|${sourceReportId}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// 同一生效对象多次更新时，取生效时刻更晚者；时刻相同取 event_id 更大者。
function latestByEffective(prev, next) {
  if (!prev) return next;
  if (toInstant(next.effectiveAt) !== toInstant(prev.effectiveAt)) {
    return toInstant(next.effectiveAt) > toInstant(prev.effectiveAt) ? next : prev;
  }
  return next.eventId > prev.eventId ? next : prev;
}

// 同一 (季, 版本) 的发布内容不可变；重发相同内容幂等，内容不同告警并保留先发布者。
function foldPolicy(state, event) {
  const p = event.payload;
  const key = `${p.season_id}|${p.guideline_version}`;
  const incoming = {
    seasonId: p.season_id,
    guidelineVersion: p.guideline_version,
    effectiveAt: p.effective_at,
    rules: p.rules,
    eventId: event.event_id,
    publishedAt: event.occurred_at,
  };
  const existing = state.policies[key];
  if (!existing) {
    state.policies[key] = incoming;
    return;
  }
  if (
    JSON.stringify(existing.rules) !== JSON.stringify(incoming.rules) ||
    existing.effectiveAt !== incoming.effectiveAt
  ) {
    notice(state, "POLICY_VERSION_REDEFINED", `策略版本已发布且内容不同，保留先发布者: ${key}`, {
      event_id: event.event_id,
    });
  }
}

function foldChild(state, event) {
  const p = event.payload;
  const existing = state.children[event.aggregate_id];
  if (existing) {
    if (existing.birthDate !== p.birth_date || existing.homeRegion !== p.home_region_code) {
      notice(state, "CHILD_REDEFINED", `同一儿童记录的登记内容冲突，保留先登记者: ${event.aggregate_id}`, {
        event_id: event.event_id,
      });
    }
    return;
  }
  state.children[event.aggregate_id] = {
    recordId: event.aggregate_id,
    birthDate: p.birth_date,
    homeRegion: p.home_region_code,
    displayName: p.display_name ?? null,
    extra: p.extra ?? null,
    registeredAt: event.occurred_at,
    eventId: event.event_id,
  };
}

function equivalentReport(a, b) {
  return (
    a.product === b.product &&
    a.lotNo === b.lotNo &&
    toInstant(a.administeredAt) === toInstant(b.administeredAt) &&
    a.administeredBy === b.administeredBy
  );
}

function foldDose(state, event) {
  const p = event.payload;
  const key = reportKey(p.region_code, p.source_report_id);
  const incoming = {
    reportKey: key,
    eventId: event.event_id,
    childRecordId: p.child_record_id,
    seasonId: p.season_id,
    doseSeq: p.dose_seq,
    product: p.vaccine_product,
    lotNo: p.lot_no,
    administeredAt: p.administered_at,
    administeredBy: p.administered_by,
    regionCode: p.region_code,
    sourceReportId: p.source_report_id,
    consentEventId: p.consent_event_id ?? null,
    extra: p.extra ?? null,
  };
  const existing = state.reports[key];
  if (existing) {
    if (
      !equivalentReport(existing, incoming) ||
      existing.childRecordId !== incoming.childRecordId ||
      existing.seasonId !== incoming.seasonId ||
      existing.doseSeq !== incoming.doseSeq
    ) {
      notice(state, "REPORT_REDEFINED", `同一机构回传键内容冲突，保留先到事实: ${key}`, {
        event_id: event.event_id,
      });
    }
    return;
  }
  state.reports[key] = incoming;
}

// 成员集合与采信在投影期按当时全部报告重新计算：离线回传可能晚于人工决定。
function foldDecision(state, event) {
  const p = event.payload;
  state.decisions.push({
    eventId: event.event_id,
    businessKey: p.business_key,
    resolution: p.resolution,
    winner:
      p.winning_source_report_id === undefined
        ? null
        : { regionCode: p.winning_region_code ?? null, sourceReportId: p.winning_source_report_id },
    assignments: p.assignments ?? [],
    decidedAt: p.decided_at,
  });
}

function foldMatch(state, event) {
  const p = event.payload;
  const source = p.source_record_id;
  const target = rootOf(state, p.target_record_id);
  if (source === target) {
    notice(state, "MATCH_REDUNDANT", `授权合并的双方已指向同一记录: ${source}`, { event_id: event.event_id });
    return;
  }
  let cursor = target;
  const seen = new Set();
  while (state.aliases[cursor] !== undefined) {
    if (seen.has(cursor) || cursor === source) {
      notice(state, "MATCH_CYCLE", `授权合并将形成环路，已拒绝: ${source} -> ${target}`, {
        event_id: event.event_id,
      });
      return;
    }
    seen.add(cursor);
    cursor = state.aliases[cursor];
  }
  state.aliases[source] = target;
  state.merges.push({
    eventId: event.event_id,
    authorizationId: p.authorization_id,
    sourceRecordId: source,
    targetRecordId: target,
    sourceRegion: p.source_region_code,
    matchedAt: p.matched_at,
  });
}

function foldBatch(state, event) {
  const p = event.payload;
  const incoming = { effectiveAt: p.effective_at, reasonCode: p.reason_code, eventId: event.event_id };
  state.lots[p.lot_no] = latestByEffective(state.lots[p.lot_no], incoming);
}

function foldDeferral(state, event) {
  const p = event.payload;
  if (event.aggregate_type === "child_record" && event.aggregate_id !== p.child_record_id) {
    notice(state, "DEFERRAL_AGGREGATE_MISMATCH", "暂缓事件聚合主体与载荷儿童不一致", { event_id: event.event_id });
  }
  state.deferrals[event.event_id] = {
    deferralEventId: event.event_id,
    childRecordId: p.child_record_id,
    seasonId: p.season_id,
    kind: p.kind,
    reasonCode: p.reason_code,
    effectiveAt: p.effective_at,
    validUntil: p.valid_until ?? null,
    cleared: null,
  };
}

function foldDeferralCleared(state, event) {
  const p = event.payload;
  const d = state.deferrals[p.deferral_event_id];
  if (!d) {
    notice(state, "CLEAR_WITHOUT_DEFERRAL", `清除暂缓找不到原记录: ${p.deferral_event_id}`, {
      event_id: event.event_id,
    });
    return;
  }
  if (d.cleared) return; // 幂等
  d.cleared = { at: p.cleared_at, eventId: event.event_id };
}

function foldConsent(state, event) {
  const p = event.payload;
  const key = `${p.child_record_id}|${p.scope}`;
  const incoming = { granted: p.granted, effectiveAt: p.effective_at, eventId: event.event_id };
  state.consents[key] = latestByEffective(state.consents[key], incoming);
}

function foldPlan(state, event) {
  const p = event.payload;
  state.plans[event.event_id] = {
    planEventId: event.event_id,
    childRecordId: p.child_record_id,
    seasonId: p.season_id,
    doseSeq: p.dose_seq,
    product: p.vaccine_product,
    lotNo: p.lot_no,
    scheduledAt: p.scheduled_at,
    basedOnPolicyVersion: p.based_on_policy_version,
    cancelled: null,
  };
}

function foldPlanCancelled(state, event) {
  const p = event.payload;
  const plan = state.plans[p.plan_event_id];
  if (!plan) {
    notice(state, "CANCEL_WITHOUT_PLAN", `取消计划找不到原计划: ${p.plan_event_id}`, { event_id: event.event_id });
    return;
  }
  if (plan.cancelled) return; // 幂等
  plan.cancelled = { reasonCode: p.reason_code, at: p.cancelled_at, eventId: event.event_id };
}

function foldProof(state, event) {
  const p = event.payload;
  state.proofs.push({
    eventId: event.event_id,
    childRecordId: p.child_record_id,
    seasonId: p.season_id,
    viewerRole: p.viewer_role,
    recordVersion: p.record_version,
    issuedAt: event.occurred_at,
  });
}

const handlers = {
  POLICY_PUBLISHED: foldPolicy,
  CHILD_REGISTERED: foldChild,
  DOSE_RECORDED: foldDose,
  DOSE_REPORTS_RECONCILED: foldDecision,
  RECORD_MATCHED: foldMatch,
  BATCH_SUSPENDED: foldBatch,
  DEFERRAL_RECORDED: foldDeferral,
  DEFERRAL_CLEARED: foldDeferralCleared,
  CONSENT_UPDATED: foldConsent,
  PLAN_PROPOSED: foldPlan,
  PLAN_CANCELLED: foldPlanCancelled,
  PROOF_ISSUED: foldProof,
};

export function foldEvents(events, state = emptyState()) {
  for (const event of canonicalOrder(events)) {
    const signature = stableStringify(event);
    const seen = state.seenEventIds[event.event_id];
    if (seen !== undefined) {
      // 相同内容是幂等重投（离线重传/日终重跑），必须静默无操作；
      // 同一 event_id 却内容不同属于标识碰撞，需人工介入。
      if (seen !== signature) {
        notice(state, "EVENT_ID_COLLISION", `同一事件标识对应不同内容，保留首次内容: ${event.event_id}`, {
          event_id: event.event_id,
        });
      }
      continue;
    }
    state.seenEventIds[event.event_id] = signature;
    const handler = handlers[event.event_type];
    if (!handler) {
      notice(state, "UNKNOWN_EVENT_TYPE", `折叠层不认识的事件类型: ${event.event_type}`, {
        event_id: event.event_id,
      });
      continue;
    }
    handler(state, event);
    state.eventCount += 1;
  }
  state.notices.sort(
    (a, b) => (a.event_id ?? "").localeCompare(b.event_id ?? "") || a.code.localeCompare(b.code),
  );
  return state;
}
