// 测试用事件构造助手：集中固定策略规则形状，用最小字段拼出合法事件。
let seq = 0;
export function eid(prefix) {
  seq += 1;
  return `t-${prefix}-${seq}`;
}

export function resetSeq() {
  seq = 0;
}

const baseRules = {
  season_start: "2026-07-01",
  season_end: "2027-06-30",
  age_as_of: "2026-09-01",
  recommended_complete_by: "2026-10-31",
  onset_days_after_final_dose: 14,
  min_age_months: 6,
  min_interval_days_for_second_dose: 28,
  schedule: [
    { id: "u9-first", min_age_months: 6, max_age_months_exclusive: 108, min_prior_season_doses: 0, max_prior_season_doses: 0, dose_count: 2 },
    { id: "u9-repeat", min_age_months: 6, max_age_months_exclusive: 108, min_prior_season_doses: 1, dose_count: 1 },
    { id: "nine-plus", min_age_months: 108, dose_count: 1 },
  ],
};

export function policyEvent({
  season = "2026",
  version = "2026.1",
  effective = "2026-07-01T00:00:00+08:00",
  published = "2026-06-01T09:00:00+08:00",
  rules = baseRules,
  eventId = eid("policy"),
} = {}) {
  return {
    event_id: eventId,
    event_type: "POLICY_PUBLISHED",
    aggregate_type: "season_policy",
    aggregate_id: `policy-${season}`,
    occurred_at: published,
    version: 1,
    payload: { season_id: season, guideline_version: version, effective_at: effective, rules },
  };
}

export function childEvent(id, { birth = "2022-01-01", region = "3301", extra } = {}) {
  return {
    event_id: eid(`reg-${id}`),
    event_type: "CHILD_REGISTERED",
    aggregate_type: "child_record",
    aggregate_id: id,
    occurred_at: "2026-09-01T08:30:00+08:00",
    version: 1,
    payload: { birth_date: birth, home_region_code: region, ...(extra ? { extra } : {}) },
  };
}

export function doseEvent({
  child,
  season = "2026",
  seq = "1",
  lot = "L1",
  at = "2026-09-10T10:00:00+08:00",
  by = "钱医生",
  report = null,
  region = "3301",
  product = "流感疫苗",
  eventId = eid("dose"),
  extra,
}) {
  return {
    event_id: eventId,
    event_type: "DOSE_RECORDED",
    aggregate_type: "dose_event",
    aggregate_id: eventId,
    occurred_at: at,
    version: 1,
    payload: {
      child_record_id: child,
      season_id: season,
      dose_seq: seq,
      vaccine_product: product,
      lot_no: lot,
      administered_at: at,
      administered_by: by,
      source_report_id: report ?? eventId,
      region_code: region,
      ...(extra ? { extra } : {}),
    },
  };
}

export function decisionEvent({ child, season = "2026", seq = "1", resolution, winner, assignments, decidedAt = "2026-09-20T09:00:00+08:00" }) {
  return {
    event_id: eid("decision"),
    event_type: "DOSE_REPORTS_RECONCILED",
    aggregate_type: "child_record",
    aggregate_id: child,
    occurred_at: decidedAt,
    version: 1,
    payload: {
      business_key: `${child}|${season}|${seq}`,
      resolution,
      ...(winner ? { winning_region_code: winner.region, winning_source_report_id: winner.report } : {}),
      ...(assignments ? { assignments } : {}),
      decided_at: decidedAt,
    },
  };
}

export function matchEvent({ source, target, auth = "authz-1", at = "2026-09-21T09:00:00+08:00", sourceRegion = "3201" }) {
  return {
    event_id: eid("match"),
    event_type: "RECORD_MATCHED",
    aggregate_type: "child_record",
    aggregate_id: source,
    occurred_at: at,
    version: 1,
    payload: { authorization_id: auth, source_region_code: sourceRegion, source_record_id: source, target_record_id: target, matched_at: at },
  };
}

export function batchEvent({ lot, effective = "2026-09-20T08:00:00+08:00", reason = "QUALITY_HOLD" }) {
  return {
    event_id: eid("batch"),
    event_type: "BATCH_SUSPENDED",
    aggregate_type: "batch_notice",
    aggregate_id: `batch-${lot}`,
    occurred_at: effective,
    version: 1,
    payload: { lot_no: lot, effective_at: effective, reason_code: reason },
  };
}

export function deferralEvent({ child, season = "2026", kind = "TEMPORARY_DEFERRAL", reason = "ACUTE_ILLNESS", effective = "2026-09-15T09:00:00+08:00", validUntil = null, eventId = eid("defer") }) {
  return {
    event_id: eventId,
    event_type: "DEFERRAL_RECORDED",
    aggregate_type: "child_record",
    aggregate_id: child,
    occurred_at: effective,
    version: 1,
    payload: { child_record_id: child, season_id: season, kind, reason_code: reason, effective_at: effective, ...(validUntil ? { valid_until: validUntil } : {}) },
  };
}

export function clearDeferralEvent({ child, season, deferralId, at = "2026-09-25T09:00:00+08:00" }) {
  return {
    event_id: eid("clear"),
    event_type: "DEFERRAL_CLEARED",
    aggregate_type: "child_record",
    aggregate_id: child,
    occurred_at: at,
    version: 1,
    payload: { child_record_id: child, season_id: season, deferral_event_id: deferralId, cleared_at: at },
  };
}

export { baseRules };
