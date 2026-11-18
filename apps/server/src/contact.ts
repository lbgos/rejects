import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

const fallback = "https://github.com/lbgos/rejects";
const setting = Config.String("T3CODE_CONTACT").pipe(
  Config.withDefault(fallback),
  Config.map((value) => value.trim()),
);
const isUrl = (value: string) => /^(mailto:|https?:\/\/)/.test(value);

/** Who runs this server, as a `mailto:` or `https:` URL: the Web Push VAPID subject and the MusicBrainz User-Agent contact. Any other `T3CODE_CONTACT` reads as the default. */
export const contact = setting.pipe(Config.map((value) => (isUrl(value) ? value : fallback)));

/** Run once at startup: warns when `T3CODE_CONTACT` is set to a value {@link contact} replaces with the default. */
export const warnInvalidContact = Effect.gen(function* () {
  const value = yield* setting;
  if (!isUrl(value)) {
    yield* Effect.logWarning(
      "T3CODE_CONTACT is not a mailto: or https:// URL; using the default contact",
      { fallback },
    );
  }
});
