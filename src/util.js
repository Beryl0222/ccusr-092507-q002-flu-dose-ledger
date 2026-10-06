import { createHash } from "node:crypto";

export const DAY_MS = 86400000;

/** 键序稳定的 JSON 序列化，保证同一逻辑内容得到同一串字节。 */
export function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/** 不依赖 locale 的字符串比较，保证跨进程、跨机器排序一致。 */
export function compareStrings(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** 毫秒时间戳转 YYYY-MM-DD（UTC），用于保护窗等日期输出。 */
export function toDateUTC(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 按周岁计算年龄，两个入参均为 YYYY-MM-DD。 */
export function ageYears(birthDate, onDate) {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [oy, om, od] = onDate.split("-").map(Number);
  let age = oy - by;
  if (om < bm || (om === bm && od < bd)) age -= 1;
  return age;
}
