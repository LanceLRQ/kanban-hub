import { execFile } from "node:child_process";
import { CliError, EXIT } from "../errors";

export interface GitResult {
  ok: boolean;
  /** 进程的退出码；找不到 git 本身不会走到这里（直接 reject） */
  code: number;
  stdout: string | Buffer;
  stderr: string;
}

export interface RunGitOptions {
  cwd: string;
  /** 传给子进程的环境变量；调用方一律传 ctx.env，不依赖 process.env */
  env: Record<string, string | undefined>;
  /** true 时 stdout 以 Buffer 返回，用于需要原样写回文件内容的场景（例如读取历史版本的二进制文件） */
  buffer?: boolean;
}

/** 覆盖仓库里较大的快照或历史内容；64MB 足够容纳同步范围允许的最大单文件（20MB 硬上限） */
const MAX_BUFFER = 64 * 1024 * 1024;

function exitCodeOf(err: NodeJS.ErrnoException | null): number {
  if (err === null) return 0;
  return typeof err.code === "number" ? err.code : 1;
}

export function runGit(args: string[], opts: RunGitOptions & { buffer: true }): Promise<GitResult & { stdout: Buffer }>;
export function runGit(args: string[], opts: RunGitOptions & { buffer?: false | undefined }): Promise<GitResult & { stdout: string }>;
export function runGit(args: string[], opts: RunGitOptions): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: opts.cwd,
        // GIT_OPTIONAL_LOCKS=0：只读命令不应该因为并发写锁而失败或产生副作用。
        // execFile 的 env 选项类型是 NodeJS.ProcessEnv；调用方传入的 ctx.env 未必带有该类型
        // 声明的每个字段（例如某些环境要求 NODE_ENV），这里按运行时的真实形状转换，不影响行为
        env: { ...opts.env, GIT_OPTIONAL_LOCKS: "0" } as unknown as NodeJS.ProcessEnv,
        maxBuffer: MAX_BUFFER,
        // 统一按 buffer 拿两路输出，再各自决定要不要转成字符串：execFile 的 encoding 选项
        // 对 stdout、stderr 一视同仁，而这里的约定是 stdout 可选 Buffer、stderr 恒为字符串
        encoding: "buffer",
      },
      (err, stdout, stderr) => {
        if (err !== null && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new CliError(EXIT.UNEXPECTED, "找不到 git 可执行文件", "请安装 git 后重试"));
          return;
        }
        resolve({
          ok: err === null,
          code: exitCodeOf(err as NodeJS.ErrnoException | null),
          stdout: opts.buffer ? stdout : stdout.toString("utf8"),
          stderr: stderr.toString("utf8"),
        });
      },
    );
  });
}
