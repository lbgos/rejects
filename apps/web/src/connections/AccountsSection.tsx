import {
  type AccountView,
  COMMON_SITES,
  CONNECTION_LABEL,
  type ConnectionView,
  type ConnectionsState,
  siteName,
  siteOf,
} from "@t3tools/contracts";
import { type ReactNode, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { plural, t, uiLanguage } from "../i18n";
import { Row, Section } from "./rows";
import { SiteIcon } from "./SiteIcon";

const GMAIL_SITE = "mail.google.com";

export function connectorStatus(view: ConnectionView) {
  switch (view.status) {
    case "connected":
      return view.account ?? t("Connected");
    case "paused":
      return t("Paused");
    case "error":
      return view.error ?? t("Error");
    case "setup":
      return t("Not connected");
  }
}

export function accountStatus(account: AccountView) {
  if (account.signedInAt === null) return t("Signed out");
  if (account.bots.length === 0) return t("Signed in");
  return plural(account.bots.length, {
    en: ["{count} bot", "{count} bots"],
    uk: ["{count} бот", "{count} боти", "{count} ботів"],
    ru: ["{count} бот", "{count} бота", "{count} ботов"],
  });
}

export function gmailBrowserAccount(state: ConnectionsState) {
  const connector = state.connections.find((view) => view.kind === "gmail");
  if (!connector || connector.status === "setup") return undefined;
  return state.accounts.find((account) => account.site === GMAIL_SITE);
}

interface Item {
  readonly key: string;
  readonly icon: ReactNode;
  readonly title: string;
  readonly value: string;
  readonly error: boolean;
  readonly onClick: () => void;
}

export function ConnectSection({
  state,
  onOpenAccount,
  onOpenConnector,
  onSignIn,
}: {
  state: ConnectionsState;
  onOpenAccount: (site: string) => void;
  onOpenConnector: (kind: ConnectionView["kind"]) => void;
  onSignIn: (site: string) => void;
}) {
  const accountItem = (account: AccountView): Item => ({
    key: account.site,
    icon: <SiteIcon site={account.site} />,
    title: siteName(account.site, uiLanguage),
    value: accountStatus(account),
    error: false,
    onClick: () => onOpenAccount(account.site),
  });
  const accountAt = (site: string) => state.accounts.find((account) => account.site === site);
  const connectorItems = state.connections.flatMap((view): Item[] => {
    const browser = view.kind === "gmail" ? accountAt(GMAIL_SITE) : undefined;
    if (browser && view.status === "setup") return [accountItem(browser)];
    return [
      {
        key: view.kind,
        icon: <SiteIcon site={view.kind === "gmail" ? GMAIL_SITE : "slack.com"} />,
        title: CONNECTION_LABEL[view.kind],
        value: state.available
          ? `${connectorStatus(view)}${view.watch && view.status === "connected" ? ` · ${t("watching")}` : ""}`
          : t("Unavailable"),
        error: state.available && view.status === "error",
        onClick: () => onOpenConnector(view.kind),
      },
    ];
  });
  const siteItems = COMMON_SITES.filter((entry) => entry.site !== GMAIL_SITE).map((entry): Item => {
    const account = accountAt(entry.site);
    return account
      ? accountItem(account)
      : {
          key: entry.site,
          icon: <SiteIcon site={entry.site} />,
          title: entry.name[uiLanguage],
          value: "",
          error: false,
          onClick: () => onSignIn(entry.site),
        };
  });
  const otherItems = state.accounts
    .filter(
      (account) =>
        account.site !== GMAIL_SITE && !COMMON_SITES.some((entry) => entry.site === account.site),
    )
    .map(accountItem);
  return (
    <Section title={t("Connect")} footer={state.available ? null : t("Vault not answering.")}>
      {[...connectorItems, ...siteItems, ...otherItems].map((item) => (
        <li key={item.key}>
          <Row
            icon={item.icon}
            title={item.title}
            value={item.value}
            tone={item.error ? "error" : "muted"}
            onClick={item.onClick}
          />
        </li>
      ))}
      <li>
        <OtherSite onAdd={onSignIn} />
      </li>
    </Section>
  );
}

function OtherSite({ onAdd }: { onAdd: (site: string) => void }) {
  const [text, setText] = useState("");
  const site = siteOf(text);
  return (
    <form
      className="flex items-center gap-2 px-4 py-2 max-md:px-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!site) return;
        onAdd(site);
        setText("");
      }}
    >
      <Input
        aria-label={t("Site to sign in to")}
        placeholder={t("Other site, such as x.com")}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        className="min-w-0 flex-1"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <Button size="sm" variant="outline" type="submit" disabled={!site}>
        {t("Sign in")}
      </Button>
    </form>
  );
}
