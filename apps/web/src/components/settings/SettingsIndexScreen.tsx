import { useState, type ReactNode } from "react";
import { SettingsSidebarNav } from "./SettingsSidebarNav";

/**
 * The phone's Settings index: a large title over the section list, with a compact title in the
 * top bar once the list scrolls under it. In the bots app it is the Settings tab (BotTabHost).
 */
export function SettingsIndexScreen({ close }: { close?: ReactNode }) {
  const [titleScrolled, setTitleScrolled] = useState(false);
  return (
    <>
      <header
        data-settings-index-bar
        data-bots-top-bar
        data-scrolled={titleScrolled}
        className="relative mt-1 flex h-11 shrink-0 items-center justify-end px-4"
      >
        <span
          aria-hidden
          data-bots-bar-title
          className="pointer-events-none absolute inset-x-24 text-center text-bot-body font-semibold opacity-0 in-data-[scrolled=true]:opacity-100"
        >
          Settings
        </span>
        {close}
      </header>
      <div
        data-settings-index-list
        className="flex min-h-0 flex-1"
        onScrollCapture={(event) =>
          setTitleScrolled(event.target instanceof Element && event.target.scrollTop > 40)
        }
      >
        <SettingsSidebarNav
          pathname="/settings"
          header={<h1 className="shrink-0 px-5 pt-1 pb-2 text-bot-title font-bold">Settings</h1>}
        />
      </div>
    </>
  );
}
