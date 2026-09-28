/**
 * 拉取的逐文件判定：纯函数，不接触文件内容，只比较 hash。调用方（kh）负责实际的文件 IO、
 * 三方合并（`git merge-file`）和冲突登记；这里只决定“该怎么处理”。
 */

/** 本机为每个路径记住“见过的旧内容”的上限，超出时丢弃最早的 */
export const SEEN_LIMIT = 50;

/**
 * 记住一批内容 hash：已存在的会去重并移到末尾（表示“最近见过”），超过 SEEN_LIMIT 时
 * 从最旧的开始丢弃。
 */
export function rememberSeen(seen: readonly string[], ...shas: string[]): string[] {
  const result = [...seen];
  for (const sha of shas) {
    const index = result.indexOf(sha);
    if (index !== -1) result.splice(index, 1);
    result.push(sha);
  }
  if (result.length > SEEN_LIMIT) result.splice(0, result.length - SEEN_LIMIT);
  return result;
}

/** 与 git 的判断一致：只看前 8000 字节，出现 NUL 就认为是二进制 */
export function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

export interface PullFileInput {
  /** 本机 `git ls-files` 里是否有这个路径 */
  tracked: boolean;
  /** 这个路径是否已有未解决的冲突 */
  pendingConflict: boolean;
  /** 本地路径是否不安全（自身或某一级父目录是软链接，或本地同名路径是目录） */
  unsafe: boolean;
  /** 本地内容的 hash；本地不存在这个文件时为 null */
  local: string | null;
  /** 本机记录的基准 hash；从未建立过基准时为 null */
  base: string | null;
  /** 本机最近见过的内容 hash（见 rememberSeen） */
  seen: readonly string[];
  /** 对方（选中的那台机器）当前的内容 */
  remote: { sha: string; base: string | null };
}

/**
 * 拉取后的基准如何更新：具体的 hash 表示“改成这份内容”，"keep" 表示保持本机原有的基准
 * 不变（调用方不要覆盖）。
 */
export type NextBase = string | null | "keep";

/**
 * `merge` 不带 `nextBase`：与其他 kind 不同，decidePull 看不到内容，判断不了这次合并
 * 最终会不会真的没有冲突，所以基准怎么变不是它能决定的——调用方按“自动合并成功就把
 * 基准改成对方内容，判定为冲突（含二进制）就保持原基准不变”自行处理，不要套用一个
 * 看起来和其他 kind 一样、其实只是猜测的字段。
 */
export type PullDecision =
  | { kind: "skip"; reason: "tracked" | "conflict" | "unsafe" | "same" | "local-deleted" | "local-changed" | "stale"; nextBase: NextBase }
  | { kind: "create"; nextBase: NextBase }
  | { kind: "overwrite"; reason: "fast-forward" | "unchanged"; nextBase: NextBase }
  | { kind: "merge" }
  | { kind: "conflict"; reason: "no-base"; nextBase: NextBase };

/**
 * 按规格 9.3 的表格逐条判定，命中即停。行号对应设计里“逐文件处理规则”的表格：
 *
 * 0a 被 git 跟踪 → 跳过；0b 已有冲突 → 跳过；0c 路径不安全 → 跳过；
 * 1 内容相同 → 不动，基准更新为对方内容；
 * 2 本地不存在且对方没有新内容（等于基准或在 seen 里）→ 尊重本地删除，不动；
 * 3 本地不存在、其余情况 → 新建；
 * 4 对方的 base 等于本地内容 → 快进覆盖；
 * 5a 对方内容等于基准（本地改过、对方没改）→ 不动；
 * 5b 对方内容是本机见过的旧版本 → 跳过（没有基准时顺带把它记为基准）；
 * 6 本地内容等于基准（本地没改过）→ 覆盖；
 * 7 两边都改了、本机有基准内容 → 交给调用方尝试自动合并（`merge`，不带 nextBase）；
 * 8 两边都改了、本机没有基准内容 → 直接登记冲突。
 *
 * “两边都改了但是二进制文件”这一半，decidePull 本身看不到内容，交由调用方在收到
 * `merge` 结果后自行用 looksBinary 判断：判定为二进制就直接登记冲突；是文本就尝试
 * `git merge-file`，没有重叠就写入并把基准改成对方内容，有重叠就登记冲突、基准不变。
 */
export function decidePull(input: PullFileInput): PullDecision {
  const { tracked, pendingConflict, unsafe, local, base, seen, remote } = input;

  if (tracked) return { kind: "skip", reason: "tracked", nextBase: "keep" };
  if (pendingConflict) return { kind: "skip", reason: "conflict", nextBase: "keep" };
  if (unsafe) return { kind: "skip", reason: "unsafe", nextBase: "keep" };

  if (local !== null && local === remote.sha) {
    return { kind: "skip", reason: "same", nextBase: remote.sha };
  }

  if (local === null) {
    if (remote.sha === base || seen.includes(remote.sha)) {
      return { kind: "skip", reason: "local-deleted", nextBase: "keep" };
    }
    return { kind: "create", nextBase: remote.sha };
  }

  if (remote.base !== null && remote.base === local) {
    return { kind: "overwrite", reason: "fast-forward", nextBase: remote.sha };
  }

  if (remote.sha === base) {
    return { kind: "skip", reason: "local-changed", nextBase: "keep" };
  }

  if (seen.includes(remote.sha)) {
    return { kind: "skip", reason: "stale", nextBase: base === null ? remote.sha : "keep" };
  }

  if (local === base) {
    return { kind: "overwrite", reason: "unchanged", nextBase: remote.sha };
  }

  if (base !== null) {
    return { kind: "merge" };
  }

  return { kind: "conflict", reason: "no-base", nextBase: "keep" };
}
