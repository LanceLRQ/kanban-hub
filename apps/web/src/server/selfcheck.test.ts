import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkAbsolutePath,
  checkAdminPassword,
  checkGitAvailable,
  checkPublicUrl,
  checkWritableDir,
  runSelfCheck,
} from "./selfcheck";

// 除了专门测 KH_ADMIN_PASSWORD 的用例，其余用例都带上这个有效值，避免被这项新检查干扰
const VALID_ENV = { KH_ADMIN_PASSWORD: "dev" };

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "kh-selfcheck-"));
});

afterEach(async () => {
  await fs.chmod(tmp, 0o700).catch(() => {});
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("checkWritableDir", () => {
  it("可写目录返回 null，且不留下探测文件", async () => {
    expect(await checkWritableDir(tmp, { create: false })).toBeNull();
    expect(await fs.readdir(tmp)).toEqual([]);
  });

  it("目录不存在且不允许创建时，报错并给出 chown 提示", async () => {
    const msg = await checkWritableDir(path.join(tmp, "missing"), { create: false });
    expect(msg).toContain("不存在");
    expect(msg).toContain("chown");
  });

  it("目录不存在但允许创建时，自动创建并返回 null", async () => {
    const dir = path.join(tmp, "a", "b");
    expect(await checkWritableDir(dir, { create: true })).toBeNull();
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it("路径是文件而不是目录时报错", async () => {
    const file = path.join(tmp, "f");
    await fs.writeFile(file, "");
    expect(await checkWritableDir(file, { create: false })).toContain("不是目录");
  });

  // root 对只读目录也能写入，这个用例在 root 身份下没有意义
  it.skipIf(process.getuid?.() === 0)("目录不可写时报错并给出 chown 提示", async () => {
    await fs.chmod(tmp, 0o500);
    const msg = await checkWritableDir(tmp, { create: false });
    expect(msg).toContain("不可写");
    expect(msg).toContain("chown");
  });

  it("容器外的提示不提宿主机挂载目录", async () => {
    const msg = await checkWritableDir(path.join(tmp, "missing"), { create: false });
    expect(msg).toContain("chown");
    expect(msg).not.toContain("宿主机");
  });

  it("容器里的提示指向宿主机上的挂载目录", async () => {
    const msg = await checkWritableDir(path.join(tmp, "missing"), { create: false, inContainer: true });
    expect(msg).toContain("宿主机");
  });
});

describe("checkGitAvailable", () => {
  it("系统有 git 时返回 null", async () => {
    expect(await checkGitAvailable()).toBeNull();
  });

  it("命令不存在时报错", async () => {
    expect(await checkGitAvailable("/nonexistent/git")).toContain("找不到可用的 git");
  });
});

describe("runSelfCheck", () => {
  it("全部通过时返回空数组", async () => {
    const errors = await runSelfCheck(
      { dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "backups"), inContainer: false },
      "git",
      VALID_ENV,
    );
    expect(errors).toEqual([]);
  });

  it("容器内目录缺失时不自动创建，并汇总所有错误", async () => {
    const errors = await runSelfCheck(
      { dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "backups"), inContainer: true },
      "/nonexistent/git",
      VALID_ENV,
    );
    expect(errors).toHaveLength(3);
    await expect(fs.stat(path.join(tmp, "data"))).rejects.toThrow();
  });

  it("缺少 KH_ADMIN_PASSWORD 时自检失败，不创建任何目录", async () => {
    const errors = await runSelfCheck(
      { dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "backups"), inContainer: false },
      "git",
      {},
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("KH_ADMIN_PASSWORD");
    await expect(fs.stat(path.join(tmp, "data"))).rejects.toThrow();
  });
});

describe("checkAbsolutePath", () => {
  it("绝对路径返回 null", () => {
    expect(checkAbsolutePath("KH_DATA_DIR", "/data")).toBeNull();
  });

  it("相对路径报错，并指出是哪个环境变量", () => {
    const msg = checkAbsolutePath("KH_DATA_DIR", "data");
    expect(msg).toContain("KH_DATA_DIR");
    expect(msg).toContain("绝对路径");
  });
});

describe("runSelfCheck 的路径检查", () => {
  it("数据目录是相对路径时直接报错，不创建任何目录", async () => {
    // 相对路径也指向 tmp 里面：红灯阶段旧实现会去创建它，afterEach 能清理掉
    const rel = path.relative(process.cwd(), path.join(tmp, "data"));
    const errors = await runSelfCheck(
      { dataDir: rel, backupDir: path.join(tmp, "backups"), inContainer: false },
      "git",
      VALID_ENV,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("KH_DATA_DIR");
    await expect(fs.stat(path.join(tmp, "data"))).rejects.toThrow();
    await expect(fs.stat(path.join(tmp, "backups"))).rejects.toThrow();
  });
});

describe("checkPublicUrl", () => {
  it("未设置时通过", () => {
    expect(checkPublicUrl(undefined)).toBeNull();
  });

  it("合法的 http/https 地址通过", () => {
    expect(checkPublicUrl("https://kanban.example.com")).toBeNull();
    expect(checkPublicUrl("http://127.0.0.1:28970")).toBeNull();
  });

  it("非法协议被拒绝", () => {
    const msg = checkPublicUrl("ftp://kanban.example.com");
    expect(msg).not.toBeNull();
    expect(msg).toContain("KH_PUBLIC_URL");
  });

  it("无法解析的值被拒绝", () => {
    const msg = checkPublicUrl("不是一个地址");
    expect(msg).not.toBeNull();
    expect(msg).toContain("KH_PUBLIC_URL");
  });
});

describe("runSelfCheck 的 KH_PUBLIC_URL 检查", () => {
  it("KH_PUBLIC_URL 非法时自检失败，不创建任何目录", async () => {
    const errors = await runSelfCheck(
      { dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "backups"), inContainer: false },
      "git",
      { ...VALID_ENV, KH_PUBLIC_URL: "不合法" },
    );
    expect(errors.some((e) => e.includes("KH_PUBLIC_URL"))).toBe(true);
    await expect(fs.stat(path.join(tmp, "data"))).rejects.toThrow();
  });

  it("未设置 KH_PUBLIC_URL 时不受影响", async () => {
    const errors = await runSelfCheck(
      { dataDir: path.join(tmp, "data"), backupDir: path.join(tmp, "backups"), inContainer: false },
      "git",
      VALID_ENV,
    );
    expect(errors).toEqual([]);
  });
});

describe("checkAdminPassword", () => {
  it("未设置时报错，写明变量名", () => {
    const msg = checkAdminPassword({});
    expect(msg).toContain("KH_ADMIN_PASSWORD");
  });

  it("设置为空串时报错", () => {
    expect(checkAdminPassword({ KH_ADMIN_PASSWORD: "" })).not.toBeNull();
  });

  it("设置了非空值时返回 null", () => {
    expect(checkAdminPassword({ KH_ADMIN_PASSWORD: "hunter2" })).toBeNull();
  });
});
