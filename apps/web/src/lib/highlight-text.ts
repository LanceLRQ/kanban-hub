/**
 * 非 Markdown 的文本文件（其他文本，超过大小上限的除外）：整份内容按扩展名高亮。
 * 不重新造一套高亮管线——把整份内容包成一个 Markdown 围栏代码块，交给
 * `components/docs/doc-markdown.tsx` 里已经装好的同一条渲染管线（含 rehype-highlight）处理。
 * 围栏的反引号数量比内容里最长的一串反引号多一个，避免内容本身提前把围栏截断。
 */

function languageOf(filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  const dot = name.lastIndexOf(".");
  return dot < 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

function fenceFor(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, r) => Math.max(max, r.length), 0);
  return "`".repeat(Math.max(longest + 1, 3));
}

/** 把纯文本包成一个围栏代码块字符串，语言按扩展名猜（猜不出时留空，交给渲染管线自行处理） */
export function wrapAsFencedCode(text: string, filePath: string): string {
  const fence = fenceFor(text);
  const body = text.endsWith("\n") ? text : `${text}\n`;
  return `${fence}${languageOf(filePath)}\n${body}${fence}\n`;
}
