import type { BotBridgeRequest } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { t } from "../i18n";
import { runModel } from "./BotBridgePanel";

export function BotProposalCard({
  request,
  environmentLabel,
  deciding,
  onDecide,
  onReview,
}: {
  readonly request: BotBridgeRequest;
  readonly environmentLabel: string;
  readonly deciding: "approve" | "deny" | null;
  readonly onDecide: (approve: boolean) => void;
  readonly onReview: () => void;
}) {
  const phone = useMediaQuery("max-md");
  const { proposal } = request;
  const title = proposal.kind === "start" ? proposal.title : t("Message to an approved run");
  const facts = [
    environmentLabel,
    proposal.kind === "start" ? runModel(proposal.modelSelection) : request.targetTitle,
  ].filter((fact) => fact !== undefined);
  return (
    <div
      data-bot-proposal
      className="flex w-full max-w-[88%] flex-col rounded-2xl bg-bot-bubble px-3.75 pt-3.5 pb-3.75 md:max-w-md md:rounded-lg md:border md:bg-transparent md:p-3"
    >
      <button
        type="button"
        aria-label={t("Review {title}", { title })}
        className="flex min-w-0 cursor-pointer items-center gap-2 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        onClick={onReview}
      >
        <span className="min-w-0 flex-1 line-clamp-2 text-sm font-medium max-md:text-bot-body max-md:font-semibold">
          {title}
        </span>
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/70" />
      </button>
      <p className="mt-0.5 truncate text-xs text-muted-foreground max-md:text-bot-footnote">
        {facts.join(" · ")}
      </p>
      <div className="mt-3.5 flex gap-2 md:mt-2.5">
        <Button
          size={phone ? "pill" : "sm"}
          className="max-md:flex-1"
          disabled={deciding !== null}
          onClick={() => onDecide(true)}
        >
          {deciding === "approve" ? t("Approving…") : t("Approve")}
        </Button>
        <Button
          size={phone ? "pill" : "sm"}
          variant="secondary"
          className="max-md:flex-1"
          disabled={deciding !== null}
          onClick={() => onDecide(false)}
        >
          {deciding === "deny" ? t("Denying…") : t("Deny")}
        </Button>
      </div>
    </div>
  );
}
