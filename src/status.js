import { DAY_MS, ageYears, compareStrings, toDateUTC } from "./util.js";
import { latestPolicy, resolveChildId } from "./ledger.js";

/** 指南缺省参数；政策事件可携带同名字段覆盖。 */
export const POLICY_DEFAULTS = {
  single_dose_min_age_years: 9,
  prior_doses_for_single: 2,
  min_interval_days: 28,
  protection_onset_days: 14,
  protection_duration_days: 240,
};

const STATUS_LABEL = {
  completed: "完成",
  deferred: "暂缓",
  in_progress: "待接种",
  needs_review: "需核验",
};

const byArrival = (left, right) =>
  Date.parse(left.occurred_at) - Date.parse(right.occurred_at) || compareStrings(left.event_id, right.event_id);

/** 剂次事实的核对签名：业务键（儿童+流行季+剂次序号）之外，批号、时间、执行人、品种任一不同即构成冲突。 */
function factSignature(fact) {
  return JSON.stringify([fact.lot_no, fact.administered_at, fact.executor_id, fact.product]);
}

/**
 * 归并一名儿童在某流行季的全部剂次事实：
 * - 完全同内容的多条记录（离线重发）去重，只计最早一条；
 * - 业务键相同但批号/时间/执行人/品种不同 → 冲突，全部排除出计数，等待 DOSE_RECONCILED；
 * - 和解事件指定保留哪条事实，其余标记 superseded。已完成的事实永不删除，只是不再计入。
 */
export function resolveDoseFacts(ledger, childId, seasonId) {
  const facts = ledger.doses.filter(
    (dose) => dose.season_id === seasonId && resolveChildId(ledger, dose) === childId,
  );
  const bySeq = new Map();
  for (const fact of facts) {
    const key = String(fact.dose_seq);
    if (!bySeq.has(key)) bySeq.set(key, []);
    bySeq.get(key).push(fact);
  }
  const counted = [];
  const excluded = [];
  const conflicts = [];
  for (const [seq, group] of [...bySeq.entries()].sort(([a], [b]) => compareStrings(a, b))) {
    const classes = new Map();
    for (const fact of group) {
      const sig = factSignature(fact);
      if (!classes.has(sig)) classes.set(sig, []);
      classes.get(sig).push(fact);
    }
    const reconciliation = [...ledger.reconciliations]
      .reverse()
      .find((item) => item.child_id === childId && item.season_id === seasonId && String(item.dose_seq) === seq);
    if (reconciliation) {
      const kept = group.find((fact) => fact.event_id === reconciliation.kept_event_id);
      if (!kept) {
        for (const fact of group) excluded.push({ fact, reason: "reconcile_target_missing" });
        continue;
      }
      const keptSig = factSignature(kept);
      for (const [sig, members] of classes) {
        const sorted = [...members].sort(byArrival);
        if (sig === keptSig) {
          counted.push(sorted[0]);
          for (const fact of sorted.slice(1)) excluded.push({ fact, reason: "duplicate" });
        } else {
          for (const fact of sorted) excluded.push({ fact, reason: "superseded" });
        }
      }
    } else if (classes.size > 1) {
      conflicts.push(seq);
      for (const members of classes.values()) {
        for (const fact of members) excluded.push({ fact, reason: "conflict_unresolved" });
      }
    } else {
      const sorted = [...classes.values()][0].sort(byArrival);
      counted.push(sorted[0]);
      for (const fact of sorted.slice(1)) excluded.push({ fact, reason: "duplicate" });
    }
  }
  counted.sort((a, b) => Date.parse(a.administered_at) - Date.parse(b.administered_at) || compareStrings(a.event_id, b.event_id));
  return { counted, excluded, conflicts };
}

function isConsented(child, fact) {
  return child?.consents?.vaccination?.granted === true || Boolean(fact.consent_ref);
}

/** 既往剂次：本季开始之前、其他流行季中已同意且未冲突的有效剂次数。 */
function countPriorDoses(ledger, childId, seasonStart, currentSeasonId) {
  const child = ledger.children.get(childId);
  const seasons = new Set(
    ledger.doses.filter((dose) => resolveChildId(ledger, dose) === childId).map((dose) => dose.season_id),
  );
  let total = 0;
  for (const seasonId of seasons) {
    if (seasonId === currentSeasonId) continue;
    const { counted, conflicts } = resolveDoseFacts(ledger, childId, seasonId);
    if (conflicts.length > 0) continue; // 有未决冲突的既往季不计入，由本季核验流程处理
    total += counted.filter((fact) => isConsented(child, fact) && fact.administered_at < seasonStart).length;
  }
  return total;
}

function activeDeferral(child, seasonId, asOf, effective) {
  const deferral = child?.deferrals?.get(seasonId);
  if (!deferral) return null;
  if (deferral.until && deferral.until < asOf) return null;
  const last = effective[effective.length - 1];
  if (last && Date.parse(last.administered_at) > Date.parse(deferral.at)) return null; // 暂缓之后已有接种事实
  return deferral;
}

function protectionWindow(policy, lastFact, complete) {
  const onset = Date.parse(lastFact.administered_at) + policy.protection_onset_days * DAY_MS;
  return {
    from: toDateUTC(onset),
    to: toDateUTC(onset + policy.protection_duration_days * DAY_MS),
    complete,
  };
}

/**
 * 计算一名儿童在某流行季、某个日终日（as_of，YYYY-MM-DD）的状态。
 * 返回对象自带解释：采用了哪版指南、哪条政策事件、哪些有效剂次事实、哪些事实被排除及原因。
 * “建议完成日期”只是建议：逾期状态仍给出可接种指引，绝不解释为禁止接种。
 */
export function computeChildStatus(ledger, childId, seasonId, asOf) {
  const child = ledger.children.get(childId) ?? null;
  const policyEvent = latestPolicy(ledger, seasonId);
  const policy = policyEvent ? { ...POLICY_DEFAULTS, ...policyEvent } : null;
  const reasons = [];
  if (!policy) reasons.push("policy_missing");
  if (!child?.birth_date) reasons.push("birth_date_missing");

  const { counted, excluded, conflicts } = resolveDoseFacts(ledger, childId, seasonId);
  if (conflicts.length > 0) reasons.push("dose_conflict");

  const effective = [];
  if (policy) {
    for (const fact of counted) {
      if (!isConsented(child, fact)) {
        excluded.push({ fact, reason: "consent_missing" });
        continue;
      }
      const last = effective[effective.length - 1];
      if (last && Date.parse(fact.administered_at) - Date.parse(last.administered_at) < policy.min_interval_days * DAY_MS) {
        excluded.push({ fact, reason: "interval_too_short" });
        continue;
      }
      effective.push(fact);
    }
  }
  if (excluded.some((item) => item.reason === "consent_missing")) reasons.push("consent_missing");

  const age = policy && child?.birth_date ? ageYears(child.birth_date, policy.season_start) : null;
  const prior = policy ? countPriorDoses(ledger, childId, policy.season_start, seasonId) : 0;
  const required =
    policy && age !== null
      ? age >= policy.single_dose_min_age_years || prior >= policy.prior_doses_for_single
        ? 1
        : 2
      : null;

  const explanation = {
    guideline_version: policy?.guideline_version ?? null,
    policy_event_id: policy?.event_id ?? null,
    policy_version: policy?.version ?? null,
    age_at_season_start: age,
    prior_doses: prior,
    required_doses: required,
    counted_fact_event_ids: effective.map((fact) => fact.event_id),
    excluded_facts: excluded
      .map((item) => ({ event_id: item.fact.event_id, reason: item.reason }))
      .sort((a, b) => compareStrings(a.event_id, b.event_id)),
    as_of: asOf,
  };

  const result = {
    child_id: childId,
    season_id: seasonId,
    explanation,
  };

  if (reasons.length > 0) {
    result.status = "needs_review";
    result.review_reasons = reasons;
  } else if (effective.length >= required) {
    result.status = "completed";
    result.protection = protectionWindow(policy, effective[effective.length - 1], true);
  } else {
    const deferral = activeDeferral(child, seasonId, asOf, effective);
    if (deferral) {
      result.status = "deferred";
      result.deferral = {
        reason_kind: deferral.reason_kind,
        until: deferral.until,
        disposition:
          deferral.reason_kind === "medical_contraindication"
            ? "医学禁忌：暂停催种，须经医学评估清除后方可接种"
            : "普通暂缓：流行季内仍可预约接种，按常规催种",
      };
    } else {
      result.status = "in_progress";
      const last = effective[effective.length - 1] ?? null;
      result.remaining_doses = required - effective.length;
      result.next_due = last ? toDateUTC(Date.parse(last.administered_at) + policy.min_interval_days * DAY_MS) : asOf;
      result.advisory_complete_by = policy.advisory_complete_by;
      result.advisory_only = true; // 建议日期仅为建议，不构成接种禁令
      result.advisory_passed = asOf > policy.advisory_complete_by;
      result.can_vaccinate = asOf <= policy.season_end;
    }
    if (effective.length > 0) {
      result.protection = protectionWindow(policy, effective[effective.length - 1], false);
    }
  }
  result.status_label = STATUS_LABEL[result.status];
  return result;
}
