import type { AnyRouter } from "@tanstack/react-router";

import { dispatchCommandPalette, isCommandPaletteMounted } from "../commandPaletteStore";
import { APPEARANCE_OPTIONS, notifyThemeSaveFailure } from "../components/CommandPaletteThemeItems";
import { toggleThemeEditorForTheme } from "../components/settings/themeEditorStore";
import { toastManager } from "../components/ui/toast";
import { getThemeSnapshot, setAppearanceMode } from "../hooks/useTheme";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { type CommandScopeOptions, registerCommands } from "./dispatcher";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

/**
 * Palette and theme shortcuts. They read the route, panels and theme
 * when the key is pressed, and are live only while the palette is mounted.
 */
export function installCommandPaletteCommands(
  router: AnyRouter,
  options: Pick<CommandScopeOptions, "keybindings"> = {},
): () => void {
  const readRouteThreadRef = () => {
    const target = resolveThreadRouteTarget(router.state.matches.at(-1)?.params ?? {});
    return target?.kind === "server" ? target.threadRef : null;
  };

  const disposeCommands = registerCommands(
    {
      "appearance.cycle": (event) => {
        consume(event);
        if (event.repeat) return;
        const { appearanceMode } = getThemeSnapshot();
        const nextMode =
          appearanceMode === "system" ? "light" : appearanceMode === "light" ? "dark" : "system";
        if (!setAppearanceMode(nextMode)) {
          notifyThemeSaveFailure();
          return;
        }
        toastManager.add({
          id: "appearance-cycle",
          title: `Appearance: ${APPEARANCE_OPTIONS.find((option) => option.mode === nextMode)?.label}`,
          timeout: 1500,
        });
      },
      "theme.select": (event) => {
        consume(event);
        if (event.repeat) return;
        dispatchCommandPalette({ _tag: "OpenChangeTheme" });
      },
      "themeEditor.toggle": (event) => {
        consume(event);
        const { theme, themeHalves, resolvedTheme } = getThemeSnapshot();
        toggleThemeEditorForTheme({ theme, themeHalves, initialAppearance: resolvedTheme });
      },
      "commandPalette.toggle": (event) => {
        consume(event);
        dispatchCommandPalette({ _tag: "Toggle" });
      },
    },
    {
      ...options,
      when: isCommandPaletteMounted,
      context: () => {
        const threadRef = readRouteThreadRef();
        return {
          terminalOpen: threadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                threadRef,
              ).terminalOpen
            : false,
          previewOpen: threadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, threadRef) ===
              "preview"
            : false,
        };
      },
    },
  );

  return disposeCommands;
}
