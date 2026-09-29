/**
 * kh import / kh export：把写好的 YAML 导入当前仓库的项目，或把看板导出成 YAML / Markdown。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { parseDocument } from "yaml";
import { importResponse } from "@kanban-hub/core/api";
import { formatZodError } from "@kanban-hub/core/errors";
import { CYCLE_LABELS, HEALTH_LABELS, TASK_STATUS_LABELS } from "@kanban-hub/core/labels";
import { transferDocSchema, type ImportSummary } from "@kanban-hub/core/transfer";
import type { CliContext } from "../context";
import { CliError, EXIT } from "../errors";
import { isNoEntError, writeFileAtomic } from "../fs-utils";
import { afterReport, displayEmpty, globalAgentFlag, requireLogin, requireRegisteredRepo, withAgentOption } from "./shared";

/** 每组最多列出的行数，多出的折成“另有 N 项” */
const MAX_LISTED = 30;

const INVALID_HINT = "文本字段里的数字、true/false 需要加引号，例如 code: \"1.10\"";

/** 读导入文件：文件不存在或读不了都是用法错误（2） */
async function readImportFile(ctx: CliContext, file: string): Promise<string> {
  const abs = path.resolve(ctx.cwd, file);
  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    if (isNoEntError(err)) throw new CliError(EXIT.USAGE, `找不到文件：${file}`);
    throw new CliError(EXIT.USAGE, `无法读取文件：${file}`, err instanceof Error ? err.message : undefined);
  }
}

/** 按 YAML 1.2 解析：拒绝 %YAML 1.1 指令；语法错误（含重复的键）带行号和列号，退出码 5 */
export function parseTransferYaml(text: string): unknown {
  const doc = parseDocument(text, { version: "1.2", prettyErrors: true });
  const directive = doc.directives.yaml;
  if (directive.explicit && directive.version !== "1.2") {
    throw new CliError(EXIT.DATA, `不支持 %YAML ${directive.version} 指令`, "kh 按 YAML 1.2 解析，请删掉这一行 %YAML 指令");
  }
  if (doc.errors.length > 0) {
    const lines = doc.errors.map((e) => {
      const pos = e.linePos?.[0];
      const where = pos ? `第 ${pos.line} 行第 ${pos.col} 列：` : "";
      return `${where}${e.message.split("\n")[0]}`;
    });
    throw new CliError(EXIT.DATA, `YAML 语法错误：\n${lines.join("\n")}`);
  }
  return doc.toJS();
}

const FIELD_LABELS: Record<string, string> = { cycle: "周期", health: "健康度", focus: "当前焦点" };

function projectValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return displayEmpty(null);
  const s = String(value);
  if (field === "cycle") return (CYCLE_LABELS as Record<string, string>)[s] ?? s;
  if (field === "health") return (HEALTH_LABELS as Record<string, string>)[s] ?? s;
  return displayEmpty(s);
}

function statusLabel(status: string): string {
  return (TASK_STATUS_LABELS as Record<string, string>)[status] ?? status;
}

function section(title: string, lines: string[]): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MAX_LISTED).map((l) => `  ${l}`);
  if (lines.length > MAX_LISTED) shown.push(`  另有 ${lines.length - MAX_LISTED} 项`);
  return [`${title}（${lines.length}）`, ...shown];
}

/** 导入结果里有没有任何实际变化（含只改状态的任务）；输出与上报时间共用这一个判断 */
export function hasImportChanges(s: ImportSummary): boolean {
  return (
    s.project.length > 0 ||
    s.containers.created.length > 0 ||
    s.containers.updated.length > 0 ||
    s.tasks.created.length > 0 ||
    s.tasks.updated.length > 0 ||
    s.tasks.statusChanges.length > 0 ||
    s.events.added > 0
  );
}

/** 把导入结果渲染成按组列出的文字；没有任何变化时只输出一句话 */
export function renderImportSummary(s: ImportSummary): string {
  const groups = [
    section(
      "项目字段",
      s.project.map((p) => `${FIELD_LABELS[p.field] ?? p.field}：${projectValue(p.field, p.from)} → ${projectValue(p.field, p.to)}`),
    ),
    section(
      "新建容器",
      s.containers.created.map((c) => c.label),
    ),
    section(
      "更新容器",
      s.containers.updated.map((c) => `${c.label}（${c.fields.join("、")}）`),
    ),
    section(
      "新建任务",
      s.tasks.created.map((t) => `${t.container} ${t.title}`),
    ),
    section(
      "更新任务",
      s.tasks.updated.map((t) => `${t.container} ${t.title}（${t.fields.join("、")}）`),
    ),
    section(
      "状态变化",
      s.tasks.statusChanges.map((t) => `${t.container} ${t.title}：${statusLabel(t.from)} → ${statusLabel(t.to)}`),
    ),
  ];
  const logsLine =
    s.events.added > 0 ? [`历史日志：新增 ${s.events.added} 条${s.events.duplicates > 0 ? `，${s.events.duplicates} 条已存在` : ""}`] : [];
  const body = [...groups.flat(), ...logsLine];
  if (!hasImportChanges(s)) return "没有需要导入的变化\n";
  const title = s.dryRun ? "将要导入以下变化（没有写入任何数据）：" : "已导入：";
  return `${title}\n${body.join("\n")}\n`;
}

async function runImport(ctx: CliContext, file: string, dryRun: boolean, agentFlag: string | undefined): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  const raw = parseTransferYaml(await readImportFile(ctx, file));

  const parsed = transferDocSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CliError(EXIT.DATA, `导入文件不合法：\n${formatZodError(parsed.error).join("\n")}`, INVALID_HINT);
  }

  const projectId = repo.config.projectId;
  const query = dryRun ? "?dryRun=1" : "";
  const summary = await client.post(`/api/v1/projects/${projectId}/import${query}`, parsed.data, importResponse);
  ctx.stdout.write(renderImportSummary(summary));

  if (dryRun) return;
  if (hasImportChanges(summary)) await afterReport(ctx, projectId);
}

async function runExport(ctx: CliContext, opts: { md?: boolean; output?: string }, agentFlag: string | undefined): Promise<void> {
  const repo = await requireRegisteredRepo(ctx);
  const { client } = await requireLogin(ctx, agentFlag);
  const format = opts.md ? "md" : "yaml";
  const { bytes } = await client.getBytes(`/api/v1/projects/${repo.config.projectId}/export?format=${format}`);

  if (opts.output === undefined) {
    ctx.stdout.write(bytes);
    return;
  }
  const target = path.resolve(ctx.cwd, opts.output);
  try {
    await writeFileAtomic(target, bytes);
  } catch (err) {
    throw new CliError(EXIT.USAGE, `无法写入文件：${opts.output}`, err instanceof Error ? err.message : undefined);
  }
  ctx.stderr.write(`已导出到 ${opts.output}\n`);
}

export function registerTransfer(program: Command, ctx: CliContext): void {
  withAgentOption(
    program
      .command("import")
      .description("把 YAML 文件导入当前仓库的项目")
      .argument("<文件>", "导入文件（kanban-hub/v1 格式）")
      .option("--dry-run", "只显示将要发生的变化，不写入任何数据"),
  ).action(async (file: string, opts: { dryRun?: boolean }, cmd: Command) => {
    await runImport(ctx, file, opts.dryRun === true, globalAgentFlag(cmd));
  });

  withAgentOption(
    program
      .command("export")
      .description("导出当前仓库项目的看板（默认 YAML，写到标准输出）")
      .option("--md", "导出成 Markdown")
      .option("-o, --output <文件>", "写到这个文件（父目录必须已存在）"),
  ).action(async (opts: { md?: boolean; output?: string }, cmd: Command) => {
    await runExport(ctx, opts, globalAgentFlag(cmd));
  });
}
