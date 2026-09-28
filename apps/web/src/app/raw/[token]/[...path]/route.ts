import { rawTokenSecret, verifyRawToken } from "@/server/auth/raw-token";
import { contentTypeOf } from "@/lib/content-type";
import { getServices } from "@/server/services";

// 令牌校验、快照读取都依赖运行期状态，不能在构建期静态化
export const dynamic = "force-dynamic";

const SANDBOX_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox allow-scripts allow-forms allow-popups",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "private, max-age=300",
};

function empty(status: number): Response {
  return new Response(null, { status, headers: SANDBOX_HEADERS });
}

/**
 * 快照文件的原始字节，不在 /api/v1 下、不走 apiRoute、不读 cookie，只靠令牌鉴权。
 * 路径处理与文档树/接口一致：Next 传进来的已解码片段用 `/` 拼接后，直接按该机器清单里的
 * 路径逐字匹配——不在清单里（含路径穿越拼出来的路径）一律 404，不会读到快照目录之外的文件。
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string; path?: string[] }> }): Promise<Response> {
  const { token, path } = await ctx.params;
  const filePath = (path ?? []).join("/");

  const services = getServices();
  const secret = rawTokenSecret(services.store.auth.sessionSecret());
  const verified = verifyRawToken(secret, token, services.now().getTime());
  if (verified === null) return empty(404);
  if (verified === "expired") return empty(403);

  const manifest = services.store.getSnapshotManifest(verified.projectId, verified.machineId);
  if (!manifest || !manifest.files.some((f) => f.path === filePath)) return empty(404);

  const bytes = await services.store.readSnapshotFile(verified.projectId, verified.machineId, filePath);
  if (bytes === null) return empty(404);

  return new Response(Buffer.from(bytes), {
    status: 200,
    headers: { ...SANDBOX_HEADERS, "Content-Type": contentTypeOf(filePath) },
  });
}
