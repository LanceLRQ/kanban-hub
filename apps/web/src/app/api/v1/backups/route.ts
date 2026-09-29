import { z } from "zod";
import { KhError } from "@kanban-hub/core/errors";
import { json, readJson } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

// 备份目录与创建进度都是运行期状态，不能在构建期静态化
export const dynamic = "force-dynamic";

/**
 * 创建备份的请求体：密码缺省或空串 = 不加密，最多 128 字符（与网页输入框上限一致）；
 * 空请求体按全部默认值处理。
 */
const backupCreateInput = z
  .object({
    password: z.string().max(128).optional(),
    includeGit: z.boolean().optional(),
  })
  .strict()
  .default({});

/**
 * 创建备份（同步请求）：响应完成时文件已经落盘，前端收到 201 后刷新列表即可看到。
 * 同一时刻只允许一份备份在创建，排队的第二个请求立即拿到 409。
 */
export const POST = apiRoute({ auth: "any" }, async ({ req, services }) => {
  const input = await readJson(req, backupCreateInput);
  // 校验与检查之间没有 await，判断和 createBackup 里置位之间不会插入其他请求
  if (services.store.backupRunning()) {
    throw new KhError("conflict", "已有备份正在进行中，请等它完成再试");
  }
  const backup = await services.store.createBackup(input);
  return json(backup, { status: 201 });
});

/** 列出备份目录里的备份，按创建时间倒序 */
export const GET = apiRoute({ auth: "any" }, ({ services }) => {
  return json({ backups: services.store.listBackups() });
});
