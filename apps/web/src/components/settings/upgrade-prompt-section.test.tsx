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

const SERVER = "http://10.0.0.5:38970";
/** 组件把 {serverUrl} 插进提示词后应得到的正文 */
const promptFilled = (settings.upgrade as { prompt: string }).prompt.replaceAll("{serverUrl}", SERVER);

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

function mount(serverUrl = SERVER) {
  act(() => {
    root.render(
      <NextIntlClientProvider locale="zh-CN" messages={{ settings }}>
        <UpgradePromptSection serverUrl={serverUrl} />
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

describe("UpgradePromptSection 升级 kh 与 skill 提示词", () => {
  it("渲染说明与完整提示词，服务端地址已插进正文", () => {
    stubClipboard(() => Promise.resolve());
    mount();
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe(promptFilled);
    expect(pre?.textContent).toContain(`npm i -g ${SERVER}/setup/kh.tgz`);
    expect(pre?.textContent).toContain("kh setup --yes");
    expect(container.textContent).toContain("发给各台开发机上的 AI 助手");
  });

  it("地址解析不出时用占位符，提示词仍然完整", () => {
    stubClipboard(() => Promise.resolve());
    mount("");
    const text = container.querySelector("pre")?.textContent ?? "";
    expect(text).toContain("<服务端地址>");
    expect(text).toContain("npm i -g <服务端地址>/setup/kh.tgz");
  });

  it("提示词只管升级 kh 与 skill，不含升级服务端的步骤", () => {
    stubClipboard(() => Promise.resolve());
    mount();
    const text = container.querySelector("pre")?.textContent ?? "";
    expect(text).not.toContain("docker compose");
    expect(text).not.toContain("kanban-hub.sh upgrade");
  });

  it("点击复制：整段提示词进剪贴板，按钮短暂变成已复制", async () => {
    stubClipboard(() => Promise.resolve());
    mount();
    await clickCopy();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(promptFilled);
    expect(container.textContent).toContain("已复制");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("剪贴板不可用：全选提示词兜底并提示手动复制，不算成功", async () => {
    stubClipboard(() => Promise.reject(new Error("denied")));
    mount();
    await clickCopy();
    const selected = window.getSelection()?.toString() ?? "";
    expect(selected).toContain("kanban-hub 命令行 kh");
    expect(container.textContent).not.toContain("已复制");
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
