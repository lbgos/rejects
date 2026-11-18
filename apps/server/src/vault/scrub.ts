const OPTIONALLY_ENCODED = ["!", "'", "(", ")", "*", "~"] as const;

/** Shortest form worth looking for; a shorter run would blank out ordinary text. */
const MIN_FORM_LENGTH = 4;

const base64Forms = (bytes: Buffer): ReadonlyArray<string> =>
  [0, 1, 2].flatMap((lead) => {
    const encoded = Buffer.concat([Buffer.alloc(lead), bytes]).toString("base64");
    const start = Math.ceil((lead * 8) / 6);
    const end = Math.floor(((lead + bytes.length) * 8) / 6);
    const standard = encoded.slice(start, end);
    return [standard, standard.replace(/\+/g, "-").replace(/\//g, "_")];
  });

/** Matching ignores case and whitespace inside a form, as a page that splits or collapses the secret shows it. */
const secretForms = (value: string): ReadonlyArray<string> => {
  const encoded = encodeURIComponent(value);
  const present = OPTIONALLY_ENCODED.filter((char) => encoded.includes(char));
  const forms = [value, value.replace(/ /g, "+")];
  for (let subset = 0; subset < 1 << present.length; subset++) {
    const chosen = present.filter((_, index) => (subset >> index) & 1);
    const form = chosen.reduce(
      (text, char) => text.split(char).join(`%${char.charCodeAt(0).toString(16).toUpperCase()}`),
      encoded,
    );
    forms.push(form, form.replace(/%20/g, "+"));
  }
  forms.push(...base64Forms(Buffer.from(value)));
  // The secret itself always counts; its encodings only when long enough not to match ordinary text.
  const bare = value.replace(/\s+/g, "");
  // Longest first, so a form that contains another is replaced whole.
  return [...new Set(forms.map((form) => form.replace(/\s+/g, "")))]
    .filter((form) => form === bare || form.length >= MIN_FORM_LENGTH)
    .filter((form) => form.length > 0)
    .toSorted((left, right) => right.length - left.length);
};

const escapeRegExp = (char: string) => char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

const formPattern = (form: string) => Array.from(form).map(escapeRegExp).join("\\s*");

const INVISIBLE = /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180F\uFE00-\uFE0F\u3164\uFFA0]/gu;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const fromCodePoint = (code: number, fallback: string) =>
  code <= 0x10ffff ? String.fromCodePoint(code) : fallback;

const decodeLayer = (text: string) =>
  text
    .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (all, hex: string) =>
      fromCodePoint(parseInt(hex, 16), all),
    )
    .replace(/\\u([0-9a-f]{4})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#x([0-9a-f]{1,6});?/gi, (all, hex: string) => fromCodePoint(parseInt(hex, 16), all))
    .replace(/&#([0-9]{1,7});?/g, (all, digits: string) => fromCodePoint(Number(digits), all))
    .replace(/&([a-z]{2,6});/gi, (all, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? all)
    .replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });

const compatible = (text: string) => text.normalize("NFKC").replace(INVISIBLE, "");

/** A page that echoes a secret through these encodings shows it here in plain letters. */
const normalize = (text: string) => {
  let current = compatible(text);
  for (let layer = 0; layer < 4; layer++) {
    const next = compatible(decodeLayer(current));
    if (next === current) break;
    current = next;
  }
  return current;
};

const patterns = new Map<string, RegExp | null>();

const patternOf = (value: string) => {
  const cached = patterns.get(value);
  if (cached !== undefined) return cached;
  const forms = [...new Set([...secretForms(value), ...secretForms(normalize(value))])].toSorted(
    (left, right) => right.length - left.length,
  );
  const pattern = forms.length === 0 ? null : new RegExp(forms.map(formPattern).join("|"), "gi");
  if (patterns.size >= 64) patterns.clear();
  patterns.set(value, pattern);
  return pattern;
};

const scrubAs = (text: string, secrets: ReadonlyMap<string, string>) =>
  [...secrets].reduce((scrubbed, [value, name]) => {
    const pattern = patternOf(value);
    return pattern === null ? scrubbed : scrubbed.replace(pattern, `[secret ${name}]`);
  }, text);

/** When the normalized text holds a secret, the normalized, scrubbed text is returned, which over-redacts. */
export const scrubSecrets = (text: string, secrets: ReadonlyMap<string, string>) => {
  const direct = scrubAs(text, secrets);
  const plain = normalize(direct);
  const hidden = scrubAs(plain, secrets);
  return hidden === plain ? direct : hidden;
};
