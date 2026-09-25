/**
 * 网页的日期与相对时间格式化。全部函数显式接收 timeZone（`formatRelative` 除外，见下）和
 * `now`，不读全局时钟，避免服务端渲染与客户端水合前后不一致。
 *
 * 日期格式属于区域化逻辑，不是界面文案，所以第一版只支持中文、不进 next-intl 语言包：
 * 分钟前、小时前、天前、今天、昨天、周一到周日这些单位词都写死在这里。
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RELATIVE_DAYS_MAX = 30;

const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function toDate(value: string | Date): Date {
  return typeof value === "string" ? new Date(value) : value;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 用 Intl.DateTimeFormat 的 formatToParts 取部件，避免依赖某个 locale 的具体拼接格式 */
function parts(date: Date, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const formatted = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", ...opts }).formatToParts(date);
  const result: Record<string, string> = {};
  for (const part of formatted) result[part.type] = part.value;
  return result;
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function dateParts(date: Date, tz: string): DateParts {
  const p = parts(date, tz, { year: "numeric", month: "2-digit", day: "2-digit" });
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

function timeParts(date: Date, tz: string): { hour: number; minute: number } {
  const p = parts(date, tz, { hour: "2-digit", minute: "2-digit" });
  return { hour: Number(p.hour), minute: Number(p.minute) };
}

/** 把 YYYY-MM-DD 转成 UTC 正午的 Date，只用来算相差几天，不用于展示 */
function keyToUtcNoon(key: string): Date {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!, 12));
}

/** 服务端时区（Docker 部署时由 TZ 环境变量决定） */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** 分组用的日期键：YYYY-MM-DD（按 tz 的当地日期） */
export function dayKey(iso: string | Date, tz: string): string {
  const { year, month, day } = dateParts(toDate(iso), tz);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** “9 月 21 日”；不是今年（按 tz、相对 now 判断）的带上年份，写成“2025 年 9 月 21 日” */
export function formatDate(iso: string | Date, tz: string, now: Date): string {
  const { year, month, day } = dateParts(toDate(iso), tz);
  const { year: nowYear } = dateParts(now, tz);
  return year === nowYear ? `${month} 月 ${day} 日` : `${year} 年 ${month} 月 ${day} 日`;
}

/** “14:02” */
export function formatTime(iso: string | Date, tz: string): string {
  const { hour, minute } = timeParts(toDate(iso), tz);
  return `${pad2(hour)}:${pad2(minute)}`;
}

/**
 * 相对时间：1 分钟内“刚刚”；1 小时内“N 分钟前”；24 小时内“N 小时前”；30 天内“N 天前”；
 * 更早的写日期（用服务端时区格式化，因为超过 30 天的事件不再需要精确到“今天/昨天”）。
 *
 * 这里的“当天”按距今是否满 24 小时计算，不按日历日——不接收 timeZone，也没有办法
 * 按服务端时区判断“是不是同一个自然日”。跨午夜不改变分档：服务端时区昨天 22:00 发生的事件，
 * 今天 01:00 查询时经过 3 小时，仍然显示“3 小时前”，不会因为跨了午夜就提前显示成日期。
 * 按日历日分组（今天 / 昨天 / 具体日期）是 formatDayHeading 的职责，它接收 timeZone。
 */
export function formatRelative(iso: string | Date, now: Date): string {
  const diff = Math.max(0, now.getTime() - toDate(iso).getTime());
  if (diff < MINUTE_MS) return "刚刚";
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`;
  if (diff < RELATIVE_DAYS_MAX * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  return formatDate(iso, serverTimeZone(), now);
}

/** 时间线的分组标题：“今天 · 9 月 24 日”“昨天 · 9 月 23 日”，更早写成不带前缀的日期 */
export function formatDayHeading(iso: string | Date, tz: string, now: Date): string {
  const eventKey = dayKey(iso, tz);
  const nowKey = dayKey(now, tz);
  const datePart = formatDate(iso, tz, now);
  if (eventKey === nowKey) return `今天 · ${datePart}`;
  const diffDays = Math.round((keyToUtcNoon(nowKey).getTime() - keyToUtcNoon(eventKey).getTime()) / DAY_MS);
  if (diffDays === 1) return `昨天 · ${datePart}`;
  return datePart;
}

/** 顶栏当天日期：“2026 年 9 月 24 日（周四）” */
export function formatToday(now: Date, tz: string): string {
  const { year, month, day } = dateParts(now, tz);
  const weekday = keyToUtcNoon(dayKey(now, tz)).getUTCDay();
  return `${year} 年 ${month} 月 ${day} 日（周${WEEKDAY_LABELS[weekday]}）`;
}
