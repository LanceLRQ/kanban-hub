import type { AuthRepo } from "../store/auth";
import { hashPassword, verifyPassword, type ScryptCostParams } from "./password";

export type AdminSyncResult = "created" | "updated" | "unchanged";

/**
 * 按 KH_ADMIN_PASSWORD 同步管理员账号：没有管理员就新建一个（名字为 admin）；
 * 已有管理员但密码校验不通过，就用一次 updateUser 同时写入新哈希和 sessionVersion + 1，
 * 让旧的网页会话失效（已配对机器的令牌永久有效，不受影响）；密码一致时什么都不做。
 * params 是 scrypt 成本参数，供测试传低成本值加速用例，省略时用 hashPassword 的默认成本。
 */
export async function syncAdminPassword(
  auth: AuthRepo,
  password: string,
  params?: ScryptCostParams,
): Promise<AdminSyncResult> {
  const admin = auth.listUsers().find((u) => u.role === "admin");
  if (!admin) {
    await auth.createUser({ name: "admin", role: "admin", passwordHash: await hashPassword(password, params) });
    return "created";
  }

  if (await verifyPassword(password, admin.passwordHash)) return "unchanged";

  await auth.updateUser(admin.id, {
    passwordHash: await hashPassword(password, params),
    sessionVersion: admin.sessionVersion + 1,
  });
  return "updated";
}
