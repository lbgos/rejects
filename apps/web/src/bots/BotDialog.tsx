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
import { XIcon } from "lucide-react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
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
    <div className="space-y-1.5">
      <Label data-bot-field-label className="flex items-baseline justify-between" htmlFor={htmlFor}>
        <span>{label}</span>
        {hint ? (
          <span className="font-normal text-2xs text-muted-foreground/80 max-md:hidden">
            {hint}
          </span>
        ) : null}
      </Label>
      {children}
      {/* On a phone the note sits under its field. */}
      {hint ? <p className="text-bot-footnote text-muted-foreground md:hidden">{hint}</p> : null}
    </div>
  );
}

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
    <ul className="space-y-0.5 text-xs text-muted-foreground tabular-nums max-md:text-bot-footnote">
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
  const [error, setError] = useState("");
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
    setError("");
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
        throw new Error(t("Bot created. Open it from Bots when the connection catches up."));
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: saved.threadId },
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("Could not save bot."));
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
      <DialogPopup data-bot-surface data-bot-page showCloseButton={false} className="max-w-lg">
        {/* Close, the title, and the confirming action. */}
        <div
          data-bot-nav-bar
          className="grid h-14 shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4"
        >
          <DialogClose
            disabled={saving}
            aria-label={t("Cancel")}
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
                  maxLength={60}
                  value={name}
                  onFocus={(e) => focus === "name" && e.currentTarget.select()}
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
                <Input
                  id="bot-description"
                  maxLength={200}
                  placeholder={t("One line: what this bot does")}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </Field>
              <Field label={t("Job")} htmlFor="bot-job">
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
              <Field label={t("Starters")} htmlFor="bot-starters" hint={t("one per line, up to 4")}>
                <Textarea
                  id="bot-starters"
                  className="max-h-32 overflow-y-auto"
                  value={startersText}
                  onChange={(e) => setStartersText(e.target.value)}
                />
              </Field>
              <label className="flex w-fit cursor-pointer items-center gap-2 text-sm">
                <Checkbox
                  checked={musicSkill}
                  onCheckedChange={(checked) => setMusicSkill(checked === true)}
                />
                {t("Music downloads")}
              </label>
              <Field
                label={t("Models")}
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
                label={t("Daily token cap")}
                htmlFor="bot-cap"
                hint={
                  dailyTokenCap === null ? (
                    <span className="text-destructive">{t("e.g. 500k, 2M")}</span>
                  ) : (
                    t("{tokens}/day; cache reads at 1/10", {
                      tokens: dailyTokenCap.toLocaleString(uiLocales),
                    })
                  )
                }
              >
                <Input
                  id="bot-cap"
                  autoFocus={focus === "cap"}
                  inputMode="text"
                  autoComplete="off"
                  className="max-w-40"
                  value={capText}
                  aria-invalid={dailyTokenCap === null}
                  onFocus={(e) => e.currentTarget.select()}
                  onChange={(e) => setCapText(e.target.value)}
                />
              </Field>
              {bot ? <UsageList usage={bot.usage} /> : null}
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
                    "invalid" in network ? (
                      <span className="text-destructive">
                        {network.invalid
                          ? t("Not an address: {line}", { line: network.invalid })
                          : t("Up to {count} entries", { count: LOCAL_NETWORK_MAX_ENTRIES })}
                      </span>
                    ) : (
                      t("IPv4 or CIDR with a TCP port, one per line")
                    )
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
            </fieldset>
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </form>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
