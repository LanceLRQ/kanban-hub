import { describe, expect, it } from "vitest";
import {
  PUSHED_LIMIT,
  SEEN_LIMIT,
  decidePull,
  looksBinary,
  pickMergeBase,
  rememberPushed,
  rememberSeen,
  type PullFileInput,
} from "./pull";

const SHA_X = "1".repeat(64); // 共同起点
const SHA_Y = "2".repeat(64); // A 改成的版本
const SHA_Z = "3".repeat(64); // B 改成的版本

function input(overrides: Partial<PullFileInput> = {}): PullFileInput {
  return {
    tracked: false,
    pendingConflict: false,
    unsafe: false,
    local: SHA_X,
    base: SHA_X,
    seen: [],
    remote: { sha: SHA_X, base: SHA_X },
    pushed: [],
    remoteBaseStored: false,
    ...overrides,
  };
}

describe("decidePull：表格判定", () => {
  it("0a 被 git 跟踪：跳过，基准不变", () => {
    expect(decidePull(input({ tracked: true, local: SHA_X, remote: { sha: SHA_Y, base: SHA_X } }))).toEqual({
      kind: "skip",
      reason: "tracked",
      nextBase: "keep",
    });
  });

  it("0b 已有未解决的冲突：跳过，保持冲突", () => {
    expect(decidePull(input({ pendingConflict: true, remote: { sha: SHA_Y, base: SHA_X } }))).toEqual({
      kind: "skip",
      reason: "conflict",
      nextBase: "keep",
    });
  });

  it("0c 本地路径不安全：跳过", () => {
    expect(decidePull(input({ unsafe: true, remote: { sha: SHA_Y, base: SHA_X } }))).toEqual({
      kind: "skip",
      reason: "unsafe",
      nextBase: "keep",
    });
  });

  it("1 本地内容等于对方内容：不动，基准更新为对方内容", () => {
    expect(decidePull(input({ local: SHA_Y, base: SHA_X, remote: { sha: SHA_Y, base: SHA_X } }))).toEqual({
      kind: "skip",
      reason: "same",
      nextBase: SHA_Y,
    });
  });

  it("2 本地不存在，对方内容等于基准：尊重本地删除，不动", () => {
    expect(decidePull(input({ local: null, base: SHA_X, remote: { sha: SHA_X, base: null } }))).toEqual({
      kind: "skip",
      reason: "local-deleted",
      nextBase: "keep",
    });
  });

  it("2 本地不存在，对方内容在 seen 里：尊重本地删除，不动", () => {
    expect(decidePull(input({ local: null, base: null, seen: [SHA_Y], remote: { sha: SHA_Y, base: null } }))).toEqual({
      kind: "skip",
      reason: "local-deleted",
      nextBase: "keep",
    });
  });

  it("3 本地不存在，其余情况：新建", () => {
    expect(decidePull(input({ local: null, base: null, seen: [], remote: { sha: SHA_Y, base: null } }))).toEqual({
      kind: "create",
      nextBase: SHA_Y,
    });
  });

  it("4 对方的 base 等于本地内容：快进覆盖", () => {
    expect(decidePull(input({ local: SHA_Y, base: SHA_X, remote: { sha: SHA_Z, base: SHA_Y } }))).toEqual({
      kind: "overwrite",
      reason: "fast-forward",
      nextBase: SHA_Z,
    });
  });

  it("5a 对方内容等于基准（本地改过、对方没改）：不动", () => {
    expect(decidePull(input({ local: SHA_Y, base: SHA_X, remote: { sha: SHA_X, base: SHA_X } }))).toEqual({
      kind: "skip",
      reason: "local-changed",
      nextBase: "keep",
    });
  });

  it("5b 对方内容在 seen 里，本机已有基准：不动", () => {
    expect(decidePull(input({ local: SHA_Y, base: SHA_Y, seen: [SHA_X], remote: { sha: SHA_X, base: null } }))).toEqual({
      kind: "skip",
      reason: "stale",
      nextBase: "keep",
    });
  });

  it("5b 对方内容在 seen 里，本机没有基准：基准取对方内容", () => {
    expect(decidePull(input({ local: SHA_Y, base: null, seen: [SHA_X], remote: { sha: SHA_X, base: null } }))).toEqual({
      kind: "skip",
      reason: "stale",
      nextBase: SHA_X,
    });
  });

  it("6 本地内容等于基准：覆盖", () => {
    expect(decidePull(input({ local: SHA_X, base: SHA_X, remote: { sha: SHA_Y, base: SHA_Z } }))).toEqual({
      kind: "overwrite",
      reason: "unchanged",
      nextBase: SHA_Y,
    });
  });

  it("7 两边都改了，有基准内容：登记为 merge，带上选中的基准、不带 nextBase，交给调用方判断能否自动合并", () => {
    const result = decidePull(input({ local: SHA_Y, base: SHA_X, remote: { sha: SHA_Z, base: SHA_X } }));
    expect(result).toEqual({ kind: "merge", base: SHA_X });
    expect(result).not.toHaveProperty("nextBase");
  });

  it("8 两边都改了，没有基准内容：直接登记冲突", () => {
    expect(decidePull(input({ local: SHA_Y, base: null, seen: [], remote: { sha: SHA_Z, base: null } }))).toEqual({
      kind: "conflict",
      reason: "no-base",
      nextBase: "keep",
    });
  });
});

describe("decidePull：补充场景", () => {
  it("A、B 都从 X 出发，A 改成 Y 并推送，B 改成 Z 并推送，A 拉取：结果是 merge，不是覆盖", () => {
    // A 本地是 Y，基准仍是 X（推送不改基准），对方（B）内容是 Z，B 的基准也是 X
    const result = decidePull(input({ local: SHA_Y, base: SHA_X, remote: { sha: SHA_Z, base: SHA_X } }));
    expect(result).toEqual({ kind: "merge", base: SHA_X });
  });

  it("A 推送 Y 之后，拉取到 B 快照里的旧版本 X（X 在 A 的 seen 里）：结果是跳过（旧版本）", () => {
    const result = decidePull(input({ local: SHA_Y, base: SHA_Y, seen: [SHA_X], remote: { sha: SHA_X, base: null } }));
    expect(result).toEqual({ kind: "skip", reason: "stale", nextBase: "keep" });
  });

  it("B 在 A 的 Y 上继续改成 Z（Z 的 base 等于 Y），A 拉取：结果是快进覆盖", () => {
    const result = decidePull(input({ local: SHA_Y, base: SHA_Y, remote: { sha: SHA_Z, base: SHA_Y } }));
    expect(result).toEqual({ kind: "overwrite", reason: "fast-forward", nextBase: SHA_Z });
  });

  it("三台机器，A 删除了文件，C 还留着旧版本，B 拉取：B 不被退回到旧版本", () => {
    // B 本地没有改过（本地内容等于基准），对方给的是 C 的旧内容，等于基准 -> 5a 不动
    const result = decidePull(input({ local: SHA_X, base: SHA_X, remote: { sha: SHA_X, base: SHA_X } }));
    expect(result.kind).toBe("skip");
  });
});

describe("pickMergeBase：两边都改了时用哪一份共同基准", () => {
  const pushedX = { pushed: [SHA_X], seen: [SHA_X], remoteBaseStored: true };

  it("对方推送时的基准是本机推送过的某个版本、在 seen 里、本机有内容：用它（即使本机另有基准）", () => {
    expect(pickMergeBase(input({ ...pushedX, base: SHA_Y, remote: { sha: SHA_Z, base: SHA_X } }))).toBe(SHA_X);
  });

  it("推送历史里有多个版本时，对方基于其中较早的一个也能用", () => {
    const entry = input({ base: null, pushed: [SHA_X, SHA_Y], seen: [SHA_X, SHA_Y], remoteBaseStored: true, remote: { sha: SHA_Z, base: SHA_X } });
    expect(pickMergeBase(entry)).toBe(SHA_X);
  });

  it("本机没有它的内容：退回本机基准", () => {
    expect(pickMergeBase(input({ ...pushedX, remoteBaseStored: false, base: SHA_Y, remote: { sha: SHA_Z, base: SHA_X } }))).toBe(SHA_Y);
  });

  it("不在 seen 里：退回本机基准", () => {
    expect(pickMergeBase(input({ ...pushedX, seen: [], base: SHA_Y, remote: { sha: SHA_Z, base: SHA_X } }))).toBe(SHA_Y);
  });

  it("不在推送历史里（例如只是见过、从别处拉来的内容）：退回本机基准", () => {
    expect(pickMergeBase(input({ ...pushedX, pushed: [], base: SHA_Y, remote: { sha: SHA_Z, base: SHA_X } }))).toBe(SHA_Y);
  });

  it("对方推送时没有基准：用本机基准", () => {
    expect(pickMergeBase(input({ ...pushedX, base: SHA_Y, remote: { sha: SHA_Z, base: null } }))).toBe(SHA_Y);
  });

  it("两者都没有：返回 null", () => {
    expect(pickMergeBase(input({ ...pushedX, remoteBaseStored: false, base: null, remote: { sha: SHA_Z, base: SHA_X } }))).toBeNull();
    expect(pickMergeBase(input({ base: null, remote: { sha: SHA_Z, base: null } }))).toBeNull();
  });
});

describe("decidePull：推送过的内容作为共同基准", () => {
  it("本机没有基准，但对方是在本机推送过的内容上改的、本机留有内容：merge，基准用它", () => {
    // A 新建 X 并推送（从没拉取过，没有基准），又改成 Y 推送；B 拉到 X 改成 Z 推送
    const result = decidePull(
      input({ local: SHA_Y, base: null, seen: [SHA_X, SHA_Y], pushed: [SHA_X, SHA_Y], remote: { sha: SHA_Z, base: SHA_X }, remoteBaseStored: true }),
    );
    expect(result).toEqual({ kind: "merge", base: SHA_X });
  });

  it("本机没有基准，对方的基准推送过但本机没有留内容：仍然登记冲突", () => {
    const result = decidePull(
      input({ local: SHA_Y, base: null, seen: [SHA_X, SHA_Y], pushed: [SHA_X], remote: { sha: SHA_Z, base: SHA_X }, remoteBaseStored: false }),
    );
    expect(result).toEqual({ kind: "conflict", reason: "no-base", nextBase: "keep" });
  });
});

describe("rememberPushed", () => {
  it("与最后一项不同：追加到末尾", () => {
    expect(rememberPushed(["a"], "b")).toEqual(["a", "b"]);
  });

  it("与最后一项相同：不变", () => {
    expect(rememberPushed(["a", "b"], "b")).toEqual(["a", "b"]);
  });

  it("已在列表里：移到末尾，不重复", () => {
    expect(rememberPushed(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it(`只保留最近 PUSHED_LIMIT（${PUSHED_LIMIT}）份，丢最旧的`, () => {
    const seed = Array.from({ length: PUSHED_LIMIT }, (_, i) => `sha-${i}`);
    const result = rememberPushed(seed, "new-one");
    expect(result).toHaveLength(PUSHED_LIMIT);
    expect(result[0]).toBe("sha-1");
    expect(result[PUSHED_LIMIT - 1]).toBe("new-one");
  });
});

describe("rememberSeen", () => {
  it("去重：已存在的内容再次出现时移到末尾，不重复计入", () => {
    expect(rememberSeen(["a", "b", "c"], "a")).toEqual(["b", "c", "a"]);
  });

  it("新的放在末尾", () => {
    expect(rememberSeen(["a", "b"], "c")).toEqual(["a", "b", "c"]);
  });

  it("一次记住多个", () => {
    expect(rememberSeen(["a"], "b", "c")).toEqual(["a", "b", "c"]);
  });

  it("只保留最近 SEEN_LIMIT 个", () => {
    const seed = Array.from({ length: SEEN_LIMIT }, (_, i) => `sha-${i}`);
    const result = rememberSeen(seed, "new-one");
    expect(result).toHaveLength(SEEN_LIMIT);
    expect(result[result.length - 1]).toBe("new-one");
    expect(result[0]).toBe("sha-1");
  });
});

describe("looksBinary", () => {
  it("纯文本判为非二进制", () => {
    expect(looksBinary(new TextEncoder().encode("hello world\n"))).toBe(false);
  });

  it("UTF-8 中文判为非二进制", () => {
    expect(looksBinary(new TextEncoder().encode("你好，世界"))).toBe(false);
  });

  it("含 NUL 字节判为二进制", () => {
    expect(looksBinary(new Uint8Array([104, 105, 0, 106]))).toBe(true);
  });

  it("只检查前 8000 字节", () => {
    const bytes = new Uint8Array(9000).fill(97); // 全是 'a'
    bytes[8500] = 0; // 超出检查范围的 NUL
    expect(looksBinary(bytes)).toBe(false);
  });
});
