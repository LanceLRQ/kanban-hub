/** 文档树：由一份扁平的路径列表（快照清单里的 path）构造嵌套结构，供左栏文件树渲染 */

export interface DocTreeFile {
  type: "file";
  name: string;
  path: string;
}

export interface DocTreeDir {
  type: "dir";
  name: string;
  path: string;
  children: DocTreeNode[];
}

export type DocTreeNode = DocTreeDir | DocTreeFile;

interface MutableDir {
  name: string;
  path: string;
  dirs: Map<string, MutableDir>;
  files: DocTreeFile[];
}

function rootDir(): MutableDir {
  return { name: "", path: "", dirs: new Map(), files: [] };
}

function insert(root: MutableDir, filePath: string): void {
  const segments = filePath.split("/");
  const fileName = segments.pop()!;
  let cursor = root;
  let currentPath = "";
  for (const seg of segments) {
    currentPath = currentPath === "" ? seg : `${currentPath}/${seg}`;
    let next = cursor.dirs.get(seg);
    if (!next) {
      next = { name: seg, path: currentPath, dirs: new Map(), files: [] };
      cursor.dirs.set(seg, next);
    }
    cursor = next;
  }
  cursor.files.push({ type: "file", name: fileName, path: filePath });
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function finalize(dir: MutableDir): DocTreeNode[] {
  const dirs: DocTreeDir[] = [...dir.dirs.values()]
    .sort(byName)
    .map((d) => ({ type: "dir", name: d.name, path: d.path, children: finalize(d) }));
  const files = [...dir.files].sort(byName);
  return [...dirs, ...files];
}

/** 目录排在文件前面，同一层内各自按名称排序；多层嵌套按路径的 `/` 逐段展开 */
export function buildDocTree(paths: readonly string[]): DocTreeNode[] {
  const root = rootDir();
  for (const p of paths) insert(root, p);
  return finalize(root);
}
