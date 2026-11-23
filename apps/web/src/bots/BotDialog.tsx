import { useAtomValue } from "@effect/atom-react";
import {
  BOT_MODEL_TEMPLATES,
  BOTS_ENDPOINTS,
  type BotModelTemplate,
  botTemplateModels,
  DEFAULT_BOT_DAILY_TOKEN_CAP,
  LOCAL_NETWORK_MAX_ENTRIES,
  parseLocalNetworkEntry,
  ProviderInstanceId,
  type BotIconName,
  type BotInput,
  type BotOwnSkill,
  type BotSummary,
  type ModelSelection,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { t, uiLocales } from "../i18n";
import { cn } from "../lib/utils";
import { botRequest } from "../bots/http";
import { BotIconPicker } from "./BotIconPicker";
import { MailAccountsList, useMailAccounts } from "../connections/MailCards";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { pickModelSelection } from "@t3tools/shared/model";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../providerInstances";
import { type ModelEsque } from "../components/chat/providerIconUtils";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { waitForThreadShell } from "../state/entities";
import {
  ProviderModelPicker,
  RESTING_PROVIDER_ICON_CLASSNAME,
} from "../components/chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import {
  Dialog,
  DialogClose,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { SECTION_TITLE } from "./panelStyles";
import { formatTokens, parseTokenCap, usageSourceLabel } from "./presentation";
import { refreshBots, useBot } from "./state";
import { BOT_TEMPLATES, type BotTemplateId } from "./templates";
import type { BotDialogRequest } from "./ui";

export const DEFAULT_BOT_MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("opencode"),
  model: "opencode-go/deepseek-v4.1-flash",
};

export function resolveDefaultBotModel(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  optionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>,
): ModelSelection {
  let firstAvailable: ModelSelection | undefined;
  for (const entry of entries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    for (const option of optionsByInstance.get(entry.instanceId) ?? []) {
      if (option.isUnavailable) continue;
      const selection = { instanceId: entry.instanceId, model: option.slug };
      firstAvailable ??= selection;
      if (entry.driverKind === "opencode" && option.slug === DEFAULT_BOT_MODEL.model) {
        return selection;
      }
    }
  }
  return firstAvailable ?? DEFAULT_BOT_MODEL;
}

/** A labelled control. Its note always sits under it, so every field in the form reads the same way. */
function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div data-bot-field className="space-y-1 px-4 py-2.5">
      <Label data-bot-field-label htmlFor={htmlFor}>
        {label}
      </Label>
      {children}
      {hint ? (
        <p className="text-xs text-muted-foreground max-md:text-bot-footnote">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * A run of related fields: one rounded group under its quiet title, as the lists on You and
 * Settings are, at every width.
 */
function FieldGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      {title ? <h3 className={cn(SECTION_TITLE, "px-4")}>{title}</h3> : null}
      <div
        data-bot-form-group
        className="divide-y divide-bot-hairline overflow-hidden bg-(--bots-list-surface)"
      >
        {children}
      </div>
    </section>
  );
}

/** Fields most edits never touch stay folded under their title. */
function Disclosure({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="group flex min-h-10 w-full items-center justify-between gap-2 px-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:min-h-11 max-md:text-bot-body">
        {title}
        <ChevronDownIcon
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground group-data-panel-open:rotate-180"
        />
      </CollapsibleTrigger>
      <CollapsiblePanel animate={false}>
        <div className="divide-y divide-bot-hairline border-t border-bot-hairline">{children}</div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/** Says how to fix a refused local network line, not only that it is wrong. */
const localNetworkProblem = (line: string) =>
  /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(line)
    ? t("Add a port, e.g. {example}", { example: `${line}:8080` })
    : t("{line} is not a private address with a port, e.g. 192.168.1.10:22", { line });

function OwnSkillsList({
  skills,
  onRemove,
}: {
  skills: ReadonlyArray<BotOwnSkill>;
  onRemove: (name: string) => void;
}) {
  return (
    <ul className="space-y-1 text-xs max-md:text-bot-footnote">
      {skills.map((skill) => (
        <li key={skill.name} className="flex items-start gap-2">
          <span className="min-w-0 flex-1">
            <span className="font-medium">{skill.name}</span>{" "}
            <span className="text-muted-foreground">{skill.description}</span>
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("Remove skill {name}", { name: skill.name })}
            onClick={() => onRemove(skill.name)}
          >
            <XIcon />
          </Button>
        </li>
      ))}
    </ul>
  );
}

const USAGE_ROWS_SHOWN = 7;

function UsageList({ usage }: { usage: BotSummary["usage"] }) {
  return (
    <ul className="space-y-1 px-4 py-2.5 text-xs text-muted-foreground tabular-nums max-md:text-bot-footnote">
      {usage.slice(0, USAGE_ROWS_SHOWN).map((entry, index) => {
        const top = entry.sources[0];
        return (
          <li key={entry.day} className="flex justify-between gap-3">
            <span className="shrink-0">
              {index === 0
                ? t("Today")
                : new Date(`${entry.day}T00:00:00Z`).toLocaleDateString(uiLocales, {
                    day: "numeric",
                    month: "short",
                    timeZone: "UTC",
                  })}
            </span>
            <span className="min-w-0 truncate text-right">
              {t("{tokens} · {turns} turns", {
                tokens: formatTokens(entry.tokens),
                turns: entry.turns,
              })}
              {top && entry.tokens > 0
                ? ` · ${usageSourceLabel(top.source)} ${Math.round((top.tokens / entry.tokens) * 100)}%`
                : ""}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
const MODEL_TEMPLATE_TEXT: Record<
  BotModelTemplate | "custom",
  () => { name: string; hint: string }
> = {
  light: () => ({ name: t("Light"), hint: t("DeepSeek or GLM, for simple jobs") }),
  opus: () => ({ name: t("Opus"), hint: t("Claude Opus, for hard tasks and conversation") }),
  lead: () => ({ name: t("Lead"), hint: t("Opus plans and checks, a cheap worker does the work") }),
  custom: () => ({ name: t("Custom"), hint: t("the model you pick") }),
};

export const parseStarters = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 4)
    .map((line) => line.slice(0, 200));

const parseLocalNetwork = (text: string) => {
  const entries: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const entry = parseLocalNetworkEntry(line);
    if (entry === undefined) return { invalid: line.trim() };
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries.length > LOCAL_NETWORK_MAX_ENTRIES ? { invalid: "" } : { entries };
};

export function BotDialog({
  request,
  onClose,
}: {
  request: BotDialogRequest;
  onClose: () => void;
}) {
  const { environmentId, focus } = request;
  const bot = useBot(environmentId, request.threadId);
  const mail = useMailAccounts(environmentId, request.threadId);
  const navigate = useNavigate();
  const settings = useEnvironmentSettings(environmentId);
  const allProviders =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  // Bots run unattended, so only providers that can run in full-access mode apply.
  const providers = allProviders.filter(
    (p) => p.supportedRuntimeModes === undefined || p.supportedRuntimeModes.includes("full-access"),
  );
  const instanceEntries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings, null),
  );
  const initial =
    request.threadId === null
      ? BOT_TEMPLATES.find((entry) => entry.id === request.template)
      : undefined;
  const [template, setTemplate] = useState<BotTemplateId | "blank">(initial?.id ?? "blank");
  const [name, setName] = useState(bot?.name ?? initial?.name ?? "");
  const [persona, setPersona] = useState(bot?.persona ?? initial?.persona ?? "");
  const [description, setDescription] = useState(bot?.description ?? initial?.description ?? "");
  const [icon, setIcon] = useState<BotIconName | undefined>(bot?.icon);
  const [startersText, setStartersText] = useState(
    (bot?.starters ?? initial?.starters ?? []).join("\n"),
  );
  const [musicSkill, setMusicSkill] = useState(bot?.skills?.includes("music") ?? false);
  const [selectedModel, setModel] = useState(bot?.modelSelection);
  const [selectedWorker, setWorker] = useState(bot?.workerModel);
  const [modelTemplate, setModelTemplate] = useState<BotModelTemplate | "custom">(
    bot ? (bot.modelTemplate ?? "custom") : "light",
  );
  const templateModels =
    modelTemplate === "custom" ? undefined : botTemplateModels(modelTemplate, allProviders, bot);
  const [capText, setCapText] = useState(
    formatTokens(bot?.dailyTokenCap ?? DEFAULT_BOT_DAILY_TOKEN_CAP),
  );
  const [networkText, setNetworkText] = useState((bot?.localNetwork ?? []).join("\n"));
  const [ownSkills, setOwnSkills] = useState(bot?.ownSkills ?? []);
  const [error, setError] = useState<{ text: string; retry: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const network = parseLocalNetwork(networkText);
  const modelOptionsByInstance = getCustomModelOptionsByInstance(
    settings,
    providers,
    selectedModel?.instanceId,
    selectedModel?.model,
  );
  const model =
    selectedModel ??
    templateModels?.modelSelection ??
    resolveDefaultBotModel(instanceEntries, modelOptionsByInstance);
  const worker =
    modelTemplate === "lead" ? (selectedWorker ?? templateModels?.workerModel) : undefined;
  const available = (selection: ModelSelection) =>
    instanceEntries.some(
      (entry) =>
        entry.instanceId === selection.instanceId &&
        isProviderInstancePickerReady(entry) &&
        modelOptionsByInstance
          .get(entry.instanceId)
          ?.some((option) => option.slug === selection.model && !option.isUnavailable),
    );
  const templateMissing =
    modelTemplate !== "custom" && selectedModel === undefined && templateModels === undefined;
  const modelAvailable =
    !templateMissing &&
    available(model) &&
    (modelTemplate !== "lead" || (worker !== undefined && available(worker)));
  const dailyTokenCap = parseTokenCap(capText);
  const editingMissing = request.threadId !== null && bot === undefined;
  const canSave =
    !editingMissing &&
    name.trim() !== "" &&
    persona.trim() !== "" &&
    dailyTokenCap !== null &&
    "entries" in network &&
    modelAvailable;

  const applyTemplate = (id: BotTemplateId | "blank") => {
    setTemplate(id);
    const picked = BOT_TEMPLATES.find((entry) => entry.id === id);
    setName(picked?.name ?? "");
    setPersona(picked?.persona ?? "");
    setDescription(picked?.description ?? "");
    setStartersText(picked ? picked.starters.join("\n") : "");
  };

  const submit = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const picked = BOT_TEMPLATES.find((entry) => entry.id === template);
      const input: BotInput = {
        name,
        persona,
        description,
        ...(icon === undefined ? {} : { icon }),
        modelSelection: model,
        ...(modelTemplate === "custom" ? {} : { modelTemplate }),
        ...(worker === undefined ? {} : { workerModel: worker }),
        dailyTokenCap,
        starters: parseStarters(startersText),
        skills: musicSkill ? ["music"] : [],
        // A template's tool list applies to the bot made from it; editing keeps the bot's own.
        ...(picked && !bot ? { tools: [...picked.tools] } : {}),
        // Sent only after a removal, so a skill the bot writes while this is open is kept.
        ...(bot && ownSkills.length !== (bot.ownSkills?.length ?? 0) ? { ownSkills } : {}),
      };
      const saved = bot
        ? await botRequest(environmentId, BOTS_ENDPOINTS.update, {
            ...input,
            threadId: bot.threadId,
          })
        : await botRequest(environmentId, BOTS_ENDPOINTS.create, input);
      if (
        bot &&
        "entries" in network &&
        network.entries.join("\n") !== (bot.localNetwork ?? []).join("\n")
      )
        await botRequest(environmentId, BOTS_ENDPOINTS.setLocalNetwork, {
          threadId: bot.threadId,
          localNetwork: network.entries,
        });
      await refreshBots(environmentId);
      if (bot) return onClose();
      if (!(await waitForThreadShell({ environmentId, threadId: saved.threadId })))
        return setError({
          text: t("Bot created. Open it from Bots when the connection catches up."),
          retry: false,
        });
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: saved.threadId },
      });
      onClose();
    } catch (e) {
      setError({ text: e instanceof Error ? e.message : t("Could not save bot."), retry: true });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup
        data-bot-surface
        data-bot-page
        data-bot-form
        showCloseButton={false}
        className="max-w-xl"
      >
        {/* Close, the title, and the confirming action. */}
        <div
          data-bot-nav-bar
          className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4"
        >
          <DialogClose
            disabled={saving}
            aria-label={t("Cancel")}
            data-bot-nav-close
            className="justify-self-start"
            render={<Button variant="ghost" size="icon" />}
          >
            <XIcon />
          </DialogClose>
          <DialogTitle>{request.threadId ? t("Edit bot") : t("New bot")}</DialogTitle>
          <Button
            type="submit"
            form="bot-form"
            size="pill"
            className="justify-self-end"
            disabled={!canSave || saving}
          >
            {saving ? t("Saving…") : request.threadId ? t("Save") : t("Create")}
          </Button>
        </div>
        {/* A failed save says so beside the action that failed, whatever the form is scrolled to. */}
        {error ? (
          <p className="shrink-0 px-6 pb-2 text-sm text-destructive-foreground" role="alert">
            {error.text}
            {error.retry
              ? ` ${t("Your edits are kept: press {action} to try again.", {
                  action: request.threadId ? t("Save") : t("Create"),
                })}`
              : null}
          </p>
        ) : null}
        <DialogPanel>
          <form
            id="bot-form"
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <fieldset disabled={saving} className="min-w-0 space-y-5">
              <FieldGroup>
                {request.threadId === null ? (
                  <Field label={t("Template")} htmlFor="bot-template">
                    <Select
                      value={template}
                      onValueChange={(value) => {
                        const id = BOT_TEMPLATES.find((entry) => entry.id === value)?.id ?? "blank";
                        applyTemplate(id);
                      }}
                    >
                      <SelectTrigger size="sm" id="bot-template">
                        <SelectValue>
                          {(value: string) =>
                            BOT_TEMPLATES.find((entry) => entry.id === value)?.name ?? t("Blank")
                          }
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup data-bot-surface>
                        <SelectItem value="blank">{t("Blank")}</SelectItem>
                        {BOT_TEMPLATES.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>
                            {entry.name}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </Field>
                ) : null}
                {/* No "name" in the id and autofill off: iOS offers the user's contact card there. */}
                <Field label={t("Name")} htmlFor="bot-title">
                  <Input
                    id="bot-title"
                    name="bot-title"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    data-1p-ignore
                    data-lpignore="true"
                    autoFocus={focus !== "cap"}
                    onFocus={(e) => focus === "name" && e.currentTarget.select()}
                    maxLength={60}
                    placeholder={t("Such as Kitchen")}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </Field>
                <Field label={t("Icon")}>
                  <BotIconPicker
                    bot={{ name, kind: bot?.kind, ...(icon === undefined ? {} : { icon }) }}
                    onChange={setIcon}
                  />
                </Field>
                <Field label={t("Description")} htmlFor="bot-description">
                  {/* One sentence, shown whole: it wraps in the field and holds no line break. */}
                  <Textarea
                    id="bot-description"
                    data-bot-one-line
                    rows={1}
                    maxLength={200}
                    placeholder={t("One line: what this bot does")}
                    value={description}
                    onChange={(e) => setDescription(e.target.value.replace(/\s*\n\s*/g, " "))}
                  />
                </Field>
              </FieldGroup>
              <FieldGroup title={t("Job")}>
                <Field label={t("What it does")} htmlFor="bot-job">
                  <Textarea
                    id="bot-job"
                    className="max-h-64 overflow-y-auto"
                    maxLength={16000}
                    placeholder={t(
                      "What should this bot do on each wake, and when should it notify you?",
                    )}
                    value={persona}
                    onChange={(e) => setPersona(e.target.value)}
                  />
                </Field>
                <Field
                  label={t("Starters")}
                  htmlFor="bot-starters"
                  hint={t("Shown in an empty chat.")}
                >
                  <Textarea
                    id="bot-starters"
                    placeholder={t("One per line, up to 4")}
                    className="max-h-32 overflow-y-auto"
                    value={startersText}
                    onChange={(e) => setStartersText(e.target.value)}
                  />
                </Field>
              </FieldGroup>
              <FieldGroup title={t("Model and limits")}>
                <Field
                  label={t("Preset")}
                  htmlFor="bot-model-template"
                  hint={
                    templateMissing ? (
                      <span className="text-destructive">{t("Not configured on this server")}</span>
                    ) : (
                      MODEL_TEMPLATE_TEXT[modelTemplate]().hint
                    )
                  }
                >
                  <Select
                    value={modelTemplate}
                    onValueChange={(value) => {
                      const next =
                        BOT_MODEL_TEMPLATES.find((entry) => entry === value) ?? ("custom" as const);
                      setModelTemplate(next);
                      // A template sets its models again; Custom keeps the ones shown.
                      if (next === "custom") {
                        setModel(model);
                        return;
                      }
                      setModel(undefined);
                      setWorker(undefined);
                    }}
                  >
                    <SelectTrigger size="sm" id="bot-model-template">
                      <SelectValue>
                        {(value: string) =>
                          MODEL_TEMPLATE_TEXT[
                            BOT_MODEL_TEMPLATES.find((entry) => entry === value) ?? "custom"
                          ]().name
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup data-bot-surface>
                      {[...BOT_MODEL_TEMPLATES, "custom" as const].map((entry) => (
                        <SelectItem key={entry} value={entry}>
                          {MODEL_TEMPLATE_TEXT[entry]().name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </Field>
                <Field label={t("Model")}>
                  <div data-bot-model-field className="min-w-0">
                    <ProviderModelPicker
                      environmentId={environmentId}
                      disabled={saving}
                      activeInstanceId={model.instanceId}
                      model={model.model}
                      lockedProvider={null}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      isComposerOwned={false}
                      activeProviderIconClassName={RESTING_PROVIDER_ICON_CLASSNAME}
                      triggerClassName={cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full")}
                      onInstanceModelChange={(instanceId, next) => {
                        setModel(pickModelSelection(model, instanceId, next));
                        // Lead keeps its worker setup; any other hand pick leaves the template.
                        if (modelTemplate !== "lead") setModelTemplate("custom");
                      }}
                    />
                  </div>
                </Field>
                {modelTemplate === "lead" && worker ? (
                  <Field label={t("Worker model")}>
                    <div data-bot-model-field className="min-w-0">
                      <ProviderModelPicker
                        environmentId={environmentId}
                        disabled={saving}
                        activeInstanceId={worker.instanceId}
                        model={worker.model}
                        lockedProvider={null}
                        instanceEntries={instanceEntries}
                        modelOptionsByInstance={modelOptionsByInstance}
                        isComposerOwned={false}
                        activeProviderIconClassName={RESTING_PROVIDER_ICON_CLASSNAME}
                        triggerClassName={cn(SETTINGS_PICKER_TRIGGER_CLASSNAME, "max-w-full")}
                        onInstanceModelChange={(instanceId, next) =>
                          setWorker(pickModelSelection(worker, instanceId, next))
                        }
                      />
                    </div>
                  </Field>
                ) : null}
                <Field
                  label={t("Daily limit")}
                  htmlFor="bot-cap"
                  hint={
                    <span className={dailyTokenCap === null ? "text-destructive" : undefined}>
                      {t("Tokens a day, such as 500k or 2M")}
                    </span>
                  }
                >
                  <Input
                    id="bot-cap"
                    autoFocus={focus === "cap"}
                    inputMode="text"
                    autoComplete="off"
                    value={capText}
                    aria-invalid={dailyTokenCap === null}
                    onFocus={(e) => e.currentTarget.select()}
                    onChange={(e) => setCapText(e.target.value)}
                  />
                </Field>
              </FieldGroup>
              {bot && bot.usage.length > 0 ? (
                <FieldGroup>
                  <Disclosure title={t("Usage, last 7 days")}>
                    <UsageList usage={bot.usage} />
                  </Disclosure>
                </FieldGroup>
              ) : null}
              <FieldGroup>
                {/* Open when the bot already uses something in it. */}
                <Disclosure
                  title={t("Advanced")}
                  defaultOpen={
                    (bot?.skills?.includes("music") ?? false) ||
                    (bot?.localNetwork?.length ?? 0) > 0 ||
                    (bot?.ownSkills?.length ?? 0) > 0
                  }
                >
                  <label className="flex min-h-10 w-full cursor-pointer items-center gap-2 px-4 text-sm max-md:min-h-11 max-md:text-bot-body">
                    <Checkbox
                      checked={musicSkill}
                      onCheckedChange={(checked) => setMusicSkill(checked === true)}
                    />
                    {t("Music downloads")}
                  </label>
                  {ownSkills.length > 0 ? (
                    <Field label={t("Skills it wrote")}>
                      <OwnSkillsList
                        skills={ownSkills}
                        onRemove={(name) =>
                          setOwnSkills((current) => current.filter((skill) => skill.name !== name))
                        }
                      />
                    </Field>
                  ) : null}
                  {/* Accounts are connected from the bot's chat; here they are only listed and removed. */}
                  {bot && mail.accounts.length > 0 ? (
                    <Field label={t("Mail accounts")}>
                      <MailAccountsList
                        environmentId={environmentId}
                        accounts={mail.accounts}
                        onChange={mail.refresh}
                      />
                    </Field>
                  ) : null}
                  {/* Owner only: the route needs the settings scope, and no bot tool can set it. */}
                  {bot ? (
                    <Field
                      label={t("Local network access")}
                      htmlFor="bot-network"
                      hint={
                        <span className={"invalid" in network ? "text-destructive" : undefined}>
                          {"invalid" in network
                            ? network.invalid
                              ? localNetworkProblem(network.invalid)
                              : t("Up to {count} entries", { count: LOCAL_NETWORK_MAX_ENTRIES })
                            : t("IPv4 or CIDR with a TCP port, one per line")}
                        </span>
                      }
                    >
                      <Textarea
                        id="bot-network"
                        className="max-h-32 overflow-y-auto"
                        spellCheck={false}
                        placeholder="192.168.1.10:22"
                        aria-invalid={"invalid" in network}
                        value={networkText}
                        onChange={(e) => setNetworkText(e.target.value)}
                      />
                    </Field>
                  ) : null}
                </Disclosure>
              </FieldGroup>
            </fieldset>
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
