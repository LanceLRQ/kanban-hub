/**
 * 按文件扩展名判断文档在网页里怎么显示，以及 `/raw` 响应的 `Content-Type`。
 * 只看扩展名，不嗅探内容——嗅探内容超出这两处的需要，反而会把不认识的格式误判成别的类型。
 * 认不出扩展名的文件是否按文本显示，需要读内容才能确定，由调用方（`server/views/docs.ts`）
 * 结合 `extensionKnown` 做一次嗅探，这里只保留“先按二进制处理”的默认判断。
 */

export type ContentKind = "markdown" | "text" | "image" | "html" | "svg" | "pdf" | "binary" | "too-large";

/** Markdown 渲染的大小上限：2MB */
export const MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
/** 其他文本高亮的大小上限：1MB */
export const TEXT_MAX_BYTES = 1024 * 1024;

type BaseKind = Exclude<ContentKind, "too-large">;

const MARKDOWN_EXTS = new Set(["md", "markdown"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico"]);
const HTML_EXTS = new Set(["html", "htm"]);
const SVG_EXTS = new Set(["svg"]);
const PDF_EXTS = new Set(["pdf"]);
/** 认得出的文本扩展名；没有列在这里的（含没有扩展名的文件，如 LICENSE、Makefile）需要读内容才能判断是不是文本 */
const TEXT_EXTS = new Set([
  "txt", "json", "yaml", "yml", "toml", "ini", "conf", "env", "csv", "log", "xml",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "css", "scss", "less",
  "sh", "bash", "zsh", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "cc", "cpp", "h", "hpp",
  "sql", "graphql", "gql", "diff", "patch",
]);

function extOf(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

function baseKindOf(filePath: string): BaseKind {
  const ext = extOf(filePath);
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  if (SVG_EXTS.has(ext)) return "svg";
  if (PDF_EXTS.has(ext)) return "pdf";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (TEXT_EXTS.has(ext)) return "text";
  return "binary";
}

/** 扩展名是否在上面这几张表里；返回 false 时，`binary` 只是嗅探前的默认猜测，不是最终结论 */
export function extensionKnown(filePath: string): boolean {
  const ext = extOf(filePath);
  return MARKDOWN_EXTS.has(ext) || HTML_EXTS.has(ext) || SVG_EXTS.has(ext) || PDF_EXTS.has(ext) || IMAGE_EXTS.has(ext) || TEXT_EXTS.has(ext);
}

/** 按路径与大小判断显示方式；只有 markdown/text 各自的大小上限会产生 too-large */
export function contentKindOf(filePath: string, size: number): ContentKind {
  const base = baseKindOf(filePath);
  if (base === "markdown" && size > MARKDOWN_MAX_BYTES) return "too-large";
  if (base === "text" && size > TEXT_MAX_BYTES) return "too-large";
  return base;
}

const MIME_BY_BASE_KIND: Record<BaseKind, string> = {
  markdown: "text/markdown",
  text: "text/plain",
  html: "text/html",
  binary: "application/octet-stream",
  pdf: "application/pdf",
  svg: "image/svg+xml",
  image: "application/octet-stream", // 图片按具体扩展名另查，这里只是兜底
};

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

/** `/raw` 响应的 Content-Type：文本类带 charset=utf-8，未知类型用 application/octet-stream */
export function contentTypeOf(filePath: string): string {
  const base = baseKindOf(filePath);
  if (base === "image") return IMAGE_MIME[extOf(filePath)] ?? "application/octet-stream";
  const mime = MIME_BY_BASE_KIND[base];
  if (base === "markdown" || base === "text" || base === "html") return `${mime}; charset=utf-8`;
  return mime;
}
