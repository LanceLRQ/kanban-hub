/**
 * 多台机器共用同一个 git 仓库的端到端夹具：一个 origin 仓库（.gitignore 忽略 notes/，
 * notes/tracked.md 强制加入 git），每台机器 clone 一份、各有自己的 KH_HOME 和机器身份，
 * 第一台机器新建项目，之后的机器加入同一个项目。kh pull / kh conflicts 的测试共用。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeRepoConfig } from "../../../../packages/cli/src/repo/config";
import type { TestServer } from "../server/api/test-server";
import {
  cleanupAll,
  cloneTempRepo,
  gitFixture,
  joinProjectFixture,
  loginFixture,
  makeTempKhHome,
  makeTempRepo,
  registerProjectFixture,
  runKh,
  type RunKhResult,
  type TempDir,
} from "./harness";

const INCLUDE = ["notes/**"];

export const sha = (content: string | Uint8Array): string => createHash("sha256").update(content).digest("hex");

export interface Machine {
  name: string;
  repo: string;
  home: string;
  machineId: string;
  kh(args: string[]): Promise<RunKhResult>;
  write(rel: string, content: string | Uint8Array): Promise<void>;
  read(rel: string): Promise<string>;
  exists(rel: string): Promise<boolean>;
  remove(rel: string): Promise<void>;
  state(): Promise<{
    base: Record<string, string>;
    seen: Record<string, string[]>;
    conflicts: Record<string, unknown>;
    staleReported: Record<string, string>;
  }>;
}

export interface Fleet {
  projectId: string;
  origin: string;
  add(name: string): Promise<Machine>;
  cleanup(): Promise<void>;
}

/**
 * 建一个 origin 仓库（.gitignore 忽略 notes/，notes/tracked.md 强制加入 git），第一台机器
 * 新建项目，之后每台机器 clone 一份并加入同一个项目。
 */
export async function makeFleet(server: TestServer): Promise<{ fleet: Fleet; first: Machine }> {
  const cleanupItems: TempDir[] = [];
  const origin = await makeTempRepo();
  cleanupItems.push(origin);
  await fs.writeFile(path.join(origin.dir, ".gitignore"), "notes/\n");
  await fs.mkdir(path.join(origin.dir, "notes"));
  await fs.writeFile(path.join(origin.dir, "notes", "tracked.md"), "tracked in git\n");
  gitFixture(["add", ".gitignore"], origin.dir);
  gitFixture(["add", "-f", "notes/tracked.md"], origin.dir);
  gitFixture(["commit", "-q", "-m", "docs"], origin.dir);

  let projectId = "";

  function machineOf(name: string, repo: string, home: string, machineId: string): Machine {
    const abs = (rel: string) => path.join(repo, ...rel.split("/"));
    return {
      name,
      repo,
      home,
      machineId,
      kh: (args) => runKh(args, { cwd: repo, khHome: home }),
      async write(rel, content) {
        await fs.mkdir(path.dirname(abs(rel)), { recursive: true });
        await fs.writeFile(abs(rel), content);
      },
      read: (rel) => fs.readFile(abs(rel), "utf8"),
      async exists(rel) {
        try {
          await fs.lstat(abs(rel));
          return true;
        } catch {
          return false;
        }
      },
      remove: (rel) => fs.rm(abs(rel)),
      async state() {
        const raw = await fs.readFile(path.join(home, "cache", projectId, "state.json"), "utf8");
        return JSON.parse(raw) as Awaited<ReturnType<Machine["state"]>>;
      },
    };
  }

  async function add(name: string): Promise<Machine> {
    const clone = await cloneTempRepo(origin.dir);
    const home = await makeTempKhHome();
    cleanupItems.push(clone, home);
    const machineId = await loginFixture(server, clone, home, { name });
    if (projectId === "") {
      ({ projectId } = await registerProjectFixture(server, clone, home));
      await writeRepoConfig(clone.dir, {
        projectId,
        sync: { include: INCLUDE, exclude: [], maxFileSize: "5MB" },
        pull: { auto: true },
      });
    } else {
      await joinProjectFixture(server, clone, home, projectId, { include: INCLUDE });
    }
    return machineOf(name, clone.dir, home.dir, machineId);
  }

  const first = await add("机器A");
  const fleet: Fleet = {
    get projectId() {
      return projectId;
    },
    origin: origin.dir,
    add,
    cleanup: () => cleanupAll(...cleanupItems),
  };
  return { fleet, first };
}
