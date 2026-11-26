// 时区安全的日期工具：所有"哪一天"的判断都以店铺时区为准。

export function dateKey(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

export function todayKey(timezone, now = new Date()) {
  return dateKey(now, timezone);
}

export function addDays(key, amount) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + amount)).toISOString().slice(0, 10);
}

export function startOfMonthKey(key) {
  return `${key.slice(0, 7)}-01`;
}

// 列举 [start, end) 之间的每一天，用于按日归类。
export function dayRange(start, end) {
  const days = [];
  for (let day = start; day < end; day = addDays(day, 1)) days.push(day);
  return days;
}

export function formatDateTime(date, timezone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

export function formatClock(date, timezone) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: timezone,
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}
