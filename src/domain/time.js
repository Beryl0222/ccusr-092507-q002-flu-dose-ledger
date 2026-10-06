// 时间工具：所有领域计算只依赖显式时区的 ISO 字符串与 YYYY-MM-DD 日历日。
// 不在输入对象上做任何就地修改。

const DAY_MS = 24 * 60 * 60 * 1000;

export function toInstant(value) {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`无法解析时间: ${value}`);
  return ms;
}

// 带时区的日历日键（如 2026-10-06），用于“当天”判断与年龄基准。
export function calendarDay(value, timeZone = "Asia/Shanghai") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(toInstant(value)));
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// +08:00 区域下的日历日比较与位移，避免 UTC 取整把傍晚接种算到前一天。
export function dayKeyToUtcNoon(key) {
  const ms = Date.parse(`${key}T12:00:00Z`);
  if (Number.isNaN(ms)) throw new Error(`无法解析日期: ${key}`);
  return ms;
}

export function addDays(key, days) {
  const d = new Date(dayKeyToUtcNoon(key) + days * DAY_MS);
  return d.toISOString().slice(0, 10);
}

export function diffDays(laterKey, earlierKey) {
  return Math.round((dayKeyToUtcNoon(laterKey) - dayKeyToUtcNoon(earlierKey)) / DAY_MS);
}

export function ageInMonths(birthDate, onDayKey) {
  const [by, bm, bd] = birthDate.split("-").map(Number);
  const [oy, om, od] = onDayKey.split("-").map(Number);
  let months = (oy - by) * 12 + (om - bm);
  if (od < bd) months -= 1;
  return months;
}

// 日历月位移：满 N 月龄当天（次月同日；月末取该月最后一天）。
export function addMonths(dateKey, months) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const total = (y * 12 + (m - 1)) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

export function todayKey(timeZone = "Asia/Shanghai", now = new Date()) {
  return calendarDay(now.toISOString(), timeZone);
}

// 保护窗：自末剂接种日（含）经过 onset_days 后形成保护，至流行季结束。
export function protectionWindow(finalDoseDayKey, onsetDays, seasonEndKey) {
  return { start: addDays(finalDoseDayKey, onsetDays), end: seasonEndKey };
}
