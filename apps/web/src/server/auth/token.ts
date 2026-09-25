import { createHash, randomBytes } from "node:crypto";
import { machineTokenSchema } from "@kanban-hub/core/api";

const TOKEN_PREFIX = "kh_";
const TOKEN_RANDOM_BYTES = 32;

/** 生成新的机器令牌明文；永久有效，只在网页上吊销才失效 */
export function generateMachineToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

/** 令牌入库前的哈希，与密码哈希不同：令牌本身熵已经足够，用普通 sha256 即可 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 查表前的格式快速校验，用于拒绝明显不对的输入；格式定义与 kh 共用（core 的 machineTokenSchema） */
export function isMachineTokenFormat(value: string): boolean {
  return machineTokenSchema.safeParse(value).success;
}
