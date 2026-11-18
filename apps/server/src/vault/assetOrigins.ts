/**
 * A page may fetch from them; the top-level page may not navigate to them. These are seeds for the common sites;
 * a site missing here loads only its own origin and the origins the user allowed for it.
 */
const GOOGLE = ["gstatic.com", "googleusercontent.com", "googleapis.com", "ggpht.com"];
const OLX = ["olxcdn.com"];

const ASSET_ORIGINS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "olx.ua": OLX,
  "olx.pl": OLX,
  "olx.pt": OLX,
  "olx.ro": OLX,
  "olx.bg": OLX,
  "olx.kz": OLX,
  "olx.uz": OLX,
  "google.com": GOOGLE,
  "gmail.com": GOOGLE,
  "proton.me": ["protonmail.com"],
  "x.com": ["twimg.com", "twitter.com"],
  "slack.com": ["slack-edge.com", "slack-imgs.com", "slackb.com"],
};

export const assetOriginsOf = (site: string): ReadonlyArray<string> => {
  const host = site.split(":")[0] ?? site;
  const labels = host.split(".");
  for (let start = 0; start < labels.length - 1; start++) {
    const assets = ASSET_ORIGINS[labels.slice(start).join(".")];
    if (assets !== undefined) return assets;
  }
  return [];
};
