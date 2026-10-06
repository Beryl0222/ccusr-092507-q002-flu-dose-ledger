// 状态计算：给定折叠后的台账、儿童、流行季与查询时刻，得出当前剂次状态。
//
// 关键语义：
// - “建议十月底前完成”只是推荐期限；过期后状态为迟到（仍可接种），
//   只有流行季结束才关账 CLOSED_INCOMPLETE。系统任何位置都不产生“过期禁种”。
// - 医学禁忌 MEDICAL_CONTRAINDICATION 与普通暂缓 TEMPORARY_DEFERRAL 分桶处置。
// - 已完成的接种事实不删除；间隔不足、停用批号等只影响“是否计数/随访”，事实保留。
// - 同一业务键多份未裁决报告、裁决无法唯一采信、跨季史冲突 → NEEDS_VERIFICATION。
// 全部输出携带所用策略版本与有效事实清单，供证明与审计解释。

import { addDays, addMonths, ageInMonths, calendarDay, diffDays, protectionWindow, toInstant } from "./time.js";
import { reportKey, rootOf } from "./fold.js";

const TZ = "Asia/Shanghai";

export function selectPolicy(state, seasonId, asOfInstant) {
  const candidates = Object.values(state.policies)
    .filter((p) => p.seasonId === seasonId && toInstant(p.effectiveAt) <= asOfInstant)
    .sort((a, b) => {
      if (toInstant(a.effectiveAt) !== toInstant(b.effectiveAt)) return toInstant(b.effectiveAt) - toInstant(a.effectiveAt);
      // 同一生效时刻：先登记者优先（event_id 升序），保证改版并发发布时确定。
      return a.eventId < b.eventId ? -1 : 1;
    });
  return candidates[0] ?? null;
}

function latestDecisionFor(state, rootId, seasonId, seq, asOfInstant) {
  const decisions = state.decisions
    .filter((d) => {
      const [childPart, seasonPart, seqPart] = d.businessKey.split("|");
      return rootOf(state, childPart) === rootId && seasonPart === seasonId && seqPart === seq;
    })
    .filter((d) => toInstant(d.decidedAt) <= asOfInstant)
    .sort((a, b) => toInstant(b.decidedAt) - toInstant(a.decidedAt) || (a.eventId < b.eventId ? -1 : 1));
  return decisions[0] ?? null;
}

function seasonReports(state, rootId, seasonId) {
  return Object.values(state.reports)
    .filter((r) => rootOf(state, r.childRecordId) === rootId && r.seasonId === seasonId)
    .sort((a, b) => a.reportKey.localeCompare(b.reportKey));
}

function pickWinner(members, decision) {
  if (!decision.winner) return { error: { code: "DECISION_WINNER_MISSING", text: "已确认为重复接种，但核对结论未指定采信报告" } };
  const { regionCode, sourceReportId } = decision.winner;
  const candidates = regionCode
    ? members.filter((m) => m.reportKey === reportKey(regionCode, sourceReportId))
    : members.filter((m) => m.sourceReportId === sourceReportId);
  if (candidates.length !== 1) {
    return { error: { code: "DECISION_WINNER_UNRESOLVED", text: `采信报告无法在 ${members.length} 份同业务键记录中唯一确定` } };
  }
  return { winner: candidates[0] };
}

// 整季对账：按报告自报剂位分组套用最新人工决定，输出每剂位的有效事实与冲突。
function reconcileSeason(state, rootId, seasonId, asOfInstant) {
  const reports = seasonReports(state, rootId, seasonId);
  const rawGroups = new Map();
  for (const r of reports) {
    if (!rawGroups.has(r.doseSeq)) rawGroups.set(r.doseSeq, []);
    rawGroups.get(r.doseSeq).push(r);
  }
  const slots = new Map(); // seq -> { fact, duplicates: [] }
  const conflicts = [];
  const place = (seq, fact, duplicates = []) => {
    const existing = slots.get(seq);
    if (!existing) {
      slots.set(seq, { fact, duplicates });
    } else {
      conflicts.push({
        dose_seq: seq,
        candidate_report_keys: [existing.fact.reportKey, fact.reportKey, ...duplicates.map((d) => d.reportKey)].sort(),
        reasons: [{ code: "DOSE_SLOT_COLLISION", text: `第${seq}剂在核对重派后出现多份有效报告，需再次核对` }],
      });
    }
  };

function sameContent(a, b) {
  return a.product === b.product && a.lotNo === b.lotNo && toInstant(a.administeredAt) === toInstant(b.administeredAt) && a.administeredBy === b.administeredBy;
}

function autoEquivalentDuplicates(members) {
  const first = members[0];
  return members.slice(1).every((m) => sameContent(first, m));
}

  for (const [rawSeq, members] of rawGroups) {
    const decision = latestDecisionFor(state, rootId, seasonId, rawSeq, asOfInstant);
    if (members.length === 1 && (!decision || decision.resolution !== "CONFIRMED_DUPLICATE")) {
      place(rawSeq, members[0]);
      continue;
    }
    // 内容完全一致的重复回传（同批号/同时间/同执行人）安全自动去重；
    // 任何内容差异都必须等待人工核对决定。
    if (members.length > 1 && !decision && autoEquivalentDuplicates(members)) {
      place(rawSeq, members[0], members.slice(1));
      continue;
    }
    if (decision?.resolution === "CONFIRMED_DUPLICATE") {
      const { winner, error } = pickWinner(members, decision);
      if (error) {
        conflicts.push({ dose_seq: rawSeq, candidate_report_keys: members.map((m) => m.reportKey), reasons: [error] });
      } else {
        place(rawSeq, winner, members.filter((m) => m.reportKey !== winner.reportKey));
      }
      continue;
    }
    if (decision?.resolution === "DISTINCT_DOSES") {
      // 人工确认是两次真实接种：按 assignments 各归其剂位；未指派的保留原位。
      let unresolved = false;
      const reasons = [];
      for (const member of members) {
        const assignment = decision.assignments.find(
          (a) => (a.region_code ? reportKey(a.region_code, a.source_report_id) : null) === member.reportKey
            || (!a.region_code && a.source_report_id === member.sourceReportId),
        );
        if (!assignment) {
          unresolved = true;
          reasons.push({ code: "DISTINCT_ASSIGNMENT_MISSING", text: `确认为两次不同接种，但报告 ${member.reportKey} 未指派剂次` });
          continue;
        }
        place(assignment.dose_seq, member);
      }
      if (unresolved) conflicts.push({ dose_seq: rawSeq, candidate_report_keys: members.map((m) => m.reportKey), reasons });
      continue;
    }
    conflicts.push({
      dose_seq: rawSeq,
      candidate_report_keys: members.map((m) => m.reportKey),
      reasons: [{ code: "DOSE_REPORTS_CONFLICT", text: `同一业务键（儿童|流行季|第${rawSeq}剂）存在 ${members.length} 份批号/时间/执行人不同的报告，等待核对` }],
    });
  }
  return { slots, conflicts, reports };
}

function lotSuspendedAt(state, lotNo, administeredInstant) {
  const lot = state.lots[lotNo];
  return lot && toInstant(lot.effectiveAt) <= administeredInstant ? lot : null;
}

// 评估单份事实是否计数；事实永不删除，不计数时只加标注。
function annotateFact(state, entry, previousDoseDay, policy, asOfInstant) {
  const fact = entry.fact;
  const flags = [...entry.duplicates.map((d) => ({
    code: "DUPLICATE_REPORT_RETAINED",
    text: `重复回传已核对确认，采信 ${fact.reportKey}；报告 ${d.reportKey} 作为留痕保留，不重复计数`,
    report_key: d.reportKey,
  }))];
  let counts = true;
  const administeredDay = calendarDay(fact.administeredAt, TZ);
  if (previousDoseDay) {
    const minInterval = policy.rules.min_interval_days_for_second_dose;
    if (minInterval !== undefined && diffDays(administeredDay, previousDoseDay) < minInterval) {
      counts = false;
      flags.push({
        code: "DOSE_INTERVAL_TOO_SHORT",
        text: `与上一剂间隔不足 ${minInterval} 天，按策略 ${policy.guidelineVersion} 该剂不计数、需补种；原始接种事实保留`,
      });
    }
  }
  const suspended = lotSuspendedAt(state, fact.lotNo, toInstant(fact.administeredAt));
  if (suspended) {
    flags.push({ code: "LOT_SUSPENDED_RECIPIENT", text: `使用批号 ${fact.lotNo} 接种时该批号已停用，列入真实受种者随访`, lot_event_id: suspended.eventId });
  }
  return { fact, administeredDay, counts, flags };
}

function activeDeferral(state, rootId, seasonId, asOfInstant, asOfDay) {
  const list = Object.values(state.deferrals)
    .filter((d) => rootOf(state, d.childRecordId) === rootId && d.seasonId === seasonId)
    .filter((d) => toInstant(d.effectiveAt) <= asOfInstant)
    .filter((d) => !d.cleared || toInstant(d.cleared.at) > asOfInstant)
    .sort((a, b) => toInstant(b.effectiveAt) - toInstant(a.effectiveAt));
  for (const d of list) {
    if (d.kind === "TEMPORARY_DEFERRAL" && d.validUntil && d.validUntil < asOfDay) continue; // 暂缓到期自动失效
    return d;
  }
  return null;
}

function priorSeasonStatus(state, rootId, seasonId, asOfInstant) {
  const seasonIds = new Set(
    Object.values(state.reports).filter((r) => rootOf(state, r.childRecordId) === rootId).map((r) => r.seasonId),
  );
  let count = 0;
  let uncertain = false;
  const facts = [];
  for (const priorSeason of [...seasonIds].sort()) {
    if (priorSeason >= seasonId) continue; // 季标识采用起始年字符串，字典序即时间序
    const { slots, conflicts } = reconcileSeason(state, rootId, priorSeason, asOfInstant);
    if (conflicts.length > 0) uncertain = true;
    for (const seq of [...slots.keys()].sort()) {
      count += 1;
      facts.push({ season_id: priorSeason, dose_seq: seq, report_key: slots.get(seq).fact.reportKey });
    }
  }
  return { count, uncertain, facts };
}

function matchScheduleRow(rules, ageMonthsAtAgeAsOf, ageMonthsNow, priorDoseCount) {
  const rows = rules.schedule ?? [];
  const match = (age) =>
    rows.find((row) => {
      if (row.min_age_months !== undefined && age < row.min_age_months) return false;
      if (row.max_age_months_exclusive !== undefined && age >= row.max_age_months_exclusive) return false;
      if (row.min_prior_season_doses !== undefined && priorDoseCount < row.min_prior_season_doses) return false;
      if (row.max_prior_season_doses !== undefined && priorDoseCount > row.max_prior_season_doses) return false;
      return true;
    });
  // 以策略规定的年龄基准日选档；基准日尚未出生/不足龄时回退当前龄，资格门控另算。
  return match(ageMonthsAtAgeAsOf) ?? match(ageMonthsNow) ?? null;
}

export function computeChildStatus(state, childRecordId, seasonId, asOf = new Date().toISOString()) {
  const asOfInstant = toInstant(asOf);
  const asOfDay = calendarDay(asOf, TZ);
  const queriedId = childRecordId;
  const rootId = rootOf(state, childRecordId);
  const child = state.children[rootId] ?? state.children[childRecordId];
  const explanation = {
    child_record_id: rootId,
    queried_record_id: queriedId === rootId ? rootId : queriedId,
    season_id: seasonId,
    as_of: asOf,
    as_of_day: asOfDay,
    status: null,
    policy: null,
    required_doses: null,
    schedule_row: null,
    prior_facts: [],
    valid_facts: [],
    retained_facts: [],
    conflicts: [],
    active_deferral: null,
    consent_extra_data_use: null,
    recommended_complete_by: null,
    late: false,
    next_action: null,
    protection: null,
    reasons: [],
  };

  const consent = state.consents[`${rootId}|EXTRA_DATA_USE`];
  explanation.consent_extra_data_use = consent
    ? { granted: consent.granted, effective_at: consent.effectiveAt }
    : { granted: true, effective_at: null, note: "未登记撤回，默认仅最小化用途" };

  const policy = selectPolicy(state, seasonId, asOfInstant);
  if (!policy) {
    explanation.status = "NEEDS_VERIFICATION";
    explanation.reasons.push({ code: "POLICY_MISSING", text: `流行季 ${seasonId} 在查询时刻没有已生效的接种策略版本` });
    return explanation;
  }
  explanation.policy = { season_id: policy.seasonId, guideline_version: policy.guidelineVersion, effective_at: policy.effectiveAt };
  explanation.recommended_complete_by = policy.rules.recommended_complete_by;

  if (!child) {
    explanation.status = "NEEDS_VERIFICATION";
    explanation.reasons.push({ code: "CHILD_NOT_REGISTERED", text: "找不到儿童登记记录，无法按年龄与既往剂次判定" });
    return explanation;
  }

  const ageNow = ageInMonths(child.birthDate, asOfDay);
  const ageAtAgeAsOf = ageInMonths(child.birthDate, policy.rules.age_as_of);
  const prior = priorSeasonStatus(state, rootId, seasonId, asOfInstant);
  explanation.prior_facts = prior.facts;

  // 起种月龄门控先于程序行匹配：不足龄 → 尚未到龄（不是“不适用”）。
  const minAge = policy.rules.min_age_months;
  if (minAge !== undefined && ageNow < minAge) {
    explanation.status = "NOT_YET_ELIGIBLE";
    explanation.next_action = { eligible_on: addMonths(child.birthDate, minAge), note: `满 ${minAge} 月龄后起种` };
    explanation.reasons.push({ code: "UNDER_MIN_AGE", text: `当前 ${ageNow} 月龄，未满 ${minAge} 月龄；到龄后仍按本季策略接种` });
    return explanation;
  }

  if (prior.uncertain) {
    explanation.status = "NEEDS_VERIFICATION";
    explanation.reasons.push({ code: "PRIOR_HISTORY_CONFLICT", text: "既往流行季接种史存在未核对冲突，无法确定本季应种剂次" });
    return explanation;
  }

  const row = matchScheduleRow(policy.rules, ageAtAgeAsOf, ageNow, prior.count);
  if (!row) {
    explanation.status = "NOT_APPLICABLE";
    explanation.reasons.push({ code: "NO_SCHEDULE_ROW", text: `策略 ${policy.guidelineVersion} 中没有适用于该年龄/既往剂次的接种程序行` });
    return explanation;
  }
  explanation.schedule_row = row.id ?? null;
  explanation.required_doses = row.dose_count;

  const { slots, conflicts } = reconcileSeason(state, rootId, seasonId, asOfInstant);
  explanation.conflicts = conflicts;
  for (const c of conflicts) explanation.reasons.push(...c.reasons);

  let previousDay = null;
  const countingDays = [];
  for (const seq of Array.from({ length: row.dose_count }, (_, i) => String(i + 1))) {
    const entry = slots.get(seq);
    if (!entry) continue;
    const annotated = annotateFact(state, entry, previousDay, policy, asOfInstant);
    explanation.retained_facts.push({
      dose_seq: seq,
      report_key: annotated.fact.reportKey,
      lot_no: annotated.fact.lotNo,
      administered_at: annotated.fact.administeredAt,
      administered_by: annotated.fact.administeredBy,
      counts: annotated.counts,
      flags: annotated.flags,
    });
    if (annotated.counts) {
      explanation.valid_facts.push({ dose_seq: seq, report_key: annotated.fact.reportKey, administered_day: annotated.administeredDay });
      countingDays.push(annotated.administeredDay);
      previousDay = annotated.administeredDay;
    }
  }
  if (conflicts.length > 0) {
    explanation.status = "NEEDS_VERIFICATION";
    return explanation;
  }

  const complete = countingDays.length >= row.dose_count;
  const deferral = activeDeferral(state, rootId, seasonId, asOfInstant, asOfDay);
  if (complete) {
    explanation.status = "COMPLETE";
    const finalDay = countingDays.at(-1);
    const window = protectionWindow(finalDay, policy.rules.onset_days_after_final_dose, policy.rules.season_end);
    explanation.protection = {
      state: asOfDay >= window.start ? "ACTIVE" : "EXPECTED",
      starts_on: window.start,
      ends_on: window.end,
      based_on_final_dose_day: finalDay,
      onset_days_after_final_dose: policy.rules.onset_days_after_final_dose,
    };
    explanation.reasons.push({ code: "COMPLETE", text: `本季要求 ${row.dose_count} 剂，已完成 ${countingDays.length} 剂；按策略 ${policy.guidelineVersion} 预计 ${window.start} 起形成保护，保护窗至 ${window.end}` });
    return explanation;
  }

  if (deferral?.kind === "MEDICAL_CONTRAINDICATION") {
    explanation.status = "DEFERRED_MEDICAL";
    explanation.active_deferral = {
      kind: deferral.kind,
      reason_code: deferral.reasonCode,
      effective_at: deferral.effectiveAt,
      detail_withheld_from_school: true,
    };
    explanation.reasons.push({ code: "MEDICAL_CONTRAINDICATION_ACTIVE", text: "存在生效中的医学禁忌，不予接种；禁忌细节不进入学校视图" });
    return explanation;
  }

  if (asOfDay > policy.rules.season_end) {
    explanation.status = "CLOSED_INCOMPLETE";
    explanation.reasons.push({
      code: "SEASON_ENDED",
      text: `流行季已于 ${policy.rules.season_end} 结束，未完成剂次不再补种；这是季节关账，不是“过期禁种”规则`,
    });
    return explanation;
  }

  if (deferral?.kind === "TEMPORARY_DEFERRAL") {
    explanation.status = "DEFERRED_TEMPORARY";
    explanation.active_deferral = {
      kind: deferral.kind,
      reason_code: deferral.reasonCode,
      effective_at: deferral.effectiveAt,
      valid_until: deferral.validUntil,
      detail_withheld_from_school: true,
    };
    const nextSeq = String(countingDays.length + 1);
    explanation.next_action = {
      dose_seq: nextSeq,
      not_before: deferral.validUntil ?? addDays(asOfDay, 1),
      still_allowed_after_recommended_by: true,
      season_end: policy.rules.season_end,
    };
    explanation.reasons.push({ code: "TEMPORARY_DEFERRAL_ACTIVE", text: "存在生效中的临时暂缓（如患病/用药期），暂缓到期后尽快接种；迟于建议期限仍可接种" });
    return explanation;
  }

  const nextSeq = String(countingDays.length + 1);
  let notBefore = asOfDay;
  const minInterval = policy.rules.min_interval_days_for_second_dose;
  if (countingDays.length >= 1 && minInterval !== undefined) {
    notBefore = addDays(countingDays.at(-1), minInterval);
  }
  const waitingInterval = notBefore > asOfDay;
  const late = asOfDay > policy.rules.recommended_complete_by;
  explanation.late = late;
  explanation.next_action = {
    dose_seq: nextSeq,
    not_before: notBefore,
    recommended_complete_by: policy.rules.recommended_complete_by,
    still_allowed_after_recommended_by: true,
    season_end: policy.rules.season_end,
  };
  if (waitingInterval) {
    explanation.status = "WAITING_INTERVAL";
    explanation.reasons.push({ code: "INTERVAL_NOT_MET", text: `第${nextSeq}剂最早 ${notBefore} 接种（需满足最小间隔 ${minInterval} 天）` });
  } else if (countingDays.length >= 1) {
    explanation.status = "IN_PROGRESS";
    explanation.reasons.push({ code: "NEXT_DOSE_DUE", text: `第${nextSeq}剂待接种` });
  } else {
    explanation.status = "DUE";
    explanation.reasons.push({ code: "FIRST_DOSE_DUE", text: "本季尚未接种，第1剂待接种" });
  }
  if (late) {
    explanation.reasons.push({
      code: "PAST_RECOMMENDED_DEADLINE",
      text: `已晚于建议完成日 ${policy.rules.recommended_complete_by}；该日期仅为建议，季内（截至 ${policy.rules.season_end}）仍可接种，绝非过期后禁止`,
    });
  }
  return explanation;
}

// 学校三桶映射：学校永远看不到诊断、批号与时间窗细节。
// - COMPLETE → 完成；
// - 系统无法判定（记录冲突、缺登记/政策/跨季史存疑）→ 需核验；
// - 其余“明确未完成但记录无问题”（待接种、进行中、等待间隔、不足龄、
//   医学禁忌、临时暂缓、季末未完成、不适用）→ 暂缓。
// 医学禁忌与普通迟到的区别只存在于监护人/疾控视图，学校视图不呈现。
export function schoolBucket(status) {
  if (status === "COMPLETE") return "COMPLETED";
  if (status === "NEEDS_VERIFICATION") return "NEEDS_VERIFICATION";
  return "DEFERRED";
}
