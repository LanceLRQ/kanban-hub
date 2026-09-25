"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { CJK_FONTS, MONO_FONTS, THEMES, usePreferences, type CjkFont, type MonoFont, type Theme } from "@/lib/preferences";
import { SectionRow } from "./section-card";
import "./settings.css";

/**
 * 两套主题的取色预览：颜色全部走 `settings.css` 里定义的 `--theme-swatch-*` 变量，
 * 组件里不出现十六进制色值、不用内联 style。这组变量恒定描述“另一套主题的样子”，
 * 所以不跟着当前生效的 [data-theme] 变化。
 */
const THEME_SWATCH_CLASS: Record<Theme, { bg: string; card: string; border: string; accent: string }> = {
  print: {
    bg: "bg-[var(--theme-swatch-print-bg)]",
    border: "border-[var(--theme-swatch-print-border)]",
    card: "bg-[var(--theme-swatch-print-card)]",
    accent: "bg-[var(--theme-swatch-print-accent)]",
  },
  collage: {
    bg: "bg-[var(--theme-swatch-collage-bg)]",
    border: "border-[var(--theme-swatch-collage-border)]",
    card: "bg-[var(--theme-swatch-collage-card)]",
    accent: "bg-[var(--theme-swatch-collage-accent)]",
  },
};

/** 外观：主题二选一（两张卡片）+ 等宽字体、中文字体单选。选中立即生效，刷新后保持（localStorage） */
export function AppearanceSection() {
  const t = useTranslations("settings");
  const { preferences, setTheme, setMonoFont, setCjkFont } = usePreferences();

  return (
    <>
      <SectionRow label={t("appearance.theme")}>
        <div className="flex flex-wrap gap-3">
          {THEMES.map((theme) => (
            <ThemeCard key={theme} theme={theme} active={preferences.theme === theme} onSelect={() => setTheme(theme)} label={t(`appearance.themes.${theme}`)} />
          ))}
        </div>
      </SectionRow>
      <SectionRow label={t("appearance.monoFont")}>
        <RadioGroup value={preferences.mono} onValueChange={(v) => setMonoFont(v as MonoFont)} className="flex flex-wrap gap-x-5 gap-y-2">
          {MONO_FONTS.map((font) => (
            <FontOption key={font} id={`mono-${font}`} value={font} label={t(`appearance.monoFonts.${font}`)} />
          ))}
        </RadioGroup>
      </SectionRow>
      <SectionRow label={t("appearance.cjkFont")}>
        <RadioGroup value={preferences.cjk} onValueChange={(v) => setCjkFont(v as CjkFont)} className="flex flex-wrap gap-x-5 gap-y-2">
          {CJK_FONTS.map((font) => (
            <FontOption key={font} id={`cjk-${font}`} value={font} label={t(`appearance.cjkFonts.${font}`)} />
          ))}
        </RadioGroup>
      </SectionRow>
    </>
  );
}

function ThemeCard({ theme, active, onSelect, label }: { theme: Theme; active: boolean; onSelect: () => void; label: string }) {
  const swatch = THEME_SWATCH_CLASS[theme];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      className={cn(
        "flex w-36 flex-col gap-2 rounded-md border p-2.5 text-left transition-colors",
        active ? "border-ring bg-secondary/40" : "border-border hover:bg-accent",
      )}
    >
      <span className={cn("flex h-10 overflow-hidden rounded-sm border", swatch.bg, swatch.border)} aria-hidden="true">
        <span className={cn("m-1 flex-1 rounded-[2px] border", swatch.card, swatch.border)} />
        <span className={cn("m-1 w-3 rounded-[2px]", swatch.accent)} />
      </span>
      <span className="text-xs font-bold">{label}</span>
    </button>
  );
}

function FontOption({ id, value, label }: { id: string; value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <RadioGroupItem value={value} id={id} />
      <Label htmlFor={id} className="text-sm font-normal">
        {label}
      </Label>
    </div>
  );
}
