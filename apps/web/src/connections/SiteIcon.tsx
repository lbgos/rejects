import { COMMON_SITES, type CommonSite } from "@t3tools/contracts";
import {
  CreditCardIcon,
  FolderIcon,
  GlobeIcon,
  HashIcon,
  LandmarkIcon,
  type LucideIcon,
  MailIcon,
  ReceiptTextIcon,
} from "lucide-react";
import { cn } from "../lib/utils";

const ICONS: Record<CommonSite["id"], { readonly Icon: LucideIcon; readonly color: string }> = {
  gmail: { Icon: MailIcon, color: "text-[#ea4335]" },
  "google-drive": { Icon: FolderIcon, color: "text-[#1fa463]" },
  outlook: { Icon: MailIcon, color: "text-[#28a8ea]" },
  "ukr-net": { Icon: MailIcon, color: "text-[#ffd500]" },
  privat24: { Icon: LandmarkIcon, color: "text-[#8cc63f]" },
  monobank: { Icon: CreditCardIcon, color: "text-foreground" },
  tax: { Icon: ReceiptTextIcon, color: "text-[#4d9fff]" },
};

const SLACK = { Icon: HashIcon, color: "text-foreground" };
const OTHER = { Icon: GlobeIcon, color: "text-muted-foreground" };

export function SiteIcon({ site, className }: { site: string; className?: string }) {
  const known = COMMON_SITES.find((entry) => entry.site === site);
  const { Icon, color } = known ? ICONS[known.id] : site === "slack.com" ? SLACK : OTHER;
  return <Icon aria-hidden className={cn("size-4 shrink-0 max-md:size-5", color, className)} />;
}
