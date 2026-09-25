import { execFile } from "node:child_process";
import { CliError, EXIT } from "../errors";

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * 调用 git：用 execFile 加参数数组，不经过 shell。
 * M3 只应该拿它执行只读命令（rev-parse、rev-list），status、add 这类可能改动索引的命令不要用它。
 */
export function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } },
      (err, stdout, stderr) => {
        if (err !== null && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new CliError(EXIT.UNEXPECTED, "找不到 git 可执行文件", "请安装 git 后重试"));
          return;
        }
        resolve({ ok: err === null, stdout, stderr });
      },
    );
  });
}
