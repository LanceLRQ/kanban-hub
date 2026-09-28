/**
 * 只读地访问其他机器的同步快照：取聚合后的“对方最新版本”、取某台机器自己的清单、
 * 下载某个文件的内容并核对 hash、把 --from 的写法（机器名或 ID 前缀）解析成具体机器。
 * kh sync 走 push.ts；这里只服务 kh docs 以及未来的 kh pull。
 */
import { createHash } from "node:crypto";
import {
  HEADER_KH_SHA256,
  latestManifestResponse,
  snapshotManifestResponse,
  type LatestManifestResponse,
  type SnapshotManifestResponse,
} from "@kanban-hub/core/api";
import { CliError, EXIT } from "../errors";
import type { ApiClient } from "../http/client";

export interface RemoteMachineRef {
  id: string;
  name: string;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * GET /projects/:id/snapshots/latest-manifest：按路径挑出每台机器里最新的版本。
 * excludeMachineId 传 null 时不排除任何机器（本机也会出现在 machines 列表里）。
 */
export function fetchLatestRemote(
  client: ApiClient,
  projectId: string,
  excludeMachineId: string | null,
): Promise<LatestManifestResponse> {
  const query = excludeMachineId !== null ? `?exclude=${encodeURIComponent(excludeMachineId)}` : "";
  return client.get(`/api/v1/projects/${projectId}/snapshots/latest-manifest${query}`, latestManifestResponse);
}

/**
 * GET /projects/:id/snapshots/:machineId/manifest：某一台机器自己的清单。
 * 这台机器还没有同步过这个项目时，服务端返回 404（映射成数据错误，退出码 5）。
 */
export function fetchMachineManifest(
  client: ApiClient,
  projectId: string,
  machineId: string,
): Promise<SnapshotManifestResponse> {
  return client.get(`/api/v1/projects/${projectId}/snapshots/${machineId}/manifest`, snapshotManifestResponse);
}

function encodeRepoPath(filePath: string): string {
  return filePath
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

/**
 * 下载某台机器快照里的一个文件，核对响应头 X-KH-Sha256 与内容的 hash 是否一致；
 * 不一致时说明下载不完整或被篡改，报错并提示重试（退出码 1）。
 */
export async function fetchRemoteFile(
  client: ApiClient,
  projectId: string,
  machineId: string,
  filePath: string,
): Promise<Uint8Array> {
  const { bytes, headers } = await client.getBytes(
    `/api/v1/projects/${projectId}/snapshots/${machineId}/files/${encodeRepoPath(filePath)}`,
  );
  const expected = headers.get(HEADER_KH_SHA256);
  const actual = sha256Hex(bytes);
  if (expected !== null && expected.toLowerCase() !== actual) {
    throw new CliError(EXIT.UNEXPECTED, `下载内容的 hash 与响应头不一致：${filePath}`, "请重试");
  }
  return bytes;
}

function describeMachines(machines: readonly RemoteMachineRef[]): string {
  return machines.map((m) => `${m.name}（${m.id}）`).join("、");
}

/**
 * 解析 --from：先按机器名精确匹配，唯一命中就用；否则按机器 ID 前缀（不区分大小写）匹配。
 * 写法本身没有问题，但找不到匹配或匹配到多个都算用法错误（退出码 2）。
 */
export function resolveMachineRef(ref: string, machines: readonly RemoteMachineRef[]): RemoteMachineRef {
  const byName = machines.filter((m) => m.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new CliError(EXIT.USAGE, `--from ${ref} 匹配到多台同名机器，请改用机器 ID`, describeMachines(byName));
  }

  const lower = ref.toLowerCase();
  const byId = machines.filter((m) => m.id.toLowerCase().startsWith(lower));
  if (byId.length === 1) return byId[0]!;
  if (byId.length > 1) {
    throw new CliError(EXIT.USAGE, `--from ${ref} 匹配到多台机器，请写更精确的 ID`, describeMachines(byId));
  }

  throw new CliError(EXIT.USAGE, `找不到匹配 --from ${ref} 的机器`);
}
