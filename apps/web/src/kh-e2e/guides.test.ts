/**
 * skill 正文与两份接入引导里提到的 kh 命令、选项，都必须真实存在于命令树里。
 */
import { describe, expect, it } from "vitest";
import { buildProgram } from "../../../../packages/cli/src/program";
import { SKILL_MD } from "../../../../packages/cli/src/setup/skill";
import { makeKhContext } from "./harness";
import { renderAgentGuide, renderMigrateGuide } from "../server/setup-guides";

const { ctx } = makeKhContext({ cwd: "/", khHome: "/nonexistent-kh-home" });

/** 只用到的 commander Command 结构：web 与 cli 解析到的 commander 类型声明不是同一份，这里按结构取用 */
interface Command {
  name(): string;
  aliases(): string[];
  commands: Command[];
  options: { long?: string; short?: string }[];
  parent: Command | null;
}

const program = buildProgram(ctx) as unknown as Command;

/** 每份正文：内容，以及一定要被抽取到的关键命令（抽取规则退化时靠它们报警） */
const sources: Record<string, { text: string; expected: string[] }> = {
  SKILL_MD: { text: SKILL_MD, expected: ["status", "task set", "task add", "task human", "log", "project set", "docs ls", "conflicts show", "import", "export"] },
  "agent.md": { text: renderAgentGuide("http://kh.example.test"), expected: ["login", "setup"] },
  "migrate.md": { text: renderMigrateGuide("http://kh.example.test"), expected: ["register", "import", "status"] },
};

/** 整棵命令树声明过的全部选项（长、短名的并集） */
function allDeclaredFlags(cmd: Command, acc = new Set<string>(["-h", "--help", "-v", "--version"])): Set<string> {
  for (const o of cmd.options) {
    if (o.long) acc.add(o.long);
    if (o.short) acc.add(o.short);
  }
  for (const c of cmd.commands) allDeclaredFlags(c, acc);
  return acc;
}

function child(cmd: Command, name: string): Command | undefined {
  return cmd.commands.find((c) => c.name() === name || c.aliases().includes(name));
}

/** 取出所有以 `kh ` 开头的行内代码片段和代码块里的命令行 */
function commandLines(text: string): string[] {
  const lines: string[] = [];
  for (const m of text.matchAll(/`([^`\n]*\bkh\s[^`\n]*)`/g)) lines.push(m[1]!);
  let inFence = false;
  for (const raw of text.split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) lines.push(raw);
  }
  return lines;
}

interface Ref {
  path: string[];
  options: string[];
  line: string;
}

function parseRefs(text: string): Ref[] {
  const refs: Ref[] = [];
  for (const line of commandLines(text)) {
    const idx = line.search(/(^|[\s$>])kh(\s|$)/);
    if (idx < 0) continue;
    const rest = line.slice(line.indexOf("kh", idx) + 2).trim();
    const tokens = rest.split(/\s+/);
    let cmd: Command = program;
    const cmdPath: string[] = [];
    for (const tok of tokens) {
      if (tok.startsWith("-") || tok.startsWith("<") || tok.startsWith("[") || tok.startsWith('"') || tok.startsWith("'")) break;
      const next = child(cmd, tok);
      if (!next) {
        // 只有紧跟在 kh（或已识别的分组命令）之后的小写词才当作子命令引用
        if (/^[a-z][a-z-]*$/.test(tok) && (cmd === program || cmd.commands.length > 0)) cmdPath.push(tok);
        break;
      }
      cmd = next;
      cmdPath.push(tok);
    }
    const options = [...rest.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)].map((m) => m[1]!);
    if (cmdPath.length > 0) refs.push({ path: cmdPath, options, line });
  }
  return refs;
}

function resolve(cmdPath: string[]): Command | undefined {
  let cmd: Command = program;
  for (const seg of cmdPath) {
    const next = child(cmd, seg);
    if (!next) return undefined;
    cmd = next;
  }
  return cmd;
}

function declaresOption(cmd: Command, flag: string): boolean {
  const chain: Command[] = [];
  for (let c: Command | null = cmd; c; c = c.parent) chain.push(c);
  const builtin = ["-h", "--help", "-v", "--version"];
  if (builtin.includes(flag)) return true;
  return chain.some((c) => c.options.some((o) => o.long === flag || o.short === flag));
}

describe.each(Object.entries(sources))("%s 里的 kh 命令", (_name, { text, expected }) => {
  const refs = parseRefs(text);

  it("至少引用了一条命令", () => {
    expect(refs.length).toBeGreaterThan(0);
  });

  it("每条命令在命令树里存在", () => {
    const missing = refs.filter((r) => resolve(r.path) === undefined).map((r) => `kh ${r.path.join(" ")}（${r.line.trim()}）`);
    expect(missing).toEqual([]);
  });

  it("每个选项都由对应命令声明过", () => {
    const missing: string[] = [];
    for (const r of refs) {
      const cmd = resolve(r.path);
      if (!cmd) continue;
      for (const flag of r.options) {
        if (!declaresOption(cmd, flag)) missing.push(`kh ${r.path.join(" ")} ${flag}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("关键命令确实被抽取到", () => {
    const found = new Set(refs.map((r) => r.path.join(" ")));
    expect(expected.filter((c) => !found.has(c))).toEqual([]);
  });

  it("正文里每个独立出现的 --选项（不限于 kh 命令所在的行）都在命令树里声明过", () => {
    const declared = allDeclaredFlags(program);
    const flags = new Set([...text.matchAll(/(?<![\w-])(--[a-z][\w-]*)/g)].map((m) => m[1]!));
    expect(flags.size).toBeGreaterThan(0);
    expect([...flags].filter((f) => !declared.has(f))).toEqual([]);
  });
});
