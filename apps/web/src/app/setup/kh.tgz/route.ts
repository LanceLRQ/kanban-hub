import fs from "node:fs/promises";
import { HEADER_KH_VERSION } from "@kanban-hub/core/api";
import { KH_VERSION } from "@kanban-hub/core/version";

// 安装包是否存在取决于部署方式（Docker 镜像里打包，非 Docker 部署可能没配），
// 不能在构建期静态化，每次请求都要真实读一次文件系统。
export const dynamic = "force-dynamic";

function notFound(): Response {
  return new Response("安装包尚未配置，请联系管理员\n", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/**
 * 下发与服务端版本一致的 kh 安装包（规格：npm i -g <服务端地址>/setup/kh.tgz）。
 * 路径来自 KH_CLI_PACKAGE：开发脚本指向 packages/cli/dist/kh.tgz，镜像里指向 /app/kh.tgz。
 * 不在 /api/v1 下，不走 apiRoute，不需要鉴权；安装包不存在只影响这一个接口，不影响自检。
 */
export async function GET(): Promise<Response> {
  const packagePath = process.env.KH_CLI_PACKAGE || null;
  if (!packagePath) return notFound();

  let bytes: Buffer;
  try {
    bytes = await fs.readFile(packagePath);
  } catch {
    return notFound();
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="kh-${KH_VERSION}.tgz"`,
      "Cache-Control": "no-store",
      [HEADER_KH_VERSION]: KH_VERSION,
    },
  });
}
