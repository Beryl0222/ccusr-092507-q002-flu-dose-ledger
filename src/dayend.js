import { canonicalize, compareStrings, sha256 } from "./util.js";
import { buildLedger, resolveChildId } from "./ledger.js";
import { computeChildStatus } from "./status.js";

/**
 * 确定性日终命令：对事件日志重放归并，输出 as_of 日终快照。
 * 相同事件集合（任意到达顺序、任意重复送达、进程重启后重放）必得相同 digest。
 *
 * 批次停用（BATCH_SUSPENDED）的处置：
 * - 只影响尚未执行的计划：affected_pending_plans 列出计划被阻断的儿童；
 * - 已完成的接种事实不可删除：recipients 列出该批号的真实使用者以便随访，事实本身保留。
 */
export function runDayEnd(events, asOf) {
  const ledger = buildLedger(events);
  const seasons = [...ledger.policies.keys()].sort(compareStrings);
  const latestSeason = seasons[seasons.length - 1];

  const childIds = new Set(ledger.children.keys());
  for (const dose of ledger.doses) {
    const childId = resolveChildId(ledger, dose);
    if (childId) childIds.add(childId);
  }
  for (const plan of ledger.plans) childIds.add(plan.child_id);

  const children = [];
  for (const childId of [...childIds].sort(compareStrings)) {
    const child = ledger.children.get(childId);
    for (const seasonId of seasons) {
      const hasActivity =
        ledger.doses.some((dose) => dose.season_id === seasonId && resolveChildId(ledger, dose) === childId) ||
        ledger.plans.some((plan) => plan.child_id === childId && plan.season_id === seasonId) ||
        Boolean(child?.deferrals?.has(seasonId));
      if (!hasActivity && seasonId !== latestSeason) continue;
      children.push(computeChildStatus(ledger, childId, seasonId, asOf));
    }
  }

  const suspensions = ledger.suspensions
    .map((suspension) => {
      const recipients = new Set();
      const affectedPlans = new Set();
      for (const dose of ledger.doses) {
        if (dose.lot_no !== suspension.lot_no) continue;
        const childId = resolveChildId(ledger, dose);
        if (childId) recipients.add(childId);
      }
      for (const plan of ledger.plans) {
        if (plan.lot_no !== suspension.lot_no) continue;
        const status = computeChildStatus(ledger, plan.child_id, plan.season_id, asOf);
        if (status.status !== "completed") affectedPlans.add(plan.child_id);
      }
      return {
        lot_no: suspension.lot_no,
        effective_at: suspension.effective_at,
        reason: suspension.reason,
        recipients: [...recipients].sort(compareStrings),
        affected_pending_plans: [...affectedPlans].sort(compareStrings),
      };
    })
    .sort((a, b) => compareStrings(a.lot_no, b.lot_no));

  const quarantineMap = new Map();
  for (const dose of ledger.doses) {
    if (dose.origin !== "external" || resolveChildId(ledger, dose) !== null) continue;
    const key = `${dose.source_region}/${dose.child_ref}`;
    if (!quarantineMap.has(key)) {
      quarantineMap.set(key, { source_region: dose.source_region, external_ref: dose.child_ref, event_ids: [] });
    }
    quarantineMap.get(key).event_ids.push(dose.event_id);
  }
  const quarantinedExternal = [...quarantineMap.values()]
    .map((item) => ({ ...item, event_ids: item.event_ids.sort(compareStrings) }))
    .sort((a, b) => compareStrings(`${a.source_region}/${a.external_ref}`, `${b.source_region}/${b.external_ref}`));

  const body = {
    as_of: asOf,
    event_count: ledger.event_count,
    duplicate_deliveries: ledger.duplicate_deliveries,
    log_digest: sha256(canonicalize(ledger.accepted)),
    children,
    suspensions,
    quarantined_external: quarantinedExternal,
    issues: ledger.issues,
  };
  return { ...body, digest: sha256(canonicalize(body)) };
}
