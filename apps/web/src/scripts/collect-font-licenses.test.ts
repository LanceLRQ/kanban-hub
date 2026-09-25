import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FONT_PACKAGES, collectFontLicenses } from "../../scripts/collect-font-licenses.mjs";

const CHECKED_IN_LICENSES_DIR = path.join(__dirname, "../../public/licenses");

describe("collectFontLicenses", () => {
  it.each(FONT_PACKAGES.map((p) => p.id))(
    "%s 的许可证文件存在，且内容含 SIL Open Font License",
    (id) => {
      const filePath = path.join(CHECKED_IN_LICENSES_DIR, "fonts", `${id}.txt`);
      expect(fs.existsSync(filePath)).toBe(true);
      const text = fs.readFileSync(filePath, "utf8");
      expect(text).toContain("SIL Open Font License");
    },
  );

  it("入库的许可证文件与脚本当前的输出一致（升级字体包后要重新生成）", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-font-licenses-"));
    try {
      collectFontLicenses(tmpDir);

      const checkedInFiles = fs.readdirSync(path.join(CHECKED_IN_LICENSES_DIR, "fonts")).sort();
      const freshFiles = fs.readdirSync(path.join(tmpDir, "fonts")).sort();
      expect(checkedInFiles).toEqual(freshFiles);

      for (const file of freshFiles) {
        const checkedIn = fs.readFileSync(path.join(CHECKED_IN_LICENSES_DIR, "fonts", file), "utf8");
        const fresh = fs.readFileSync(path.join(tmpDir, "fonts", file), "utf8");
        expect(checkedIn).toBe(fresh);
      }

      const checkedInReadme = fs.readFileSync(path.join(CHECKED_IN_LICENSES_DIR, "README.txt"), "utf8");
      const freshReadme = fs.readFileSync(path.join(tmpDir, "README.txt"), "utf8");
      expect(checkedInReadme).toBe(freshReadme);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("缺少许可证文件的包会抛异常，不会静默跳过", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kh-font-licenses-missing-"));
    try {
      const brokenPackages = FONT_PACKAGES.map((p) =>
        p.id === "fira-code" ? { ...p, resolve: () => path.join(tmpDir, "does-not-exist.txt") } : p,
      );
      expect(() => collectFontLicenses(tmpDir, brokenPackages)).toThrow(/fira-code/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
