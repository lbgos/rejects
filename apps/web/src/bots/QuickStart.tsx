import type { EnvironmentId } from "@t3tools/contracts";
import { ChevronRightIcon, PlusIcon } from "lucide-react";
import { t } from "../i18n";
import { BOT_TEMPLATES } from "./templates";
import { openBotDialog } from "./ui";

const ROW =
  "flex min-h-11 w-full items-center gap-3 py-2 text-left text-sm max-md:text-bot-body hover:bg-accent max-md:hover:bg-transparent";

export function QuickStart({ environmentId }: { environmentId: EnvironmentId }) {
  return (
    <div data-quick-start className="mt-5 flex w-full flex-col text-left">
      <h3 className="pb-1 text-bot-footnote text-muted-foreground">{t("Start from a template")}</h3>
      <ul className="divide-y divide-border/60">
        {BOT_TEMPLATES.map((template) => (
          <li key={template.id}>
            <button
              type="button"
              className={ROW}
              onClick={() =>
                openBotDialog({ environmentId, threadId: null, focus: null, template: template.id })
              }
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{template.name}</span>
                <span className="text-bot-footnote text-muted-foreground">
                  {template.description}
                </span>
              </span>
              <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </li>
        ))}
        <li>
          <button
            type="button"
            className={ROW}
            onClick={() => openBotDialog({ environmentId, threadId: null, focus: null })}
          >
            <PlusIcon aria-hidden className="size-4 shrink-0" />
            <span className="flex-1 truncate">{t("Create your own bot")}</span>
          </button>
        </li>
      </ul>
      <ul className="mt-3 flex list-disc flex-col gap-1 ps-4 text-bot-footnote text-muted-foreground">
        <li>
          {t("Each bot has one job, its own chat and memory, and only the tools you give it.")}
        </li>
        <li>
          {t("A schedule wakes a bot on its own: ask in its chat, such as “every morning at 8”.")}
        </li>
        <li>
          {t("Sites sign in on your phone: a bot asks with a card, or connect them under You.")}
        </li>
      </ul>
    </div>
  );
}
