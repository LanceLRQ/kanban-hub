import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// 守护 CI workflow：镜像发布只允许 `v*.*.*` tag 触发。谁往 workflow 里加
// branches / pull_request 触发（日常推送会产生 CI 消耗），这里的断言就必须变红。
// 本文件位于 <仓库根>/apps/web/src/，向上三级回到仓库根，不依赖 vitest 的运行目录。
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const workflowPath = resolve(repoRoot, ".github", "workflows", "docker-publish.yml");

type Step = { run?: string; uses?: string; with?: Record<string, unknown> };
type Workflow = {
  name?: string;
  on?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  jobs?: Record<string, { steps?: Step[] }>;
};

// 文件不存在时 readFileSync 直接抛 ENOENT，整个测试文件红——这正是守护的一部分
const workflow = parse(readFileSync(workflowPath, "utf8")) as Workflow;

function allRunScripts(): string[] {
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
}

describe(".github/workflows/docker-publish.yml", () => {
  it("文件存在且可解析为合法 YAML，verify / publish 两个 job 齐全", () => {
    expect(workflow.jobs?.verify).toBeDefined();
    expect(workflow.jobs?.publish).toBeDefined();
    // 最小权限：只读代码即可完成校验与构建
    expect(workflow.permissions).toEqual({ contents: "read" });
  });

  it("触发条件只允许 v*.*.* 的 tag push，禁止 branches / pull_request 触发", () => {
    const on = workflow.on;
    if (!on) throw new Error("缺少 on 触发配置");
    // 触发入口只有 push，push 下只有 tags——多出的任何键（branches、pull_request……）都会让这里变红
    expect(Object.keys(on)).toEqual(["push"]);
    expect(on.push).toEqual({ tags: ["v*.*.*"] });
    // 有人把 pull_request 错挂到顶层时也能拦住
    expect(workflow).not.toHaveProperty("pull_request");
  });

  it("tag 与 packages/core 的 version 一致性校验存在且指向正确文件", () => {
    const runs = allRunScripts().join("\n");
    expect(runs).toContain("packages/core/package.json");
    expect(runs).toContain("GITHUB_REF_NAME");
    expect(runs).toContain("::error::");
  });

  it("所有 run 脚本片段通过 bash -n 语法检查", () => {
    const runs = allRunScripts();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      const result = spawnSync("bash", ["-n"], { input: run, encoding: "utf8" });
      expect(result.status, `bash -n 未通过：\n${run}\n${result.stderr ?? ""}`).toBe(0);
    }
  });

  it("publish 构建多架构镜像前先装 QEMU，GHA 缓存用固定 scope 跨 tag 复用", () => {
    const steps = workflow.jobs?.publish?.steps ?? [];
    // Dockerfile 的 deps/build 阶段在目标平台执行 pnpm install、next build，runtime
    // 还有 apt-get RUN；amd64 runner 上构建 linux/arm64 必须先装 QEMU 模拟，漏了首跑必红
    const uses = steps.map((step) => step.uses ?? "");
    const qemu = uses.findIndex((use) => use.startsWith("docker/setup-qemu-action"));
    const buildx = uses.findIndex((use) => use.startsWith("docker/setup-buildx-action"));
    const push = uses.findIndex((use) => use.startsWith("docker/build-push-action"));
    expect(qemu).toBeGreaterThanOrEqual(0);
    expect(buildx).toBeGreaterThan(qemu);
    expect(push).toBeGreaterThan(buildx);
    // GHA 缓存 scope 默认按 ref 派生，每个新 tag 都是冷缓存；固定 scope 才能跨 tag 复用
    const withs = steps.map((step) => (step.with ? JSON.stringify(step.with) : "")).join("\n");
    expect(withs).toContain("scope=");
  });
});
