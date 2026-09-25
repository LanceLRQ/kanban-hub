import { shortIdPrefixes } from "./ids";
import type { Board, Container } from "./schema";

export type RefResult =
  | { ok: true; id: string }
  | { ok: false; reason: "invalid" | "not_found" | "ambiguous"; message: string };

const ID_PREFIX_RE = /^[0-9a-z]{4,10}$/;
const FULL_ID_RE = /^[0-9a-z]{10}$/;

function ok(id: string): RefResult {
  return { ok: true, id };
}

function fail(reason: "invalid" | "not_found" | "ambiguous", message: string): RefResult {
  return { ok: false, reason, message };
}

function sameCode(code: string | null, text: string): boolean {
  return code !== null && code.toLowerCase() === text.toLowerCase();
}

/** 容器写法：misc、编号（不区分大小写）、ID 前缀（至少 4 位） */
export function resolveContainerRef(containers: readonly Container[], ref: string): RefResult {
  const text = ref.trim();
  if (text === "") return fail("invalid", "容器写法不能为空");
  if (text.toLowerCase() === "misc") {
    const misc = containers.find((c) => c.kind === "misc");
    return misc ? ok(misc.id) : fail("not_found", "这个项目没有杂项容器");
  }
  const byCode = containers.filter((c) => sameCode(c.code, text));
  if (byCode.length === 1) return ok(byCode[0]!.id);
  if (byCode.length > 1) return fail("ambiguous", `编号“${text}”对应多个容器`);
  const prefix = text.toLowerCase();
  if (ID_PREFIX_RE.test(prefix)) {
    const byId = containers.filter((c) => c.id.startsWith(prefix));
    if (byId.length === 1) return ok(byId[0]!.id);
    if (byId.length > 1) return fail("ambiguous", `“${text}”匹配到多个容器，请多写几位`);
  }
  return fail("not_found", `找不到容器“${text}”`);
}

/** 任务写法：#短ID、容器编号/任务编号、完整 ID */
export function resolveTaskRef(board: Pick<Board, "containers" | "tasks">, ref: string): RefResult {
  const text = ref.trim();

  if (text.startsWith("#")) {
    const prefix = text.slice(1).toLowerCase();
    if (!ID_PREFIX_RE.test(prefix)) return fail("invalid", `“${text}”不是有效的短 ID：# 后面至少要有 4 位字母或数字`);
    const matches = board.tasks.filter((t) => t.id.startsWith(prefix));
    if (matches.length === 1) return ok(matches[0]!.id);
    if (matches.length > 1) {
      const shorts = shortIdPrefixes(board.tasks.map((t) => t.id));
      return fail("ambiguous", `“${text}”匹配到多个任务：${matches.map((t) => `#${shorts.get(t.id)}`).join("、")}`);
    }
    return fail("not_found", `找不到任务“${text}”`);
  }

  const slash = text.indexOf("/");
  if (slash > 0) {
    const container = resolveContainerRef(board.containers, text.slice(0, slash));
    if (!container.ok) return container;
    const code = text.slice(slash + 1);
    const matches = board.tasks.filter((t) => t.containerId === container.id && sameCode(t.code, code));
    if (matches.length === 1) return ok(matches[0]!.id);
    if (matches.length > 1) return fail("ambiguous", `“${text}”对应多个任务`);
    return fail("not_found", `找不到任务“${text}”`);
  }

  const lower = text.toLowerCase();
  if (FULL_ID_RE.test(lower)) {
    return board.tasks.some((t) => t.id === lower) ? ok(lower) : fail("not_found", `找不到任务“${text}”`);
  }

  return fail("invalid", `无法识别任务写法“${text}”：请用“容器编号/任务编号”（例如 M2/2.3）或“#短ID”（例如 #k3v9）`);
}
