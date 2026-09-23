import os from "node:os";
import path from "node:path";

export interface ServerPaths {
  dataDir: string;
  backupDir: string;
  /** 在容器里运行时，目录必须由挂载提供，不允许自动创建 */
  inContainer: boolean;
}

// env 不用 NodeJS.ProcessEnv：Next 的全局声明把其中的 NODE_ENV 定为必填，测试里传部分字段会编译失败
export function resolveServerPaths(
  env: Record<string, string | undefined> = process.env,
  homeDir: string = os.homedir(),
): ServerPaths {
  const base = path.join(homeDir, ".kanban-hub", "server");
  return {
    dataDir: env.KH_DATA_DIR || path.join(base, "data"),
    backupDir: env.KH_BACKUP_DIR || path.join(base, "backups"),
    inContainer: env.KH_IN_CONTAINER === "1",
  };
}
