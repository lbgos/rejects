import {
  type EnvironmentId,
  TELEGRAM_ENDPOINTS,
  type TelegramClaim,
  type TelegramState,
} from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { botRequest } from "../bots/http";
import { useBots } from "../bots/state";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { QRCodeSvg } from "../components/ui/qr-code";
import { Switch } from "../components/ui/switch";
import { t } from "../i18n";
import { cn } from "../lib/utils";
import { FIELD_ROW, failed, Section } from "./rows";

export function telegramStatus(state: TelegramState) {
  if (!state.connected) return state.error ?? t("Not connected");
  if (state.error) return state.error;
  return state.owner ? state.owner.name : t("Waiting for /start");
}

export function TelegramDetail({
  environmentId,
  state,
  onState,
}: {
  environmentId: EnvironmentId;
  state: TelegramState;
  onState: (state: TelegramState) => void;
}) {
  const bots = useBots(environmentId);
  const [claim, setClaim] = useState<TelegramClaim | null>(null);
  const claimed = (next: TelegramClaim) => {
    setClaim(next);
    onState(next.state);
  };
  const configure = (input: (typeof TELEGRAM_ENDPOINTS.settings.payload)["Type"]) =>
    botRequest(environmentId, TELEGRAM_ENDPOINTS.settings, input).then(onState, failed);
  const pending = claim !== null && state.claimExpiresAt !== null ? claim : null;
  const [sendBefore, sendAfter] = t("Send {command} to @{bot}", {
    bot: state.botUsername ?? "",
  }).split("{command}");

  return (
    <div data-telegram-page className="flex flex-col pb-6 text-sm">
      <p
        className={
          state.error
            ? "px-4 pt-4 text-base text-destructive-foreground"
            : "px-4 pt-4 text-base text-muted-foreground"
        }
      >
        {state.connected && state.botUsername ? `@${state.botUsername} · ` : ""}
        {telegramStatus(state)}
      </p>
      <Section
        title={t("Bot")}
        footer={t(
          "Make a bot with @BotFather and paste its token. Telegram chats are not end-to-end encrypted.",
        )}
      >
        <li>
          <TokenField
            connected={state.connected}
            onConnect={(token) =>
              botRequest(environmentId, TELEGRAM_ENDPOINTS.connect, { token }).then(claimed, failed)
            }
          />
        </li>
      </Section>
      {state.connected ? (
        <Section
          title={t("Owner")}
          footer={t("The bot answers only this chat. A new code lets another chat take over.")}
        >
          {pending ? (
            <li data-telegram-claim className="flex flex-col gap-3 px-4 py-3 max-md:px-5">
              <span>
                {sendBefore}
                <code className="font-mono">/start {pending.code}</code>
                {sendAfter}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  render={<a href={pending.link} target="_blank" rel="noreferrer noopener" />}
                >
                  {t("Open Telegram")}
                </Button>
              </div>
              <QRCodeSvg
                value={pending.link}
                size={132}
                level="M"
                marginSize={2}
                title={t("Scan to open the bot in Telegram")}
                className="max-md:hidden"
              />
            </li>
          ) : (
            <li className={FIELD_ROW}>
              <span className="truncate">{state.owner?.name ?? t("Nobody yet")}</span>
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  void botRequest(environmentId, TELEGRAM_ENDPOINTS.code, {}).then(claimed, failed)
                }
              >
                {state.owner ? t("New code") : t("Get code")}
              </Button>
            </li>
          )}
        </Section>
      ) : null}
      <Section
        title={t("Main bot")}
        footer={t(
          "Telegram reaches this bot’s chat. It hands files to other bots without opening them.",
        )}
      >
        {bots
          .filter((bot) => bot.kind !== "music")
          // The chosen bot stays in view on top of a long list.
          .toSorted(
            (a, b) => Number(b.threadId === state.mainBot) - Number(a.threadId === state.mainBot),
          )
          .map((bot) => {
            const main = state.mainBot === bot.threadId;
            return (
              <li key={bot.threadId}>
                <button
                  type="button"
                  className={cn(FIELD_ROW, "w-full text-left hover:bg-accent")}
                  aria-pressed={main}
                  onClick={() => void configure({ mainBot: main ? null : bot.threadId })}
                >
                  <span className="truncate">{bot.name}</span>
                  {main ? <CheckIcon className="size-4 shrink-0" /> : null}
                </button>
              </li>
            );
          })}
      </Section>
      <Section
        title={t("Delivery")}
        footer={t("Off: a shared file waits for the bot’s next message in Telegram.")}
      >
        <li>
          <label className={FIELD_ROW}>
            <span>{t("Send files at once")}</span>
            <Switch
              checked={state.filesNow}
              onCheckedChange={(filesNow) => void configure({ filesNow })}
            />
          </label>
        </li>
      </Section>
      <Section
        title={t("Voice")}
        footer={t(
          "Voice notes are transcribed on your network, by Nemotron or else Whisper, and wait while both are down. The cloud fallback sends audio to OpenAI and is skipped while zero data retention is on.",
        )}
      >
        {state.voiceQueued > 0 ? (
          <li className={FIELD_ROW}>
            <span>{t("Waiting")}</span>
            <span className="text-muted-foreground tabular-nums">{state.voiceQueued}</span>
          </li>
        ) : null}
        <li>
          <label className={FIELD_ROW}>
            <span>{t("Cloud fallback")}</span>
            <Switch
              checked={state.cloudVoice}
              onCheckedChange={(cloudVoice) => void configure({ cloudVoice })}
            />
          </label>
        </li>
        {state.cloudVoice ? (
          <li>
            <KeyField
              isSet={state.cloudVoiceKey}
              onSave={(cloudVoiceKey) => configure({ cloudVoiceKey })}
            />
          </li>
        ) : null}
      </Section>
      {state.connected ? (
        <div className="px-4 pt-5 max-md:px-5">
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              void botRequest(environmentId, TELEGRAM_ENDPOINTS.disconnect, {}).then((next) => {
                setClaim(null);
                onState(next);
              }, failed)
            }
          >
            {t("Disconnect")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** Write-only: the token goes to the server's secret store and never comes back. */
export function TokenField({
  connected,
  onConnect,
}: {
  connected: boolean;
  onConnect: (token: string) => Promise<unknown>;
}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <form
      className={FIELD_ROW}
      onSubmit={(event) => {
        event.preventDefault();
        if (!token.trim()) return;
        setSaving(true);
        void onConnect(token.trim()).finally(() => {
          setSaving(false);
          setToken("");
        });
      }}
    >
      <span className="shrink-0">{t("Token")}</span>
      <Input
        type="password"
        autoComplete="off"
        aria-label={t("Bot token")}
        placeholder={connected ? t("Saved") : "123456:ABC…"}
        className="min-w-0 flex-1"
        value={token}
        onChange={(event) => setToken(event.target.value)}
      />
      {token.trim() ? (
        <Button size="sm" variant="outline" type="submit" disabled={saving}>
          {t("Connect")}
        </Button>
      ) : null}
    </form>
  );
}

function KeyField({
  isSet,
  onSave,
}: {
  isSet: boolean;
  onSave: (key: string) => Promise<unknown>;
}) {
  const [key, setKey] = useState("");
  return (
    <form
      className={FIELD_ROW}
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(key.trim()).finally(() => setKey(""));
      }}
    >
      <span className="shrink-0">{t("OpenAI key")}</span>
      <Input
        type="password"
        autoComplete="off"
        aria-label={t("OpenAI key for voice")}
        placeholder={isSet ? t("Saved") : t("Not set")}
        className="min-w-0 flex-1"
        value={key}
        onChange={(event) => setKey(event.target.value)}
      />
      {key.trim() ? (
        <Button size="sm" variant="outline" type="submit">
          {t("Save")}
        </Button>
      ) : isSet ? (
        <Button size="sm" variant="ghost" type="submit">
          {t("Remove")}
        </Button>
      ) : null}
    </form>
  );
}
