import { useAtomValue } from "@effect/atom-react";
import {
  type AccountView,
  type BotSecret,
  CONNECTION_LABEL,
  CONNECTIONS_ENDPOINTS,
  type ConnectionAuditEntry,
  type ConnectionsState,
  type ConnectionView,
  type EnvironmentId,
  BOT_SECRET_VALUE_MAX,
  BOT_SECRET_VALUE_MIN,
  cheapestModel,
  isProviderAvailable,
  isProviderTextGenerationCapable,
  siteName,
  siteOf,
  slackManifest,
  TELEGRAM_ENDPOINTS,
  type TelegramState,
} from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import * as Option from "effect/Option";
import { useEffect, useState } from "react";
import { botRequest } from "../bots/http";
import { useBots } from "../bots/state";
import {
  ProviderModelPicker,
  RESTING_PROVIDER_ICON_CLASSNAME,
} from "../components/chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { useSidebar } from "../components/ui/sidebar";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { toastManager } from "../components/ui/toast";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { t, uiLanguage, type UiText } from "../i18n";
import { cn } from "../lib/utils";
import { readLocalApi } from "../localApi";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../providerInstances";
import { usePreparedConnection } from "../state/session";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { secretUse } from "./BotSecretCards";
import { clock, FIELD_ROW, failed, Row, Section, VaultDownNotice } from "./rows";
import { SignInSheet } from "./SignInSheet";
import {
  accountStatus,
  ConnectSection,
  connectorStatus,
  gmailBrowserAccount,
} from "./AccountsSection";
import { SiteIcon } from "./SiteIcon";
import { TelegramDetail, telegramStatus } from "./TelegramDetail";
import { rememberBackPage } from "../bots/backPage";
import { EdgeSwipeBack } from "../bots/EdgeSwipeBack";
import { YouNotes } from "../bots/BotOverlays";

const FIELD_LABEL: Record<string, UiText> = {
  clientId: "Client ID",
  clientSecret: "Client secret",
  token: "User token (xoxp-)",
};

function fieldLabel(name: string) {
  const label = FIELD_LABEL[name];
  return label === undefined ? name : t(label);
}

/** Last loaded state per environment, so a remount (each desktop visit to You) draws it at once. */
const lastStates = new Map<EnvironmentId, ConnectionsState>();
const lastTelegrams = new Map<EnvironmentId, TelegramState>();

const readState = (environmentId: EnvironmentId) =>
  botRequest(environmentId, CONNECTIONS_ENDPOINTS.state, {}).then((next) => {
    lastStates.set(environmentId, next);
    return next;
  });

const readTelegram = (environmentId: EnvironmentId) =>
  botRequest(environmentId, TELEGRAM_ENDPOINTS.state, {}).then((next) => {
    lastTelegrams.set(environmentId, next);
    return next;
  });

const STATUS_ROW = "px-4 py-2.5 text-muted-foreground max-md:px-5 max-md:text-bot-body";
const ACTION_ROW = "flex flex-wrap gap-2 px-4 py-2.5 max-md:px-5";

type Page =
  | { readonly type: "account"; readonly site: string }
  | { readonly type: "connector"; readonly kind: ConnectionView["kind"] }
  | { readonly type: "telegram" };

/** `visible` false keeps it mounted but stops its polling (a hidden tab in BotTabHost). */
export function ConnectionsScreen({
  environmentId,
  visible = true,
}: {
  environmentId: EnvironmentId;
  visible?: boolean;
}) {
  const [state, setState] = useState<ConnectionsState | null>(
    () => lastStates.get(environmentId) ?? null,
  );
  // Any route: BotTabHost keeps this screen mounted on the other tabs, where these keys are absent.
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const { isMobile } = useSidebar();
  const page: Page | null = search.site
    ? { type: "account", site: search.site }
    : search.connector
      ? { type: "connector", kind: search.connector }
      : search.telegram
        ? { type: "telegram" }
        : null;
  // A detail page pushes in and back pops it, except after an edge swipe, which already moved it.
  const setPage = (next: Page | null, animate = true) => {
    if (next !== null) rememberBackPage();
    void navigate({
      to: "/connections",
      viewTransition:
        animate && isMobile ? { types: [next === null ? "bots-pop" : "bots-push"] } : false,
      search:
        next === null
          ? {}
          : next.type === "account"
            ? { site: next.site }
            : next.type === "connector"
              ? { connector: next.kind }
              : { telegram: true },
    });
  };
  const [sheet, setSheet] = useState<string | null>(null);
  const connected = Option.isSome(usePreparedConnection(environmentId));
  const [telegram, setTelegram] = useState<TelegramState | null>(
    () => lastTelegrams.get(environmentId) ?? null,
  );
  const [titleScrolled, setTitleScrolled] = useState(false);
  const refresh = () => void readState(environmentId).then(setState, () => undefined);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the vault's state on mount and polls it while visible; focus catches the return from Google in Safari
  useEffect(() => {
    if (!connected) return;
    const load = () => {
      void readState(environmentId).then(setState, () => undefined);
      void readTelegram(environmentId).then(setTelegram, () => undefined);
    };
    load();
    if (!visible) return;
    const timer = window.setInterval(load, 10_000);
    window.addEventListener("focus", load);
    document.addEventListener("visibilitychange", load);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", load);
      document.removeEventListener("visibilitychange", load);
    };
  }, [environmentId, connected, visible]);

  const openSheet = (site: string) =>
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.sheetOpen, { site }).then(
      () => setSheet(site),
      failed,
    );

  const account =
    page?.type === "account" ? state?.accounts.find((a) => a.site === page.site) : undefined;
  const connector =
    page?.type === "connector" ? state?.connections.find((c) => c.kind === page.kind) : undefined;
  // The home list: You itself, and any detail page whose subject is not there to show.
  const home =
    !account && !connector && !(page?.type === "telegram" && telegram) && page?.type !== "account";
  // A detail page is named after what it is about, whether or not it is connected yet.
  const title =
    page?.type === "account"
      ? siteName(page.site, uiLanguage)
      : page?.type === "connector"
        ? CONNECTION_LABEL[page.kind]
        : page?.type === "telegram"
          ? "Telegram"
          : t("You");

  return (
    <div
      data-connections
      data-back-page={page === null || undefined}
      className={cn(
        "relative flex h-full min-h-0 flex-col bg-background text-foreground",
        !isMobile && "pt-safe",
      )}
    >
      {/* You is a tab on a phone: only its detail pages swipe back. */}
      {page === null ? null : <EdgeSwipeBack onBack={() => setPage(null, false)} />}
      {/* On a phone the shell's floating arrow is a detail page's back button; the header leaves
          room for it. The bar floats over the page from the top edge (bots.css). */}
      <div
        data-bots-top-bar={isMobile || undefined}
        // A pushed page keeps its title in the bar; the tab root shows it there once scrolled.
        data-scrolled={isMobile ? titleScrolled || page !== null : undefined}
      >
        {isMobile ? (
          <span
            aria-hidden
            data-bots-bar-title
            data-pinned={page !== null || undefined}
            className="pointer-events-none absolute inset-x-24 bottom-0 flex h-(--workspace-topbar-height) items-center justify-center truncate text-bot-body font-semibold opacity-0 in-data-[scrolled=true]:opacity-100"
          >
            {title}
          </span>
        ) : null}
        <WorkspacePageHeader>
          {(account || connector || page?.type === "telegram") && !isMobile ? (
            <button
              type="button"
              className="-ms-1 flex min-w-0 items-center gap-0.5 text-sm font-medium"
              onClick={() => setPage(null)}
            >
              <ChevronLeftIcon className="size-4 shrink-0" />
              <span className="truncate">{title}</span>
            </button>
          ) : isMobile ? null : (
            <h1 className="truncate text-sm font-medium">{title}</h1>
          )}
        </WorkspacePageHeader>
      </div>
      <div
        data-bots-scroller={isMobile || undefined}
        className={cn(
          "min-h-0 flex-1 overflow-y-auto",
          isMobile && "pt-(--bot-chat-header-height)",
          isMobile && page === null ? "pb-(--bots-tab-bar-space)" : "pb-safe",
        )}
        onScroll={
          isMobile ? (event) => setTitleScrolled(event.currentTarget.scrollTop > 40) : undefined
        }
      >
        <div data-you-column>
          {isMobile && page === null ? (
            <h1 className="truncate px-5 pt-1 pb-2 text-bot-title font-bold">{title}</h1>
          ) : null}
          {/* Connect leads the page. Notes need no vault, so they are there while it loads. */}
          {home && state ? (
            <ConnectSection
              state={state}
              onOpenAccount={(site) => setPage({ type: "account", site })}
              onOpenConnector={(kind) => setPage({ type: "connector", kind })}
              onSignIn={(site) => void openSheet(site)}
              onRetry={refresh}
            />
          ) : null}
          {page === null ? <YouNotes environmentId={environmentId} /> : null}
          {state === null ? (
            page === null ? null : (
              <p className="px-4 py-3 text-sm text-muted-foreground max-md:px-5">{t("Loading…")}</p>
            )
          ) : account ? (
            <AccountDetail
              environmentId={environmentId}
              account={account}
              audit={state.audit}
              onChanged={refresh}
              onSignIn={() => void openSheet(account.site)}
              onGone={() => {
                setPage(null);
                refresh();
              }}
            />
          ) : page?.type === "telegram" && telegram ? (
            <TelegramDetail environmentId={environmentId} state={telegram} onState={setTelegram} />
          ) : connector ? (
            <ConnectorDetail
              environmentId={environmentId}
              state={state}
              view={connector}
              onChanged={refresh}
              onOpenAccount={(site) => setPage({ type: "account", site })}
            />
          ) : page?.type === "account" ? (
            // A site nobody signed in to yet: its page offers the sign-in. While the vault is down
            // the notice says so above it, and the sign-in waits.
            <>
              {state.available ? null : (
                <Section>
                  <VaultDownNotice onRetry={refresh} />
                </Section>
              )}
              <Section footer={t("A bot uses this sign-in only after you allow it here.")}>
                <li>
                  <Row
                    title={t("Sign in")}
                    value={t("Not connected")}
                    disabled={!state.available}
                    onClick={() => void openSheet(page.site)}
                  />
                </li>
              </Section>
            </>
          ) : (
            <>
              <Section title={t("Secrets")}>
                {state.secrets.length === 0 ? (
                  <li className="px-4 py-2 text-sm text-muted-foreground max-md:px-5 max-md:text-bot-body">
                    {t("None")}
                  </li>
                ) : (
                  state.secrets.map((secret) => (
                    <li key={secret.id}>
                      <BotSecretRow
                        environmentId={environmentId}
                        secret={secret}
                        onChanged={refresh}
                      />
                    </li>
                  ))
                )}
              </Section>
              {telegram ? (
                <Section title="Telegram">
                  <li>
                    <Row
                      title={t("Main bot chat")}
                      value={telegramStatus(telegram)}
                      tone={telegram.error ? "error" : "muted"}
                      onClick={() => setPage({ type: "telegram" })}
                    />
                  </li>
                </Section>
              ) : null}
            </>
          )}
        </div>
      </div>
      {sheet ? (
        <SignInSheet
          environmentId={environmentId}
          site={sheet}
          onClose={() => {
            setSheet(null);
            refresh();
          }}
        />
      ) : null}
    </div>
  );
}

function BotSecretRow({
  environmentId,
  secret,
  onChanged,
}: {
  environmentId: EnvironmentId;
  secret: BotSecret;
  onChanged: () => void;
}) {
  const bot = useBots(environmentId).find((b) => b.threadId === secret.botThreadId);
  const [value, setValue] = useState("");
  const remove = async () => {
    const confirmed = await (readLocalApi()?.dialogs.confirm(
      bot
        ? t(
            "Remove {secret}?\nThe value and the recordings of runs that used it are deleted. {bot} has to ask again.",
            { secret: secret.label, bot: bot.name },
          )
        : t(
            "Remove {secret}?\nThe value and the recordings of runs that used it are deleted. The bot has to ask again.",
            { secret: secret.label },
          ),
      { variant: "destructive", confirmLabel: t("Remove") },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.secretRemove, { id: secret.id }).then(
      onChanged,
      failed,
    );
  };
  return (
    <form
      data-bot-secret
      autoComplete="off"
      className="flex flex-col gap-1.5 px-4 py-2 text-sm max-md:px-5 max-md:text-bot-body"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.length < BOT_SECRET_VALUE_MIN) return;
        botRequest(environmentId, CONNECTIONS_ENDPOINTS.secretSave, { id: secret.id, value }).then(
          onChanged,
          failed,
        );
        setValue("");
      }}
    >
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="truncate">{secret.label}</span>
        <span className="shrink-0 text-muted-foreground">{bot?.name ?? t("Deleted bot")}</span>
      </div>
      <span className="text-xs break-words text-muted-foreground max-md:text-bot-footnote">
        {secret.name} · {secretUse(secret)} ·{" "}
        {secret.savedAt
          ? t("saved {time}", { time: clock(secret.savedAt) })
          : t("asked {time}", { time: clock(secret.requestedAt) })}
        {secret.lastUsedAt ? ` · ${t("used {time}", { time: clock(secret.lastUsedAt) })}` : ""}
      </span>
      <div className="flex items-center gap-2">
        <Input
          type="text"
          className="min-w-0 flex-1 [-webkit-text-security:disc]"
          aria-label={secret.label}
          placeholder={secret.savedAt ? t("Replace") : t("Enter value")}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          maxLength={BOT_SECRET_VALUE_MAX}
          value={value}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        {value.length >= BOT_SECRET_VALUE_MIN ? (
          <Button size="sm" variant="outline" type="submit">
            {t("Save")}
          </Button>
        ) : null}
        <Button size="sm" variant="destructive-outline" type="button" onClick={() => void remove()}>
          {t("Remove")}
        </Button>
      </div>
    </form>
  );
}

function AccountDetail({
  environmentId,
  account,
  audit,
  onChanged,
  onSignIn,
  onGone,
}: {
  environmentId: EnvironmentId;
  account: AccountView;
  audit: ReadonlyArray<ConnectionAuditEntry>;
  onChanged: () => void;
  onSignIn: () => void;
  onGone: () => void;
}) {
  const bots = useBots(environmentId);
  const call = <A,>(promise: Promise<A>) => promise.then(onChanged, failed);
  const grant = (
    botThreadId: AccountView["bots"][number]["botThreadId"],
    granted: boolean,
    scheduledWrites?: boolean,
  ) =>
    call(
      botRequest(environmentId, CONNECTIONS_ENDPOINTS.accountGrant, {
        site: account.site,
        botThreadId,
        granted,
        ...(scheduledWrites === undefined ? {} : { scheduledWrites }),
      }),
    );
  const revoke = async () => {
    const confirmed = await (readLocalApi()?.dialogs.confirm(
      t(
        "Disconnect {site}?\nIts sign-in is deleted here and no bot can use it any more. The activity log stays.",
        { site: siteName(account.site, uiLanguage) },
      ),
      { variant: "destructive", confirmLabel: t("Disconnect") },
    ) ?? Promise.resolve(false));
    if (!confirmed) return;
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.accountRevoke, { site: account.site }).then(
      onGone,
      (error: unknown) => {
        failed(error);
        // A Disconnect the vault did not carry out leaves the account as it was; show that.
        onChanged();
      },
    );
  };
  const activity = audit
    .filter((entry) => entry.connection === account.site)
    .toReversed()
    .slice(0, 50);
  return (
    <div className="flex flex-col pb-6 text-base">
      <Section>
        <li className={STATUS_ROW}>
          {account.signedInAt === null
            ? t("Signed out")
            : t("Signed in {time}", { time: clock(account.signedInAt) })}
          {account.lastUsedAt ? ` · ${t("used {time}", { time: clock(account.lastUsedAt) })}` : ""}
        </li>
        <li className={ACTION_ROW}>
          <Button size="sm" variant="outline" onClick={onSignIn}>
            {account.signedInAt === null ? t("Sign in") : t("Sign in again")}
          </Button>
          {account.signedInAt === null ? null : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                void call(
                  botRequest(environmentId, CONNECTIONS_ENDPOINTS.accountSignOut, {
                    site: account.site,
                  }),
                )
              }
            >
              {t("Sign out")}
            </Button>
          )}
          <Button size="sm" variant="destructive-outline" onClick={() => void revoke()}>
            {t("Disconnect")}
          </Button>
        </li>
      </Section>
      <Section title={t("Bots")}>
        {bots.map((bot) => {
          const current = account.bots.find((g) => g.botThreadId === bot.threadId);
          return (
            <li key={bot.threadId} className="px-4 py-2 max-md:py-0">
              <label className="flex min-h-7 items-center justify-between gap-3 max-md:text-bot-body">
                <span className="truncate">{bot.name}</span>
                <Switch
                  checked={current !== undefined}
                  onCheckedChange={(granted) => void grant(bot.threadId, granted)}
                />
              </label>
              {current ? (
                <label className="flex min-h-7 items-center justify-between gap-3 text-sm text-muted-foreground">
                  <span>{t("Act on schedules too")}</span>
                  <Switch
                    checked={current.scheduledWrites}
                    onCheckedChange={(scheduledWrites) =>
                      void grant(bot.threadId, true, scheduledWrites)
                    }
                  />
                </label>
              ) : null}
            </li>
          );
        })}
      </Section>
      <Section title={t("Also allowed")}>
        <li>
          <LinesEditor
            key={account.origins.join("\n")}
            label={t("Allowed sites")}
            placeholder={t(
              "Sites the bots may load with this account, such as its sign-in domain. One per line.",
            )}
            saveLabel={t("Save sites")}
            values={account.origins}
            onSave={(lines) => {
              const origins = lines.map((line) => siteOf(line));
              if (origins.some((origin) => origin === undefined))
                return Promise.resolve(
                  failed(new Error(t("One site per line, such as accounts.google.com."))),
                );
              return call(
                botRequest(environmentId, CONNECTIONS_ENDPOINTS.accountOrigins, {
                  site: account.site,
                  origins: origins.filter((origin) => origin !== undefined),
                }),
              );
            }}
          />
        </li>
      </Section>
      <Section title={t("Activity")}>
        {activity.length === 0 ? (
          <li className="px-4 py-2 text-muted-foreground max-md:px-5">{t("Nothing yet.")}</li>
        ) : (
          activity.map((entry) => (
            <li
              key={`${entry.at}:${entry.op}:${entry.actor}:${entry.detail ?? ""}`}
              className="flex flex-col px-4 py-2 text-sm max-md:px-5 max-md:text-bot-callout"
            >
              <span className="truncate">
                {entry.actor} · {entry.op}
                {entry.status === "ok" ? "" : ` · ${entry.status}`}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums max-md:text-bot-footnote">
                {clock(entry.at)}
              </span>
              {entry.detail ? (
                <span className="text-xs break-words whitespace-pre-wrap text-muted-foreground max-md:text-bot-footnote">
                  {entry.detail}
                </span>
              ) : null}
            </li>
          ))
        )}
      </Section>
    </div>
  );
}

function ConnectorDetail({
  environmentId,
  state,
  view,
  onChanged,
  onOpenAccount,
}: {
  environmentId: EnvironmentId;
  state: ConnectionsState;
  view: ConnectionView;
  onChanged: () => void;
  onOpenAccount: (site: string) => void;
}) {
  const call = <A,>(promise: Promise<A>) => promise.then(onChanged, failed);
  const browser = view.kind === "gmail" ? gmailBrowserAccount(state) : undefined;
  const audit = state.audit
    .filter((entry) => entry.connection === view.kind)
    .toReversed()
    .slice(0, 20);

  const connectGmail = () => {
    // Opened in the tap so iOS treats it as user-initiated; Google answers in that tab.
    const tab = window.open("about:blank", "_blank");
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.start, { kind: "gmail" }).then(
      ({ authUrl }) => {
        if (tab) tab.location.href = authUrl;
        else window.location.assign(authUrl);
      },
      (error: unknown) => {
        tab?.close();
        failed(error);
      },
    );
  };

  // Nothing on this page works without the vault: the notice says so once, over the connector's
  // way in, which waits until the vault answers.
  if (!state.available)
    return (
      <div data-connector-page className="flex flex-col pb-6 text-sm">
        <Section>
          <VaultDownNotice onRetry={onChanged} />
        </Section>
        {view.kind === "gmail" ? (
          <Section>
            <li className={ACTION_ROW}>
              <Button size="sm" variant="outline" disabled>
                {view.account ? t("Reconnect") : t("Connect")}
              </Button>
            </li>
          </Section>
        ) : null}
      </div>
    );
  return (
    <div data-connector-page className="flex flex-col pb-6 text-sm">
      <Section>
        <li className={STATUS_ROW}>{connectorStatus(view)}</li>
        {view.kind === "gmail" || view.account ? (
          <li className={ACTION_ROW}>
            {view.kind === "gmail" ? (
              <Button size="sm" variant="outline" onClick={connectGmail}>
                {view.account ? t("Reconnect") : t("Connect")}
              </Button>
            ) : null}
            {view.account ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void call(
                      botRequest(environmentId, CONNECTIONS_ENDPOINTS.pause, {
                        kind: view.kind,
                        paused: view.status !== "paused",
                      }),
                    )
                  }
                >
                  {view.status === "paused" ? t("Resume") : t("Pause")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive-outline"
                  onClick={() =>
                    void call(
                      botRequest(environmentId, CONNECTIONS_ENDPOINTS.disconnect, {
                        kind: view.kind,
                      }),
                    )
                  }
                >
                  {t("Disconnect")}
                </Button>
              </>
            ) : null}
          </li>
        ) : null}
        {browser ? (
          <li>
            <Row
              icon={<SiteIcon site={browser.site} />}
              title={t("Browser sign-in")}
              value={accountStatus(browser)}
              onClick={() => onOpenAccount(browser.site)}
            />
          </li>
        ) : null}
      </Section>
      {view.fields.length > 0 || state.redirectUri || view.kind === "slack" ? (
        <Section
          title={t("Credentials")}
          footer={
            view.kind === "gmail" && state.redirectUri
              ? t("Add the redirect URI to the Google OAuth client: {uri}", {
                  uri: state.redirectUri,
                })
              : undefined
          }
        >
          {view.fields.map((field) => (
            <li key={field.name}>
              <SecretField
                label={fieldLabel(field.name)}
                setAt={field.setAt}
                onSave={(value) =>
                  call(
                    botRequest(environmentId, CONNECTIONS_ENDPOINTS.setField, {
                      kind: view.kind,
                      field: field.name,
                      value,
                    }),
                  )
                }
              />
            </li>
          ))}
          {view.kind === "gmail" && state.redirectUri ? (
            <li>
              <CopyLine label={t("Redirect URI")} value={state.redirectUri} />
            </li>
          ) : null}
          {view.kind === "slack" ? (
            <li>
              <CopyLine
                label={t("App manifest")}
                value={slackManifest()}
                button={t("Copy manifest")}
              />
            </li>
          ) : null}
        </Section>
      ) : null}
      <Section title={t("Watching")}>
        <li>
          <label className={FIELD_ROW}>
            <span>{t("Watch for important messages")}</span>
            <Switch
              checked={view.watch}
              onCheckedChange={(watch) =>
                void call(
                  botRequest(environmentId, CONNECTIONS_ENDPOINTS.settings, {
                    kind: view.kind,
                    watch,
                  }),
                )
              }
            />
          </label>
        </li>
        <ClassifierModel environmentId={environmentId} view={view} onChanged={onChanged} />
      </Section>
      <Section title={t("VIP senders")}>
        <li>
          <LinesEditor
            key={view.vip.join("\n")}
            label={t("VIP senders")}
            placeholder={t("One per line: an address, @domain.com or @handle. VIPs always notify.")}
            saveLabel={t("Save VIPs")}
            values={view.vip}
            onSave={(vip) =>
              call(
                botRequest(environmentId, CONNECTIONS_ENDPOINTS.settings, { kind: view.kind, vip }),
              )
            }
          />
        </li>
      </Section>
      <BotGrants environmentId={environmentId} view={view} onChanged={onChanged} />
      <Section title={t("Activity")}>
        {audit.length === 0 ? (
          <li className="px-4 py-2 text-muted-foreground max-md:px-5">{t("No activity yet.")}</li>
        ) : (
          audit.map((entry) => (
            <li
              key={`${entry.at}:${entry.op}:${entry.actor}`}
              className="flex flex-col px-4 py-2 text-sm max-md:px-5 max-md:text-bot-callout"
            >
              <span className="truncate">
                {entry.op} · {entry.actor} · {entry.status}
                {entry.count === null ? "" : ` · ${entry.count}`}
                {entry.detail ? ` · ${entry.detail}` : ""}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums max-md:text-bot-footnote">
                {clock(entry.at)}
              </span>
            </li>
          ))
        )}
      </Section>
    </div>
  );
}

function SecretField({
  label,
  setAt,
  onSave,
}: {
  label: string;
  setAt: string | null;
  onSave: (value: string) => Promise<unknown>;
}) {
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      data-secret-field
      className={FIELD_ROW}
      onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim()) return;
        setSaving(true);
        void onSave(value).finally(() => {
          setSaving(false);
          setValue("");
        });
      }}
    >
      <span className="shrink-0">{label}</span>
      <Input
        type="password"
        autoComplete="off"
        aria-label={label}
        placeholder={setAt ? t("Set {time}", { time: clock(setAt) }) : t("Not set")}
        className="min-w-0 flex-1"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      {value.trim() ? (
        <Button size="sm" variant="outline" type="submit" disabled={saving}>
          {t("Save")}
        </Button>
      ) : null}
    </form>
  );
}

function CopyLine({
  label,
  value,
  button = t("Copy"),
}: {
  label: string;
  value: string;
  button?: string;
}) {
  return (
    <div className={FIELD_ROW}>
      <span>{label}</span>
      <Button
        size="xs"
        variant="outline"
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => toastManager.add({ type: "success", title: t("Copied.") }), failed)
        }
      >
        {button}
      </Button>
    </div>
  );
}

function LinesEditor({
  label,
  placeholder,
  saveLabel,
  values,
  onSave,
}: {
  label: string;
  placeholder: string;
  saveLabel: string;
  values: ReadonlyArray<string>;
  onSave: (lines: Array<string>) => Promise<unknown>;
}) {
  const [text, setText] = useState(values.join("\n"));
  const changed = text !== values.join("\n");
  return (
    <div data-lines-editor className="flex flex-col gap-1 px-4 py-1.5">
      <Textarea
        aria-label={label}
        placeholder={placeholder}
        className="max-h-32 min-h-16"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {changed ? (
        <Button
          size="xs"
          variant="outline"
          className="self-start"
          onClick={() =>
            void onSave(
              text
                .split("\n")
                .map((v) => v.trim())
                .filter(Boolean),
            )
          }
        >
          {saveLabel}
        </Button>
      ) : null}
    </div>
  );
}

/** The tool-less model that judges messages the rules leave. Default: the cheapest one. */
function ClassifierModel({
  environmentId,
  view,
  onChanged,
}: {
  environmentId: EnvironmentId;
  view: ConnectionView;
  onChanged: () => void;
}) {
  const settings = useEnvironmentSettings(environmentId);
  const providers = (
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS
  ).filter((p) => isProviderAvailable(p) && isProviderTextGenerationCapable(p));
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const fallback = cheapestModel(providers);
  const model = view.model ?? fallback;
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    model?.instanceId,
    model?.model,
  );
  const save = (next: ConnectionView["model"]) =>
    botRequest(environmentId, CONNECTIONS_ENDPOINTS.settings, {
      kind: view.kind,
      model: next,
    }).then(onChanged, failed);
  return (
    <>
      <li data-classifier-model className={FIELD_ROW}>
        <span className="shrink-0">{t("Classifier model")}</span>
        {model ? (
          <ProviderModelPicker
            environmentId={environmentId}
            disabled={false}
            activeInstanceId={model.instanceId}
            model={model.model}
            lockedProvider={null}
            instanceEntries={instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            isComposerOwned={false}
            activeProviderIconClassName={RESTING_PROVIDER_ICON_CLASSNAME}
            triggerClassName={cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full")}
            onInstanceModelChange={(instanceId, next) => void save({ instanceId, model: next })}
          />
        ) : (
          <span className="text-muted-foreground">{t("None available")}</span>
        )}
      </li>
      {view.model ? (
        <li className={FIELD_ROW}>
          <Button size="xs" variant="ghost" onClick={() => void save(null)}>
            {t("Use the cheapest model")}
          </Button>
        </li>
      ) : null}
    </>
  );
}

function BotGrants({
  environmentId,
  view,
  onChanged,
}: {
  environmentId: EnvironmentId;
  view: ConnectionView;
  onChanged: () => void;
}) {
  const bots = useBots(environmentId);
  return (
    <Section
      title={t("Bots that read {connection}", { connection: CONNECTION_LABEL[view.kind] })}
      footer={t("Such a bot loses web, shell, other threads and Cortex writes.")}
    >
      {bots.map((bot) => (
        <li key={bot.threadId}>
          <label className={FIELD_ROW}>
            <span className="truncate">{bot.name}</span>
            <Switch
              checked={view.bots.includes(bot.threadId)}
              onCheckedChange={(granted) =>
                void botRequest(environmentId, CONNECTIONS_ENDPOINTS.grant, {
                  kind: view.kind,
                  botThreadId: bot.threadId,
                  granted,
                }).then(onChanged, failed)
              }
            />
          </label>
        </li>
      ))}
    </Section>
  );
}
