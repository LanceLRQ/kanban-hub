import { describe, expect, it } from "vitest";
import {
  SYNC_ALWAYS_EXCLUDE,
  SYNC_DEFAULT_MAX_FILE_SIZE,
  SYNC_MAX_FILE_SIZE_LIMIT,
  SYNC_MAX_MANIFEST_FILES,
  applyManifestDiff,
  docsPulledChange,
  docsSyncedChange,
  findManifestPathProblem,
  manifestFileSchema,
  pickLatestRemote,
  readDocsCounts,
  sha256HexSchema,
  snapshotManifestSchema,
  snapshotPathSchema,
  syncGlobSchema,
  validateSyncGlob,
  type IncomingFile,
  type ManifestFile,
} from "./sync";
import { fixtureId, makeEvent } from "./test-fixtures";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function file(overrides: Partial<ManifestFile> = {}): ManifestFile {
  return {
    path: "docs/a.md",
    sha256: SHA_A,
    size: 10,
    mtime: 1_700_000_000_000,
    changedAt: "2026-09-23T10:00:00.000Z",
    base: null,
    ...overrides,
  };
}

function incoming(overrides: Partial<IncomingFile> = {}): IncomingFile {
  return {
    path: "docs/a.md",
    sha256: SHA_A,
    size: 10,
    mtime: 1_700_000_000_000,
    base: null,
    ...overrides,
  };
}

describe("同步常量", () => {
  it("默认上限是 5MB", () => {
    expect(SYNC_DEFAULT_MAX_FILE_SIZE).toBe(5 * 1024 * 1024);
  });

  it("硬上限是 20MB", () => {
    expect(SYNC_MAX_FILE_SIZE_LIMIT).toBe(20 * 1024 * 1024);
  });

  it("默认上限小于硬上限", () => {
    expect(SYNC_DEFAULT_MAX_FILE_SIZE).toBeLessThan(SYNC_MAX_FILE_SIZE_LIMIT);
  });

  it("始终排除 node_modules、.git、.next", () => {
    expect(SYNC_ALWAYS_EXCLUDE).toEqual(["**/node_modules/**", "**/.git/**", "**/.next/**"]);
  });

  it("清单文件数上限是 20000", () => {
    expect(SYNC_MAX_MANIFEST_FILES).toBe(20000);
  });
});

describe("validateSyncGlob / syncGlobSchema", () => {
  it.each(["docs/**", "*.md", "design/foo.md"])("接受 %s", (glob) => {
    expect(validateSyncGlob(glob)).toBeNull();
    expect(syncGlobSchema.safeParse(glob).success).toBe(true);
  });

  it("拒绝空串", () => {
    expect(validateSyncGlob("")).not.toBeNull();
    expect(syncGlobSchema.safeParse("").success).toBe(false);
  });

  it("拒绝绝对路径", () => {
    expect(validateSyncGlob("/docs/**")).not.toBeNull();
  });

  it("拒绝含 .. 段的路径", () => {
    expect(validateSyncGlob("docs/../secret/**")).not.toBeNull();
  });

  it("拒绝反斜杠（非 POSIX 形式）", () => {
    expect(validateSyncGlob("docs\\**")).not.toBeNull();
  });
});

describe("snapshotPathSchema", () => {
  it.each(["docs/中文 目录/说明#1.md", "design/100% 完成.md", "a/b/c.txt"])("接受合法路径：%s", (p) => {
    expect(snapshotPathSchema.safeParse(p).success).toBe(true);
  });

  it.each<[string, string]>([
    ["../secret", ".. 段"],
    ["/etc/passwd", "绝对路径"],
    ["docs\\a.md", "反斜杠"],
    ["docs/\u0000a.md", "NUL"],
    ["a/.git/b", ".git 段"],
    ["a/.GIT/b", "大小写不同的 .git 段"],
  ])("拒绝：%s（%s）", (p) => {
    expect(snapshotPathSchema.safeParse(p).success).toBe(false);
  });
});

describe("sha256HexSchema", () => {
  it("接受 64 位小写十六进制", () => {
    expect(sha256HexSchema.safeParse(SHA_A).success).toBe(true);
  });

  it("拒绝大写、长度不对的字符串", () => {
    expect(sha256HexSchema.safeParse(SHA_A.toUpperCase()).success).toBe(false);
    expect(sha256HexSchema.safeParse("abc").success).toBe(false);
  });
});

describe("findManifestPathProblem", () => {
  it("合法清单返回 null", () => {
    expect(findManifestPathProblem(["docs/a.md", "docs/b.md", "README.md"])).toBeNull();
  });

  it("查出完全重复的路径", () => {
    expect(findManifestPathProblem(["docs/a.md", "docs/a.md"])).not.toBeNull();
  });

  it("查出只差大小写的路径", () => {
    expect(findManifestPathProblem(["README.md", "readme.md"])).not.toBeNull();
  });

  it("查出目录与文件冲突", () => {
    expect(findManifestPathProblem(["a", "a/b"])).not.toBeNull();
  });

  it("上级目录检查也不区分大小写", () => {
    expect(findManifestPathProblem(["A", "a/b"])).not.toBeNull();
    expect(findManifestPathProblem(["docs/b.md", "DOCS"])).not.toBeNull();
  });

  it("NFC 与 NFD 写法的同名路径算重复，上级目录检查同样适用", () => {
    const nfc = "caf\u00e9.md";
    const nfd = "cafe\u0301.md";
    expect(findManifestPathProblem([nfc, nfd])).not.toBeNull();
    expect(findManifestPathProblem(["caf\u00e9", "cafe\u0301/x.md"])).not.toBeNull();
  });
});

describe("snapshotManifestSchema", () => {
  it("20001 条的清单被拒", () => {
    const files = Array.from({ length: SYNC_MAX_MANIFEST_FILES + 1 }, (_, i) => file({ path: `docs/${i}.md` }));
    const result = snapshotManifestSchema.safeParse({
      machineId: fixtureId("m", 1),
      updatedAt: "2026-09-23T10:00:00.000Z",
      files,
    });
    expect(result.success).toBe(false);
  });

  it("路径冲突时被拒", () => {
    const result = snapshotManifestSchema.safeParse({
      machineId: fixtureId("m", 1),
      updatedAt: "2026-09-23T10:00:00.000Z",
      files: [file({ path: "a" }), file({ path: "a/b" })],
    });
    expect(result.success).toBe(false);
  });
});

describe("applyManifestDiff", () => {
  const machineId = fixtureId("m", 1);
  const committedAt = "2026-09-23T12:00:00.000Z";

  it("首次同步（prev 为 null）时全部算新增，changedAt 等于 committedAt", () => {
    const result = applyManifestDiff(null, [incoming({ path: "a.md" }), incoming({ path: "b.md", sha256: SHA_B })], machineId, committedAt);
    expect(result.added.sort()).toEqual(["a.md", "b.md"]);
    expect(result.modified).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toBe(0);
    expect(result.next.files.every((f) => f.changedAt === committedAt)).toBe(true);
  });

  it("next.files 按路径排序", () => {
    const result = applyManifestDiff(null, [incoming({ path: "z.md" }), incoming({ path: "a.md" })], machineId, committedAt);
    expect(result.next.files.map((f) => f.path)).toEqual(["a.md", "z.md"]);
  });

  it("内容不变的沿用原 changedAt，修改的更新 changedAt，缺少的算删除", () => {
    const prev = {
      machineId,
      updatedAt: "2026-09-23T10:00:00.000Z",
      files: [
        file({ path: "same.md", sha256: SHA_A, changedAt: "2026-09-23T09:00:00.000Z" }),
        file({ path: "changed.md", sha256: SHA_A, changedAt: "2026-09-23T09:00:00.000Z" }),
        file({ path: "gone.md", sha256: SHA_A, changedAt: "2026-09-23T09:00:00.000Z" }),
      ],
    };
    const result = applyManifestDiff(
      prev,
      [incoming({ path: "same.md", sha256: SHA_A }), incoming({ path: "changed.md", sha256: SHA_B })],
      machineId,
      committedAt,
    );
    expect(result.added).toEqual([]);
    expect(result.modified).toEqual(["changed.md"]);
    expect(result.removed).toEqual(["gone.md"]);
    expect(result.unchanged).toBe(1);
    const same = result.next.files.find((f) => f.path === "same.md");
    const changed = result.next.files.find((f) => f.path === "changed.md");
    expect(same?.changedAt).toBe("2026-09-23T09:00:00.000Z");
    expect(changed?.changedAt).toBe(committedAt);
  });

  it("同一输入重放，结果与第一次应用相同", () => {
    const first = applyManifestDiff(null, [incoming({ path: "a.md" })], machineId, committedAt);
    const replay = applyManifestDiff(first.next, [incoming({ path: "a.md" })], machineId, committedAt);
    expect(replay.next).toEqual(first.next);
  });

  it("保留 incoming 里的 base 字段", () => {
    const result = applyManifestDiff(null, [incoming({ path: "a.md", base: SHA_B })], machineId, committedAt);
    expect(result.next.files[0]?.base).toBe(SHA_B);
  });
});

describe("pickLatestRemote", () => {
  const M1 = fixtureId("m", 1);
  const M2 = fixtureId("m", 2);
  const M3 = fixtureId("m", 3);

  it("取 changedAt 最新的一份", () => {
    const manifests = [
      { machineId: M1, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "a.md", sha256: SHA_A, changedAt: "2026-09-23T09:00:00.000Z" })] },
      { machineId: M2, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "a.md", sha256: SHA_B, changedAt: "2026-09-23T11:00:00.000Z" })] },
    ];
    const result = pickLatestRemote(manifests, null);
    expect(result).toEqual([{ ...file({ path: "a.md", sha256: SHA_B, changedAt: "2026-09-23T11:00:00.000Z" }), machineId: M2 }]);
  });

  it("排除本机", () => {
    const manifests = [
      { machineId: M1, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "a.md", sha256: SHA_A, changedAt: "2026-09-23T12:00:00.000Z" })] },
      { machineId: M2, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "a.md", sha256: SHA_B, changedAt: "2026-09-23T09:00:00.000Z" })] },
    ];
    const result = pickLatestRemote(manifests, M1);
    expect(result).toEqual([{ ...file({ path: "a.md", sha256: SHA_B, changedAt: "2026-09-23T09:00:00.000Z" }), machineId: M2 }]);
  });

  it("changedAt 平局时按 manifest 的 updatedAt 较新的机器；再平局按 machineId 字典序，结果确定", () => {
    const sameChangedAt = "2026-09-23T09:00:00.000Z";
    const manifests = [
      { machineId: M2, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "a.md", sha256: SHA_A, changedAt: sameChangedAt })] },
      { machineId: M1, updatedAt: "2026-09-23T11:00:00.000Z", files: [file({ path: "a.md", sha256: SHA_B, changedAt: sameChangedAt })] },
    ];
    const result = pickLatestRemote(manifests, null);
    expect(result).toEqual([{ ...file({ path: "a.md", sha256: SHA_B, changedAt: sameChangedAt }), machineId: M1 }]);

    const bothSame = [
      { machineId: M3, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "b.md", sha256: SHA_A, changedAt: sameChangedAt })] },
      { machineId: M1, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "b.md", sha256: SHA_B, changedAt: sameChangedAt })] },
    ];
    const first = pickLatestRemote(bothSame, null);
    const second = pickLatestRemote([...bothSame].reverse(), null);
    expect(first).toEqual(second);
  });

  it("某台机器没有这个路径时不影响其他机器", () => {
    const manifests = [
      { machineId: M1, updatedAt: "2026-09-23T10:00:00.000Z", files: [] },
      { machineId: M2, updatedAt: "2026-09-23T10:00:00.000Z", files: [file({ path: "a.md", sha256: SHA_A, changedAt: "2026-09-23T09:00:00.000Z" })] },
    ];
    const result = pickLatestRemote(manifests, null);
    expect(result).toEqual([{ ...file({ path: "a.md", sha256: SHA_A, changedAt: "2026-09-23T09:00:00.000Z" }), machineId: M2 }]);
  });
});

describe("docsSyncedChange / docsPulledChange / readDocsCounts", () => {
  it("docsSyncedChange 与 readDocsCounts 往返一致", () => {
    const change = docsSyncedChange({ added: 3, modified: 2, removed: 1 });
    const event = makeEvent({ type: "docs.synced", change });
    expect(readDocsCounts(event)).toEqual({ type: "docs.synced", added: 3, modified: 2, removed: 1 });
  });

  it("docsPulledChange 与 readDocsCounts 往返一致，带上 fromMachineIds", () => {
    const machines = [fixtureId("m", 1), fixtureId("m", 2)];
    const change = docsPulledChange({ created: 1, overwritten: 1, merged: 1, conflicts: 1, stale: 0 }, machines);
    const event = makeEvent({ type: "docs.pulled", change });
    expect(readDocsCounts(event)).toEqual({
      type: "docs.pulled",
      created: 1,
      overwritten: 1,
      merged: 1,
      conflicts: 1,
      stale: 0,
      fromMachineIds: machines,
    });
  });

  it("格式不对的 change 返回 null，不抛错", () => {
    expect(readDocsCounts(makeEvent({ type: "docs.synced", change: null }))).toBeNull();
    expect(readDocsCounts(makeEvent({ type: "docs.synced", change: { added: { to: "not-a-number" } } }))).toBeNull();
    expect(readDocsCounts(makeEvent({ type: "docs.pulled", change: { created: { to: 1 } } }))).toBeNull();
    expect(readDocsCounts(makeEvent({ type: "log", change: null }))).toBeNull();
  });
});

// 表格里的判定顺序单独在 pull.test.ts 覆盖（decidePull）
describe("manifestFileSchema", () => {
  it("接受合法的清单文件", () => {
    expect(manifestFileSchema.safeParse(file()).success).toBe(true);
  });

  it("拒绝不合法的 sha256", () => {
    expect(manifestFileSchema.safeParse(file({ sha256: "xyz" })).success).toBe(false);
  });
});
