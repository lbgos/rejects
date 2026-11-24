import { HTML_RENDER_DEFAULT_FONTS, htmlRenderTheme } from "@t3tools/shared/htmlRender";
import { useSyncExternalStore } from "react";

import { appearanceFontStack } from "../appearanceFonts";
import {
  getStandardThemeColors,
  getThemeColorsForMode,
  getThemeDefinition,
  resolveThemeHalf,
  subscribeToCustomThemes,
  themeColorToHex,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreference,
} from "../themePalette";
import { useClientSettings } from "./useSettings";
import { useTheme } from "./useTheme";

function resolveActiveThemeColors(
  theme: ThemePreference,
  halves: ThemeHalves | null,
  appearance: ThemeAppearance,
) {
  const definition = getThemeDefinition(resolveThemeHalf(theme, halves, appearance));
  return definition === null
    ? getStandardThemeColors(appearance)
    : (getThemeColorsForMode(definition, appearance) ?? definition.colors);
}

/**
 * The bots app's page is a step off the theme's canvas in light, and a frame in a reply sits on
 * that page: it takes the page's colour, so it has no ring of another one around it.
 */
function botsPageColor(): string | null {
  const root = document.documentElement;
  if (!root.hasAttribute("data-bots-app")) return null;
  const probe = document.createElement("i");
  probe.style.cssText = "position:absolute;visibility:hidden;background:var(--bots-page)";
  // The desktop content pane sets its own page colour, a step off the root's.
  (document.querySelector('[data-slot="sidebar-inset"]') ?? root).append(probe);
  const color = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return color === "" ? null : color;
}

export function useHtmlRenderTheme() {
  const { theme, resolvedTheme, themeHalves } = useTheme();
  const page = useSyncExternalStore(subscribeToCustomThemes, botsPageColor, () => null);
  // Custom and published palettes can be edited in place, under an unchanged preference.
  const colors = useSyncExternalStore(
    subscribeToCustomThemes,
    () => resolveActiveThemeColors(theme, themeHalves, resolvedTheme),
    () => getStandardThemeColors(resolvedTheme),
  );
  const sans = useClientSettings((settings) => settings.fontFamilySans);
  const mono = useClientSettings((settings) => settings.fontFamilyCode);
  return htmlRenderTheme(
    {
      ...(Object.fromEntries(
        Object.entries(colors).map(([role, color]) => [role, themeColorToHex(color) ?? color]),
      ) as typeof colors),
      ...(page === null ? {} : { canvas: page }),
    },
    resolvedTheme,
    {
      sans: appearanceFontStack(sans, HTML_RENDER_DEFAULT_FONTS.sans),
      mono: appearanceFontStack(mono, HTML_RENDER_DEFAULT_FONTS.mono),
    },
  );
}
