/** kh 的进程退出码（规格 10.3 之外加 1，表示其他意外错误） */
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  AUTH: 3,
  UNREACHABLE: 4,
  DATA: 5,
  INCOMPATIBLE: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** kh 命令行的业务错误：带上退出码和可选的下一步提示，main() 据此渲染 stderr */
export class CliError extends Error {
  constructor(
    readonly exitCode: ExitCode,
    message: string,
    readonly hint?: string,
    /** 服务端错误响应里的 error.details（例如 missingBlobs），没有则为 undefined */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
  }
}
