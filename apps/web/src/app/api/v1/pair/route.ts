import { pairInput } from "@kanban-hub/core/api";
import { clientKey } from "@/server/auth/rate-limit";
import { generateMachineToken, hashToken } from "@/server/auth/token";
import { ApiError } from "@/server/api/errors";
import { json, readJson } from "@/server/api/http";
import { apiRoute } from "@/server/api/route";

// 调用方是 kh，不是浏览器，不做同源校验
export const POST = apiRoute({ auth: "none" }, async ({ req, services }) => {
  const key = `pair:${clientKey(req.headers)}`;
  const limit = services.limiter.check(key);
  if (limit.blocked) {
    throw new ApiError("rate_limited", "配对尝试过于频繁，请稍后再试", { retryAfterSeconds: limit.retryAfterSec });
  }

  const input = await readJson(req, pairInput);

  const grant = services.pairing.consume(input.code);
  if (!grant) {
    services.limiter.recordFailure(key);
    throw new ApiError("unauthorized", "配对码无效或已过期");
  }

  const token = generateMachineToken();
  try {
    const machine = await services.store.auth.createMachine({
      name: input.machineName,
      userId: grant.userId,
      os: input.os,
      tokenHash: hashToken(token),
    });
    return json({ token, machineId: machine.id }, { status: 201 });
  } catch (e) {
    // 配对码已经被兑换掉了，创建机器失败时放回去，不然这个配对码就白白浪费了
    services.pairing.restore(grant);
    throw e;
  }
});
