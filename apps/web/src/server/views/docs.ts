import { looksBinary } from "@kanban-hub/core/pull";
import type { ManifestFile, SnapshotManifest } from "@kanban-hub/core/sync";
import type { Services } from "@/server/services";
import { rawTokenSecret, signRawToken } from "@/server/auth/raw-token";
import { contentKindOf, extensionKnown, TEXT_MAX_BYTES, type ContentKind } from "@/lib/content-type";
import { buildDocTree, type DocTreeNode } from "@/lib/doc-tree";
import { rawFileHref } from "@/lib/doc-url";
import { formatRelative } from "@/lib/time";

export interface DocsMachineOption {
  id: string;
  name: string;
  lastSyncAt: string | null;
  lastSyncAtLabel: string | null;
  selected: boolean;
}

export interface DocsRecentEntry {
  path: string;
  changedAt: string;
  changedAtLabel: string;
}

/** 当前显示的文件；`exists` 为 false 时说明请求的路径不在这台机器的快照里，其余字段一律为空 */
export interface DocsFileView {
  path: string;
  machineId: string;
  exists: boolean;
  size: number | null;
  changedAt: string | null;
  kind: ContentKind | null;
  /** markdown/其他文本的原始内容（未渲染，渲染留给页面组件做）；不适用（图片/html/二进制/超限）时为 null */
  content: string | null;
  rawHref: string;
}

export interface DocsView {
  machines: DocsMachineOption[];
  tree: DocTreeNode[];
  /** 选中的机器当前清单里的全部路径，供页面构造链接改写用的上下文 */
  filePaths: string[];
  recent: DocsRecentEntry[];
  file: DocsFileView | null;
  rawToken: { token: string; expiresAt: string } | null;
  /** 这个项目还没有任何机器同步过文档时的原因码；由页面/接口挑选对应的中文文案 */
  emptyReason: "no-sync" | null;
}

export interface DocsViewOptions {
  machineId?: string;
  path?: string;
}

const RECENT_LIMIT = 10;

function machineName(services: Services, machineId: string): string {
  return services.store.auth.getMachine(machineId)?.name ?? machineId;
}

/** 根目录 README.md → 同步范围内第一个 README.md（按路径排序）→ 第一个 .md 文件；都没有则 null */
function pickDefaultPath(files: readonly ManifestFile[]): string | null {
  if (files.some((f) => f.path === "README.md")) return "README.md";
  const readmes = files
    .filter((f) => (f.path.split("/").pop() ?? "").toLowerCase() === "readme.md")
    .map((f) => f.path)
    .sort();
  if (readmes.length > 0) return readmes[0]!;
  const mds = files
    .filter((f) => f.path.toLowerCase().endsWith(".md"))
    .map((f) => f.path)
    .sort();
  return mds[0] ?? null;
}

interface Candidate {
  machineId: string;
  lastSyncAt: string | null;
  manifest: SnapshotManifest;
}

function timeOf(lastSyncAt: string | null): number {
  return lastSyncAt ? Date.parse(lastSyncAt) : -Infinity;
}

/**
 * 项目不存在时返回 null。没有任何机器同步过文档时 `emptyReason` 为 `"no-sync"`，
 * 其余字段一律为空。选中的机器：显式传 `machineId` 且有快照时用它，否则取 `lastSyncAt`
 * 最新的一台；当前文件：显式传 `path` 时用它（不在清单里时 `file.exists` 为 false），
 * 否则按默认规则选文件（见 `pickDefaultPath`）。
 */
export async function buildDocsView(services: Services, projectId: string, opts: DocsViewOptions, now: Date): Promise<DocsView | null> {
  const project = services.store.getProject(projectId);
  if (!project) return null;

  const candidates: Candidate[] = project.locations
    .map((loc) => ({ machineId: loc.machineId, lastSyncAt: loc.lastSyncAt, manifest: services.store.getSnapshotManifest(projectId, loc.machineId) }))
    .filter((c): c is Candidate => c.manifest !== null);

  if (candidates.length === 0) {
    return { machines: [], tree: [], filePaths: [], recent: [], file: null, rawToken: null, emptyReason: "no-sync" };
  }

  const requested = opts.machineId !== undefined ? candidates.find((c) => c.machineId === opts.machineId) : undefined;
  const selected =
    requested ?? candidates.reduce((best, c) => (timeOf(c.lastSyncAt) > timeOf(best.lastSyncAt) ? c : best));

  const machines: DocsMachineOption[] = [...candidates]
    .sort((a, b) => timeOf(b.lastSyncAt) - timeOf(a.lastSyncAt))
    .map((c) => ({
      id: c.machineId,
      name: machineName(services, c.machineId),
      lastSyncAt: c.lastSyncAt,
      lastSyncAtLabel: c.lastSyncAt !== null ? formatRelative(c.lastSyncAt, now) : null,
      selected: c.machineId === selected.machineId,
    }));

  const files = selected.manifest.files;
  const filePaths = files.map((f) => f.path);
  const tree = buildDocTree(filePaths);
  const recent: DocsRecentEntry[] = [...files]
    .sort((a, b) => {
      const byTime = Date.parse(b.changedAt) - Date.parse(a.changedAt);
      return byTime !== 0 ? byTime : a.path < b.path ? -1 : 1;
    })
    .slice(0, RECENT_LIMIT)
    .map((f) => ({ path: f.path, changedAt: f.changedAt, changedAtLabel: formatRelative(f.changedAt, now) }));

  const rawSecret = rawTokenSecret(services.store.auth.sessionSecret());
  const rawToken = signRawToken(rawSecret, { projectId, machineId: selected.machineId }, now);

  const requestedPath = opts.path ?? pickDefaultPath(files);
  const file = requestedPath === null ? null : await buildFileView(services, projectId, selected.machineId, files, requestedPath, rawToken.token);

  return { machines, tree, filePaths, recent, file, rawToken, emptyReason: null };
}

async function buildFileView(
  services: Services,
  projectId: string,
  machineId: string,
  files: readonly ManifestFile[],
  requestedPath: string,
  rawToken: string,
): Promise<DocsFileView> {
  const entry = files.find((f) => f.path === requestedPath);
  const rawHref = rawFileHref(rawToken, requestedPath);
  if (!entry) {
    return { path: requestedPath, machineId, exists: false, size: null, changedAt: null, kind: null, content: null, rawHref };
  }

  let kind = contentKindOf(entry.path, entry.size);
  // 扩展名认不出时，contentKindOf 先猜 binary；不超过文本上限就读一次内容，交给
  // core 的 looksBinary 判断是不是文本（LICENSE、Makefile、.gitignore 这类没有固定扩展名的
  // 文本文件很常见，不能仅凭扩展名就归为二进制）
  const needsSniff = kind === "binary" && !extensionKnown(entry.path) && entry.size <= TEXT_MAX_BYTES;

  let bytes: Uint8Array | null = null;
  if (kind === "markdown" || kind === "text" || needsSniff) {
    bytes = await services.store.readSnapshotFile(projectId, machineId, entry.path);
  }
  if (needsSniff && bytes !== null && !looksBinary(bytes)) {
    kind = "text";
  }

  let content: string | null = null;
  if ((kind === "markdown" || kind === "text") && bytes !== null) {
    content = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  }

  return { path: entry.path, machineId, exists: true, size: entry.size, changedAt: entry.changedAt, kind, content, rawHref };
}
