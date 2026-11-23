import {
  BOTS_ENDPOINTS,
  type BotPreferences,
  type BotReadiness,
  type BotSummary,
  type EnvironmentId,
  type ModelSelection,
  TELEGRAM_ENDPOINTS,
  type TelegramClaim,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { toastManager } from "../components/ui/toast";
import { FIELD_ROW, Row, Section } from "../connections/rows";
import { TokenField } from "../connections/TelegramDetail";
import { usePersistEnvironmentProviderInstanceMutation } from "../hooks/useSettings";
import { setUiLanguageChoice, type UiLanguage, uiLanguage } from "../i18n";
import { waitForThreadShell } from "../state/entities";
import { serverEnvironment } from "../state/server";
import {
  botProviderChoices,
  ENDPOINT_INSTANCE_ID,
  endpointInstance,
  type ProviderChoice,
} from "./firstRun.logic";
import { botRequest } from "./http";
import { refreshBots } from "./state";

/** Each language in its own words: the UI is not in the picked language until the page reloads. */
const LANGUAGES = [
  { id: "uk", label: "Українська" },
  { id: "ru", label: "Русский" },
  { id: "en", label: "English" },
] as const satisfies ReadonlyArray<{ readonly id: UiLanguage; readonly label: string }>;

const CORTEX_DOC = "https://github.com/lbgos/rejects/blob/main/docs/user/cortex.md";

type Blocker = NonNullable<ProviderChoice["blocker"]>;

const COPY = {
  uk: {
    step: "Крок {n} з {of}",
    model: "Модель для ботів",
    endpointRow: "Ключ API та адреса",
    noSandbox: "На цій машині немає пісочниці: боти працюють без терміналу.",
    brokenSandbox:
      "Пісочниця налаштована, але не працює, тож боти не запустяться. Запустіть doctor на сервері.",
    blockers: {
      signIn: "Не виконано вхід",
      checking: "Перевірка…",
      attention: "Потребує уваги",
      noModel: "Немає моделей",
      needsKey: "Тут потрібен ключ API",
      sandboxed: "Не працює в пісочниці",
      toolsOn: "Потрібна пісочниця",
    } satisfies Record<Blocker, string>,
    endpoint: "Сумісна з Anthropic адреса",
    url: "Адреса",
    key: "Ключ",
    modelName: "Модель",
    save: "Зберегти",
    telegram: "Telegram, за бажанням",
    telegramFooter: "Створіть бота в @BotFather і вставте його токен.",
    openTelegram: "Відкрити Telegram",
    cortex: "Cortex, за бажанням",
    cortexFooter: "Локальне сховище знань, яке боти шукають і цитують.",
    cortexOn: "Увімкнено",
    cortexSetUp: "Як налаштувати",
    next: "Далі",
    skip: "Пропустити",
    back: "Назад",
    question: "Ви вже користувалися ШІ-агентами?",
    experienced: "Так, я їх знаю",
    new: "Ні, для мене це нове",
    backToLanguages: "Назад до мов",
    slow: "Головного бота створено. Відкрийте його в «Ботах», коли з’єднання оновиться.",
    failed: "Не вдалося зберегти. Перевірте дані та спробуйте ще раз.",
    failedAnswer: "Налаштування не завершилося. Виберіть відповідь ще раз.",
  },
  ru: {
    step: "Шаг {n} из {of}",
    model: "Модель для ботов",
    endpointRow: "Ключ API и адрес",
    noSandbox: "На этой машине нет песочницы: боты работают без терминала.",
    brokenSandbox:
      "Песочница настроена, но не работает, поэтому боты не запустятся. Запустите doctor на сервере.",
    blockers: {
      signIn: "Вход не выполнен",
      checking: "Проверка…",
      attention: "Требует внимания",
      noModel: "Нет моделей",
      needsKey: "Здесь нужен ключ API",
      sandboxed: "Не работает в песочнице",
      toolsOn: "Нужна песочница",
    } satisfies Record<Blocker, string>,
    endpoint: "Совместимый с Anthropic адрес",
    url: "Адрес",
    key: "Ключ",
    modelName: "Модель",
    save: "Сохранить",
    telegram: "Telegram, по желанию",
    telegramFooter: "Создайте бота в @BotFather и вставьте его токен.",
    openTelegram: "Открыть Telegram",
    cortex: "Cortex, по желанию",
    cortexFooter: "Локальное хранилище знаний, которое боты ищут и цитируют.",
    cortexOn: "Включено",
    cortexSetUp: "Как настроить",
    next: "Далее",
    skip: "Пропустить",
    back: "Назад",
    question: "Вы уже пользовались ИИ-агентами?",
    experienced: "Да, я их знаю",
    new: "Нет, для меня это новое",
    backToLanguages: "Назад к языкам",
    slow: "Главный бот создан. Откройте его в «Ботах», когда соединение обновится.",
    failed: "Не удалось сохранить. Проверьте данные и попробуйте ещё раз.",
    failedAnswer: "Настройка не завершилась. Выберите ответ ещё раз.",
  },
  en: {
    step: "Step {n} of {of}",
    model: "Model for your bots",
    endpointRow: "API key and endpoint",
    noSandbox: "No sandbox on this machine: bots run without a shell.",
    brokenSandbox:
      "The sandbox is set up but fails, so bots will not run. Run doctor on the server.",
    blockers: {
      signIn: "Not signed in",
      checking: "Checking…",
      attention: "Needs attention",
      noModel: "No models",
      needsKey: "Needs an API key here",
      sandboxed: "Not in the sandbox",
      toolsOn: "Needs the sandbox",
    } satisfies Record<Blocker, string>,
    endpoint: "Anthropic-compatible endpoint",
    url: "Endpoint",
    key: "Key",
    modelName: "Model",
    save: "Save",
    telegram: "Telegram, optional",
    telegramFooter: "Make a bot with @BotFather and paste its token.",
    openTelegram: "Open Telegram",
    cortex: "Cortex, optional",
    cortexFooter: "A local knowledge vault bots search and cite.",
    cortexOn: "On",
    cortexSetUp: "How to set it up",
    next: "Next",
    skip: "Skip",
    back: "Back",
    question: "Have you used AI agents before?",
    experienced: "Yes, I know them",
    new: "No, this is new to me",
    backToLanguages: "Back to languages",
    slow: "The main bot is created. Open it from Bots when the connection catches up.",
    failed: "Could not save. Check the details and try again.",
    failedAnswer: "Setup did not finish. Choose an answer again to retry.",
  },
} as const;

const EXPERIENCES = ["experienced", "new"] as const satisfies ReadonlyArray<
  NonNullable<BotPreferences["experience"]>
>;

export const needsFirstRun = (bots: ReadonlyArray<BotSummary>) =>
  bots.every((bot) => !bot.main && bot.threadId.startsWith("builtin:"));

type Step = "model" | "endpoint" | "telegram" | "cortex" | "experience";

/** The endpoint form is part of choosing a model, so both count as the second step. */
const STEP_NUMBER: Record<Step, number> = {
  model: 2,
  endpoint: 2,
  telegram: 3,
  cortex: 4,
  experience: 5,
};
const STEP_COUNT = 5;

/**
 * One step of setup on its own screen: Back and the step count in the bar, the step's question as
 * the title, its rows in a group. A phone gives it the whole Bots tab; wider screens centre it in
 * the main pane.
 */
function StepPage({
  title,
  step,
  stepLine,
  backLabel,
  onBack,
  children,
}: {
  title: string;
  step: number;
  stepLine: string;
  backLabel?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  return (
    <div
      data-bots-setup
      data-bot-page
      className="flex h-full min-h-0 flex-col pt-safe text-foreground"
    >
      <div className="mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col md:justify-center md:pb-24">
        <div className="mt-1 flex h-11 shrink-0 items-center justify-between ps-2 pe-5 md:px-2">
          {onBack ? (
            <Button variant="ghost" onClick={onBack}>
              <ChevronLeftIcon />
              <span className="max-md:text-bot-body">{backLabel}</span>
            </Button>
          ) : (
            <span />
          )}
          <span className="text-xs text-muted-foreground tabular-nums max-md:text-bot-footnote">
            {stepLine.replace("{n}", String(step)).replace("{of}", String(STEP_COUNT))}
          </span>
        </div>
        <h1 className="shrink-0 px-4 pt-1 text-lg font-semibold text-balance max-md:px-5 max-md:text-bot-heading max-md:font-bold">
          {title}
        </h1>
        <div className="min-h-0 overflow-y-auto pb-safe md:flex-none">{children}</div>
      </div>
    </div>
  );
}

/** A step's way forward: one full-width button under its group. */
function StepAction({ children, ...props }: ComponentProps<typeof Button>) {
  return (
    <div className="px-4 pt-4">
      <Button className="w-full" size="pill" {...props}>
        {children}
      </Button>
    </div>
  );
}

/** Language, then the model, an optional Telegram bot and Cortex, then the main bot. */
export function FirstRun({ environmentId }: { environmentId: EnvironmentId }) {
  const [language, setLanguage] = useState<UiLanguage | null>(null);
  const [step, setStep] = useState<Step>("model");
  const [readiness, setReadiness] = useState<BotReadiness | null>(null);
  const [selection, setSelection] = useState<ModelSelection | undefined>(undefined);
  const [busy, setBusy] = useState<BotPreferences["experience"] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const navigate = useNavigate();

  const pickLanguage = (picked: UiLanguage) => {
    setLanguage(picked);
    setStep("model");
    // A server without the endpoint offers only the key step.
    void botRequest(environmentId, BOTS_ENDPOINTS.readiness, {}).then(setReadiness, () =>
      setReadiness({ sandbox: "absent", keyedInstances: [], checks: [] }),
    );
  };

  const start = async (picked: UiLanguage, experience: (typeof EXPERIENCES)[number]) => {
    if (busy) return;
    setBusy(experience);
    setFailure(null);
    try {
      const main = await botRequest(environmentId, BOTS_ENDPOINTS.setup, {
        language: picked,
        experience,
        ...(selection === undefined ? {} : { modelSelection: selection }),
      });
      await refreshBots(environmentId);
      if (!(await waitForThreadShell({ environmentId, threadId: main.threadId }))) {
        toastManager.add({ type: "error", title: COPY[picked].slow });
        setBusy(null);
        // The chat is not ready, but the picked language still applies to the list.
        if (picked !== uiLanguage) setUiLanguageChoice(picked);
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: main.threadId },
      });
      // The reload keeps the chat's address and draws it in the picked language.
      if (picked !== uiLanguage) setUiLanguageChoice(picked);
    } catch {
      // The failure stays beside the choice that caused it, where the retry is.
      setFailure(COPY[picked].failedAnswer);
      setBusy(null);
    }
  };

  if (language === null)
    return (
      <StepPage title="Мова · Язык · Language" step={1} stepLine="{n} / {of}">
        <Section>
          {LANGUAGES.map(({ id, label }) => (
            <li key={id}>
              <Row title={label} value="" onClick={() => pickLanguage(id)} />
            </li>
          ))}
        </Section>
      </StepPage>
    );
  const copy = COPY[language];
  const page = (title: string, back: Step | null, children: ReactNode) => (
    <StepPage
      title={title}
      step={STEP_NUMBER[step]}
      stepLine={copy.step}
      backLabel={copy.back}
      onBack={() => (back === null ? setLanguage(null) : setStep(back))}
    >
      {children}
    </StepPage>
  );
  switch (step) {
    case "model":
      return page(
        copy.model,
        null,
        <ModelStep
          environmentId={environmentId}
          copy={copy}
          readiness={readiness}
          onPick={(picked) => {
            setSelection(picked);
            setStep("telegram");
          }}
          onEndpoint={() => setStep("endpoint")}
        />,
      );
    case "endpoint":
      return page(
        copy.endpoint,
        "model",
        <EndpointStep
          environmentId={environmentId}
          copy={copy}
          onSaved={(picked) => {
            setSelection(picked);
            setStep("telegram");
          }}
        />,
      );
    case "telegram":
      return page(
        copy.telegram,
        "model",
        <TelegramStep environmentId={environmentId} copy={copy} onNext={() => setStep("cortex")} />,
      );
    case "cortex": {
      const on = readiness?.checks.some((check) => check.id === "cortex" && check.state === "ok");
      return page(
        copy.cortex,
        "telegram",
        <>
          <Section footer={copy.cortexFooter}>
            {on ? (
              <li className={FIELD_ROW}>
                <span>Cortex</span>
                <span className="text-muted-foreground">{copy.cortexOn}</span>
              </li>
            ) : (
              <li>
                <Row
                  title={copy.cortexSetUp}
                  value=""
                  onClick={() => window.open(CORTEX_DOC, "_blank", "noopener,noreferrer")}
                />
              </li>
            )}
          </Section>
          <StepAction onClick={() => setStep("experience")}>
            {on ? copy.next : copy.skip}
          </StepAction>
        </>,
      );
    }
    case "experience":
      return page(
        copy.question,
        "cortex",
        <Section
          footer={
            failure ? (
              <span role="alert" className="text-destructive-foreground">
                {failure}
              </span>
            ) : undefined
          }
        >
          {EXPERIENCES.map((experience) => (
            <li key={experience}>
              <Row
                title={copy[experience]}
                value={busy === experience ? "…" : ""}
                onClick={() => void start(language, experience)}
              />
            </li>
          ))}
        </Section>,
      );
  }
}

type Copy = (typeof COPY)[UiLanguage];

function ModelStep({
  environmentId,
  copy,
  readiness,
  onPick,
  onEndpoint,
}: {
  environmentId: EnvironmentId;
  copy: Copy;
  readiness: BotReadiness | null;
  onPick: (selection: ModelSelection) => void;
  onEndpoint: () => void;
}) {
  const providers = useAtomValue(serverEnvironment.providersValueAtom(environmentId));
  const choices =
    readiness === null || !providers ? null : botProviderChoices(providers, readiness);
  const footer =
    readiness?.sandbox === "absent" || readiness?.sandbox === "off"
      ? copy.noSandbox
      : readiness?.sandbox === "broken"
        ? copy.brokenSandbox
        : undefined;
  return (
    <Section footer={footer}>
      {choices === null ? (
        <li className={FIELD_ROW}>
          <span className="text-muted-foreground">{copy.blockers.checking}</span>
        </li>
      ) : (
        choices.map((choice) => (
          <li key={choice.instanceId}>
            {choice.selection ? (
              <Row
                title={choice.name}
                value={choice.selection.model}
                onClick={() => onPick(choice.selection!)}
              />
            ) : (
              <div className={FIELD_ROW}>
                <span className="truncate">{choice.name}</span>
                <span className="truncate text-muted-foreground">
                  {choice.blocker ? copy.blockers[choice.blocker] : ""}
                </span>
              </div>
            )}
          </li>
        ))
      )}
      <li>
        <Row title={copy.endpointRow} value="" onClick={onEndpoint} />
      </li>
    </Section>
  );
}

function EndpointStep({
  environmentId,
  copy,
  onSaved,
}: {
  environmentId: EnvironmentId;
  copy: Copy;
  onSaved: (selection: ModelSelection) => void;
}) {
  const persist = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const ready = key.trim() !== "" && model.trim() !== "";
  // Label over field: an address or a key needs the row's whole width to be read.
  const field = (label: string, input: ReactNode) => (
    <li className="flex flex-col gap-1.5 px-4 py-2.5 text-sm max-md:px-5 max-md:text-bot-callout">
      <span className="text-muted-foreground">{label}</span>
      {input}
    </li>
  );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!ready || saving) return;
        setSaving(true);
        setFailed(false);
        void persist(endpointInstance({ url, key, model })).then((result) => {
          setSaving(false);
          if (result._tag === "Success")
            onSaved({ instanceId: ENDPOINT_INSTANCE_ID, model: model.trim() });
          else setFailed(true);
        });
      }}
    >
      <Section
        footer={
          failed ? (
            <span role="alert" className="text-destructive-foreground">
              {copy.failed}
            </span>
          ) : undefined
        }
      >
        {field(
          copy.url,
          <Input
            aria-label={copy.url}
            placeholder="https://api.anthropic.com"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />,
        )}
        {field(
          copy.key,
          <Input
            type="password"
            autoComplete="off"
            aria-label={copy.key}
            value={key}
            onChange={(event) => setKey(event.target.value)}
          />,
        )}
        {field(
          copy.modelName,
          <Input
            aria-label={copy.modelName}
            placeholder="claude-sonnet-5-5"
            value={model}
            onChange={(event) => setModel(event.target.value)}
          />,
        )}
      </Section>
      <StepAction type="submit" disabled={!ready || saving}>
        {copy.save}
      </StepAction>
    </form>
  );
}

function TelegramStep({
  environmentId,
  copy,
  onNext,
}: {
  environmentId: EnvironmentId;
  copy: Copy;
  onNext: () => void;
}) {
  const [claim, setClaim] = useState<TelegramClaim | null>(null);
  return (
    <>
      <Section footer={claim ? undefined : copy.telegramFooter}>
        {claim ? (
          <li className={FIELD_ROW}>
            <code className="truncate font-mono">/start {claim.code}</code>
            <Button
              size="sm"
              variant="outline"
              render={<a href={claim.link} target="_blank" rel="noreferrer noopener" />}
            >
              {copy.openTelegram}
            </Button>
          </li>
        ) : (
          <li>
            <TokenField
              connected={false}
              onConnect={(token) =>
                botRequest(environmentId, TELEGRAM_ENDPOINTS.connect, { token }).then(
                  setClaim,
                  () => toastManager.add({ type: "error", title: copy.failed }),
                )
              }
            />
          </li>
        )}
      </Section>
      <StepAction variant={claim ? "default" : "secondary"} onClick={onNext}>
        {claim ? copy.next : copy.skip}
      </StepAction>
    </>
  );
}
