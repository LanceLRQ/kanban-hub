import { describe, expect, it } from "vitest";
import { agentSentence, migrateSentence, type SentenceKey } from "./sentences";

const templates: Record<SentenceKey, string> = {
  "sentences.agent": "A {url} {code}",
  "sentences.migrate": "M {url}",
};
const translate = (key: SentenceKey, values: Record<string, string>): string =>
  templates[key].replace(/\{(\w+)\}/g, (_m, name: string) => values[name] ?? "");

describe("agentSentence", () => {
  it("填入地址与配对码", () => {
    expect(agentSentence("https://kb.example.com", "K7Q-4MZ", "<服务端地址>", translate)).toBe("A https://kb.example.com K7Q-4MZ");
  });
  it("没有地址时用占位符", () => {
    expect(agentSentence("", "K7Q-4MZ", "<服务端地址>", translate)).toBe("A <服务端地址> K7Q-4MZ");
  });
});

describe("migrateSentence", () => {
  it("填入地址；没有地址时用占位符", () => {
    expect(migrateSentence("https://kb.example.com", "<服务端地址>", translate)).toBe("M https://kb.example.com");
    expect(migrateSentence("", "<服务端地址>", translate)).toBe("M <服务端地址>");
  });
});
