import {
  BOT_SECRET_VALUE_MAX,
  BOT_SECRET_VALUE_MIN,
  type BotSecret,
  CONNECTIONS_ENDPOINTS,
  type EnvironmentId,
  type ThreadId,
  knownSiteHost,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { KeyRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { botRequest } from "../bots/http";
import { useBots } from "../bots/state";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { t } from "../i18n";
import { usePreparedConnection } from "../state/session";
import { failed } from "./rows";
import { SignInSheet } from "./SignInSheet";

export const secretUse = (secret: Pick<BotSecret, "site">) =>
  secret.site
    ? t("Typed only into {site}", { site: secret.site })
    : t("Given to one shell command at a time");

/** The card's line: who types it, on which exact host, and how long it is kept. */
const cardUse = (
  secret: Pick<BotSecret, "site" | "kind">,
  bot: string | undefined,
  login: boolean,
) => {
  if (!secret.site) return `${t("Given to one shell command at a time")}.`;
  const values = { site: secret.site, bot: bot ?? t("The bot") };
  const where =
    secret.kind === "code"
      ? t("{bot} types it once on {site}, then it is deleted.", values)
      : login
        ? `${t("{bot} types them only on {site}.", values)} ${t("Kept until you remove them in You → Secrets.")}`
        : `${t("{bot} types it only on {site}.", values)} ${t("Kept until you remove it in You → Secrets.")}`;
  return knownSiteHost(secret.site)
    ? where
    : `${t("{site} is not a site rejects knows.", values)} ${where}`;
};

/** A login's sign-in name and password, asked together, make one card; any other secret its own. */
const cardsOf = (secrets: ReadonlyArray<BotSecret>) => {
  const cards = new Map<string, Array<BotSecret>>();
  for (const secret of secrets) {
    const key = secret.request ?? secret.id;
    cards.set(key, [...(cards.get(key) ?? []), secret]);
  }
  // The name field comes first, and the password's save wakes the bot.
  return [...cards.values()].map((card) =>
    card.toSorted((a, b) => Number(a.kind === "password") - Number(b.kind === "password")),
  );
};

export function BotSecretCards({
  environmentId,
  botThreadId,
  refreshKey,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly botThreadId: ThreadId;
  readonly refreshKey: string | null;
  /** A save may have answered the bot's sign-in sheet card too. */
  readonly onSaved?: () => void;
}) {
  const [requests, setRequests] = useState<ReadonlyArray<BotSecret>>([]);
  const [handled, setHandled] = useState(0);
  const [sheet, setSheet] = useState<string | null>(null);
  const key = refreshKey === null ? null : `${refreshKey}:${handled}`;
  const connected = Option.isSome(usePreparedConnection(environmentId));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's open requests; the key marks when they may have changed
  useEffect(() => {
    if (key === null || !connected) return;
    const controller = new AbortController();
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.secrets, {}, controller.signal).then(
      (all) => setRequests(all.filter((s) => s.botThreadId === botThreadId && !s.savedAt)),
      () => undefined,
    );
    return () => controller.abort();
  }, [environmentId, botThreadId, key, connected]);
  const refresh = () => {
    setHandled((n) => n + 1);
    onSaved?.();
  };
  // The card turns into a sheet request; Done on the sheet wakes the bot.
  const choosePage = (card: ReadonlyArray<BotSecret>) =>
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.secretChoosePage, { id: card[0]!.id })
      .then(({ site, requestId }) =>
        botRequest(environmentId, CONNECTIONS_ENDPOINTS.sheetOpen, { site, requestId }).then(() =>
          setSheet(site),
        ),
      )
      .then(refresh, (error: unknown) => {
        failed(error);
        refresh();
      });
  return (
    <>
      {cardsOf(requests).map((card) => (
        <SecretCard
          key={card[0]!.id}
          environmentId={environmentId}
          card={card}
          onDone={(saved) => {
            setHandled((n) => n + 1);
            if (saved) onSaved?.();
          }}
          onChoosePage={() => choosePage(card)}
        />
      ))}
      {sheet === null
        ? null
        : createPortal(
            <SignInSheet
              environmentId={environmentId}
              site={sheet}
              onClose={() => {
                setSheet(null);
                refresh();
              }}
            />,
            document.body,
          )}
    </>
  );
}

function SecretCard({
  environmentId,
  card,
  onDone,
  onChoosePage,
}: {
  environmentId: EnvironmentId;
  card: ReadonlyArray<BotSecret>;
  onDone: (saved: boolean) => void;
  onChoosePage: () => Promise<void>;
}) {
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const size = useMediaQuery("max-md") ? "pill" : "sm";
  const first = card[0]!;
  // A login whose name saved and password did not keeps the login card's copy and page button.
  const login = card.length > 1 || first.request !== undefined;
  const bot = useBots(environmentId).find((b) => b.threadId === first.botThreadId);
  const ready = card.every((s) => (values[s.id] ?? "").length >= BOT_SECRET_VALUE_MIN);
  // One request per value, in order; a failed one leaves its field on the card.
  const each = (send: (secret: BotSecret) => Promise<unknown>, saved: boolean) => {
    setBusy(true);
    card
      .reduce<Promise<unknown>>((done, secret) => done.then(() => send(secret)), Promise.resolve())
      .then(
        () => onDone(saved),
        (error: unknown) => {
          failed(error);
          onDone(saved);
        },
      )
      .finally(() => setBusy(false));
  };
  return (
    <form
      data-secret-request
      autoComplete="off"
      className="flex w-full max-w-[88%] flex-col rounded-2xl bg-bot-bubble px-3.75 pt-3.5 pb-3.75 md:max-w-md md:rounded-lg md:border md:bg-transparent md:p-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready) return;
        each(
          (secret) =>
            botRequest(environmentId, CONNECTIONS_ENDPOINTS.secretSave, {
              id: secret.id,
              value: values[secret.id] ?? "",
            }),
          true,
        );
        setValues({});
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <KeyRoundIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <label
          htmlFor={`secret-${first.id}`}
          className="truncate text-sm font-medium max-md:text-bot-body max-md:font-semibold"
        >
          {first.label}
        </label>
      </div>
      <p className="mt-0.5 line-clamp-6 text-xs break-words text-muted-foreground max-md:text-bot-callout">
        {first.reason} · {cardUse(first, bot?.name, login)}{" "}
        {login ? t("The bot never sees them.") : t("The bot never sees it.")}
      </p>
      {card.map((secret, index) => (
        <Input
          key={secret.id}
          id={`secret-${secret.id}`}
          aria-label={
            login ? (secret.kind === "username" ? t("Sign-in name") : t("Password")) : first.label
          }
          placeholder={
            login ? (secret.kind === "username" ? t("Sign-in name") : t("Password")) : undefined
          }
          // Password fields offer to save a login; these values are the bot's, not the browser's.
          type="text"
          className={`${index === 0 ? "mt-3 md:mt-2.5" : "mt-2"} ${secret.kind === "username" ? "" : "[-webkit-text-security:disc]"}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          maxLength={BOT_SECRET_VALUE_MAX}
          value={values[secret.id] ?? ""}
          disabled={busy}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setValues((current) => ({ ...current, [secret.id]: value }));
          }}
        />
      ))}
      <div className="mt-3.5 flex gap-2 md:mt-2.5">
        <Button size={size} type="submit" className="max-md:flex-1" disabled={busy || !ready}>
          {t("Save")}
        </Button>
        <Button
          size={size}
          type="button"
          variant="secondary"
          className="max-md:flex-1"
          disabled={busy}
          onClick={() =>
            each(
              (secret) =>
                botRequest(environmentId, CONNECTIONS_ENDPOINTS.secretRemove, { id: secret.id }),
              false,
            )
          }
        >
          {t("Not now")}
        </Button>
      </div>
      {login ? (
        <Button
          size={size}
          type="button"
          variant="link"
          className="mt-1.5 self-start"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onChoosePage().finally(() => setBusy(false));
          }}
        >
          {t("Sign in on the page instead")}
        </Button>
      ) : null}
    </form>
  );
}
