"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { CJK_FONTS, MONO_FONTS, THEMES, usePreferences, type CjkFont, type MonoFont, type Theme } from "@/lib/preferences";
import { SectionRow } from "./section-card";
import "./settings.css";

/**
 * 两套主题的取色预览：颜色全部走 `tokens.css` 里定义的 `--theme-swatch-*` 变量，
 * 组件里不出现十六进制色值、不用内联 style。这组变量恒定描述“另一套主题的样子”，
 * 所以不跟着当前生效的 [data-theme] 变化。示意图里放齐页面底色、卡片、强调色、三个
 * 健康度语义色，选中的卡片额外加粗边框 + 强调色的偏移阴影（呼应按钮的“抬升”视觉）。
 */
interface ThemeSwatch {
  bg: string;
  card: string;
  border: string;
  accent: string;
  healthOnTrack: string;
  healthAtRisk: string;
  healthBlocked: string;
  activeRing: string;
  activeShadow: string;
}

const THEME_SWATCH_CLASS: Record<Theme, ThemeSwatch> = {
  print: {
    bg: "bg-[var(--theme-swatch-print-bg)]",
    border: "border-[var(--theme-swatch-print-border)]",
    card: "bg-[var(--theme-swatch-print-card)]",
    accent: "bg-[var(--theme-swatch-print-accent)]",
    healthOnTrack: "bg-[var(--theme-swatch-print-health-on-track)]",
    healthAtRisk: "bg-[var(--theme-swatch-print-health-at-risk)]",
    healthBlocked: "bg-[var(--theme-swatch-print-health-blocked)]",
    activeRing: "border-[var(--theme-swatch-print-accent)]",
    activeShadow: "shadow-[3px_3px_0_var(--theme-swatch-print-accent)]",
  },
  collage: {
    bg: "bg-[var(--theme-swatch-collage-bg)]",
    border: "border-[var(--theme-swatch-collage-border)]",
    card: "bg-[var(--theme-swatch-collage-card)]",
    accent: "bg-[var(--theme-swatch-collage-accent)]",
    healthOnTrack: "bg-[var(--theme-swatch-collage-health-on-track)]",
    healthAtRisk: "bg-[var(--theme-swatch-collage-health-at-risk)]",
    healthBlocked: "bg-[var(--theme-swatch-collage-health-blocked)]",
    activeRing: "border-[var(--theme-swatch-collage-accent)]",
    activeShadow: "shadow-[3px_3px_0_var(--theme-swatch-collage-accent)]",
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
        "flex w-40 flex-col gap-2 rounded-md border p-2.5 text-left transition-all",
        active ? cn("border-2", swatch.activeRing, swatch.activeShadow) : "border-border hover:bg-accent",
      )}
    >
      {/* 页面底色打底，内嵌一张“卡片”：顶部一条强调色标题栏，底部三个健康度语义色圆点 */}
      <span className={cn("flex h-16 flex-col justify-center overflow-hidden rounded-sm border p-2", swatch.bg, swatch.border)} aria-hidden="true">
        <span className={cn("flex h-full flex-col justify-between rounded-[2px] border p-1.5", swatch.card, swatch.border)}>
          <span className={cn("h-2 w-9 rounded-[1px]", swatch.accent)} />
          <span className="flex gap-1">
            <span className={cn("size-2 rounded-full", swatch.healthOnTrack)} />
            <span className={cn("size-2 rounded-full", swatch.healthAtRisk)} />
            <span className={cn("size-2 rounded-full", swatch.healthBlocked)} />
          </span>
        </span>
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
