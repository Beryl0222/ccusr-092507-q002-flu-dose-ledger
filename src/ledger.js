import { canonicalize, compareStrings } from "./util.js";

/**
 * 事件归并顺序：先按发生时刻，再按事件标识。
 * 离线回传乱序不影响结果；同一输入集合无论到达顺序如何，归并出的台账相同。
 */
export function compareEvents(left, right) {
  const byTime = Date.parse(left.occurred_at) - Date.parse(right.occurred_at);
  if (byTime !== 0) return byTime;
  return compareStrings(left.event_id, right.event_id);
}

function newChild() {
  return {
    birth_date: null,
    home_region: null,
    consents: {},
    deferrals: new Map(),
    matches: [],
    record_version: 0,
  };
}

/**
 * 把事件日志归并为台账。纯函数：相同事件集合必得相同台账，
 * 因此并发补录、进程崩溃后重放日志都能得到一致结果。
 *
 * 幂等约定：
 * - 同一 event_id 携带相同内容重复送达 → 跳过并计入 duplicate_deliveries；
 * - 同一 event_id 携带不同内容 → 保留先到版本，记入 issues，交由人工核对。
 */
export function buildLedger(events) {
  const sorted = [...events].sort(compareEvents);
  const seen = new Map();
  const ledger = {
    policies: new Map(),
    children: new Map(),
    doses: [],
    plans: [],
    suspensions: [],
    reconciliations: [],
    issues: [],
    duplicate_deliveries: 0,
    event_count: 0,
    accepted: [],
  };
  const childOf = (id) => {
    if (!ledger.children.has(id)) ledger.children.set(id, newChild());
    return ledger.children.get(id);
  };
  for (const event of sorted) {
    const canon = canonicalize(event);
    const previous = seen.get(event.event_id);
    if (previous !== undefined) {
      if (previous === canon) {
        ledger.duplicate_deliveries += 1;
      } else {
        ledger.issues.push({
          code: "event_id_conflict",
          event_id: event.event_id,
          message: "同一事件标识携带不同内容，已保留先到的版本",
        });
      }
      continue;
    }
    seen.set(event.event_id, canon);
    ledger.event_count += 1;
    ledger.accepted.push(event);
    applyEvent(ledger, childOf, event);
  }
  return ledger;
}

function applyEvent(ledger, childOf, event) {
  const payload = event.payload ?? {};
  switch (event.event_type) {
    case "POLICY_PUBLISHED": {
      const list = ledger.policies.get(event.aggregate_id) ?? [];
      list.push({ event_id: event.event_id, occurred_at: event.occurred_at, version: event.version, ...payload });
      ledger.policies.set(event.aggregate_id, list);
      break;
    }
    case "CHILD_REGISTERED": {
      const child = childOf(event.aggregate_id);
      child.birth_date = payload.birth_date ?? child.birth_date;
      child.home_region = payload.home_region ?? child.home_region;
      child.record_version += 1;
      break;
    }
    case "CONSENT_RECORDED": {
      const child = childOf(event.aggregate_id);
      child.consents[payload.scope] = { granted: payload.granted === true, at: event.occurred_at };
      child.record_version += 1;
      break;
    }
    case "DEFERRAL_RECORDED": {
      const child = childOf(event.aggregate_id);
      child.deferrals.set(payload.season_id, {
        reason_kind: payload.reason_kind,
        until: payload.until ?? null,
        at: event.occurred_at,
      });
      child.record_version += 1;
      break;
    }
    case "DOSE_RECORDED": {
      ledger.doses.push({
        event_id: event.event_id,
        occurred_at: event.occurred_at,
        child_ref: payload.child_ref,
        origin: payload.origin ?? "local",
        source_region: payload.source_region ?? null,
        season_id: payload.season_id,
        dose_seq: payload.dose_seq,
        administered_at: payload.administered_at,
        product: payload.product ?? null,
        lot_no: payload.lot_no,
        executor_id: payload.executor_id ?? null,
        consent_ref: payload.consent_ref ?? null,
      });
      if ((payload.origin ?? "local") !== "external") childOf(payload.child_ref).record_version += 1;
      break;
    }
    case "RECORD_MATCHED": {
      const child = childOf(event.aggregate_id);
      child.matches.push({
        external_ref: payload.external_ref,
        source_region: payload.source_region,
        match_auth_id: payload.match_auth_id,
        at: event.occurred_at,
      });
      child.record_version += 1;
      break;
    }
    case "DOSE_RECONCILED": {
      ledger.reconciliations.push({
        child_id: event.aggregate_id,
        season_id: payload.season_id,
        dose_seq: payload.dose_seq,
        kept_event_id: payload.kept_event_id,
        at: event.occurred_at,
      });
      childOf(event.aggregate_id).record_version += 1;
      break;
    }
    case "PLAN_CREATED": {
      ledger.plans.push({
        event_id: event.event_id,
        child_id: payload.child_id,
        season_id: payload.season_id,
        lot_no: payload.lot_no,
        planned_for: payload.planned_for,
        at: event.occurred_at,
      });
      break;
    }
    case "BATCH_SUSPENDED": {
      ledger.suspensions.push({
        event_id: event.event_id,
        lot_no: payload.lot_no,
        effective_at: payload.effective_at,
        reason: payload.reason ?? null,
        at: event.occurred_at,
      });
      break;
    }
    case "PROOF_ISSUED":
      break; // 出具证明是只读动作的事实记录，不改变任何状态
    default:
      break; // 未知类型已在契约校验层被拒绝
  }
}

/** 某流行季最新发布的政策（指南改版后取后到的版本）。 */
export function latestPolicy(ledger, seasonId) {
  const list = ledger.policies.get(seasonId);
  if (!list || list.length === 0) return null;
  return list[list.length - 1];
}

/**
 * 把一条剂次事实归属到本地儿童档案。
 * 异地记录必须存在携带授权编号（match_auth_id）的 RECORD_MATCHED 才能合并；
 * 不做姓名或标识符的字面去重——child_ref 与本地档案号字面相同也不隐含同一儿童。
 */
export function resolveChildId(ledger, dose) {
  if (dose.origin !== "external") return dose.child_ref;
  for (const [childId, child] of ledger.children) {
    const matched = child.matches.some(
      (match) => match.external_ref === dose.child_ref && match.source_region === dose.source_region,
    );
    if (matched) return childId;
  }
  return null;
}
