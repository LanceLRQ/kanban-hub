// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import settings from "../../../messages/zh-CN/settings.json";
import { UpgradePromptSection } from "./upgrade-prompt-section";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const { toast } = await import("sonner");

const PROMPT = (settings.upgrade as { prompt: string }).prompt;

let container: HTMLDivElement;
let root: Root;
let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.getSelection()?.removeAllRanges();
});

function mount() {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="zh-CN" messages={{ settings }}>
        <UpgradePromptSection />
      </NextIntlClientProvider>,
    );
  });
}

/** 给 navigator.clipboard 换上可控的替身 */
function stubClipboard(impl: () => Promise<void>): void {
  writeText = vi.fn(impl);
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
}

const clickCopy = () =>
  act(async () => {
    [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("复制提示词"))!.click();
  });

describe("UpgradePromptSection 升级提示词", () => {
  it("渲染说明与完整提示词", () => {
    stubClipboard(() => Promise.resolve());
    mount();
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe(PROMPT);
    expect(container.textContent).toContain("发给部署了看板服务端的那台机器上的 AI 助手");
  });

  it("提示词不写死版本号，升级目标由 AI 查最新版得到", () => {
    stubClipboard(() => Promise.resolve());
    mount();
    expect(PROMPT).toContain("releases/latest");
    // 不含 v0.x.x 或镜像标签式的具体版本（127.0.0.1 这类 IP 不算）
    expect(PROMPT).not.toMatch(/[v:]0\.\d+\.\d+/);
  });

  it("点击复制：整段提示词进剪贴板，按钮短暂变成已复制", async () => {
    stubClipboard(() => Promise.resolve());
    mount();
    await clickCopy();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(container.textContent).toContain("已复制");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("剪贴板不可用：全选提示词兜底并提示手动复制，不算成功", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    mount();
    await clickCopy();
    const selected = window.getSelection()?.toString() ?? "";
    expect(selected).toContain("kanban-hub（看板服务端）");
    expect(container.textContent).not.toContain("已复制");
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
