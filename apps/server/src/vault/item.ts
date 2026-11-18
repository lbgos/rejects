/** One thing a bot or the watcher reads. `id` is stable per connector so the watcher can dedupe. */
export interface ReadItem {
  readonly id: string;
  readonly kind: "mention" | "dm" | "mail";
  readonly from: string;
  readonly title: string;
  readonly text: string;
  readonly at: string | null;
}
