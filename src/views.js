import { computeChildStatus } from "./status.js";

/**
 * 学校视角只暴露三种结论：完成 / 暂缓 / 需核验。
 * 待接种与待核对在学校侧统一归入“需核验”（学校跟进口径），
 * 且绝不暴露暂缓的医学原因、批号、诊断等细节。
 */
const SCHOOL_CATEGORY = {
  completed: "完成",
  deferred: "暂缓",
  in_progress: "需核验",
  needs_review: "需核验",
};

/** 基本目的角色：即使家长撤回了额外数据用途，这些角色的最小化视图仍可提供。 */
const PRIMARY_ROLES = new Set(["parent", "school", "cdc"]);

/**
 * 出具剂次证明。返回证明正文与对应的 PROOF_ISSUED 事件（由调用方决定是否落账）。
 * 家长撤回额外数据用途（data_sharing）后：
 * - 本人（parent）取证不受影响；
 * - 学校、疾控的基本目的最小视图不受影响；
 * - 额外用途角色（如 research）拒绝出具。
 */
export function issueProof(ledger, childId, seasonId, viewerRole, asOf) {
  const child = ledger.children.get(childId);
  if (!child) return { issued: false, reason: "child_not_found" };
  const dataSharingWithdrawn = child.consents?.data_sharing?.granted === false;
  if (dataSharingWithdrawn && !PRIMARY_ROLES.has(viewerRole)) {
    return { issued: false, reason: "data_sharing_withdrawn" };
  }
  const status = computeChildStatus(ledger, childId, seasonId, asOf);
  const recordVersion = Math.max(child.record_version, 1);
  const event = {
    event_id: `proof-${childId}-${seasonId}-${viewerRole}-${asOf}`,
    event_type: "PROOF_ISSUED",
    aggregate_type: "child_record",
    aggregate_id: childId,
    occurred_at: `${asOf}T00:00:00Z`,
    version: recordVersion,
    payload: { viewer_role: viewerRole, record_version: recordVersion },
  };
  const proof =
    viewerRole === "school"
      ? { child_id: childId, season_id: seasonId, category: SCHOOL_CATEGORY[status.status] }
      : status;
  return { issued: true, event, proof };
}
