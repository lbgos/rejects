import { holdWorkerReload } from "../workerReload";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";
import { botRequest } from "../bots/http";
import { t } from "../i18n";
import { usePrimaryEnvironmentId } from "../state/environments";

const pushBlocker = () => {
  // iOS delivers Web Push only to a page opened from the Home Screen.
  if (
    /iPhone|iPad|iPod/.test(navigator.userAgent) &&
    !window.matchMedia("(display-mode: standalone)").matches
  )
    return t(
      "For notifications on iPhone: Safari → Share → Add to Home Screen, then turn them on there.",
    );
  if (!window.isSecureContext) return t("Notifications need the app’s HTTPS address.");
  if (!("serviceWorker" in navigator) || !("PushManager" in window))
    return t("This browser has no Web Push.");
  return null;
};

const keyEndpoint = {
  path: "/api/push/key",
  payload: Schema.Struct({}),
  success: Schema.Struct({ key: Schema.String }),
  scope: AuthOrchestrationOperateScope,
} as const;
const subscribeEndpoint = {
  path: "/api/push/subscribe",
  payload: Schema.Struct({
    endpoint: Schema.String,
    keys: Schema.Struct({ p256dh: Schema.String, auth: Schema.String }),
  }),
  success: Schema.Struct({}),
  scope: AuthOrchestrationOperateScope,
} as const;
const unsubscribeEndpoint = {
  path: "/api/push/unsubscribe",
  payload: Schema.Struct({ endpoint: Schema.String }),
  success: Schema.Struct({}),
  scope: AuthOrchestrationOperateScope,
} as const;

/** A page has one push subscription, signed with one server's key, so it always belongs to the server that serves this page. */
export function usePush() {
  const environmentId = usePrimaryEnvironmentId();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState<boolean | null>(() =>
    "serviceWorker" in navigator ? null : false,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the browser's existing push subscription once on mount
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    let mounted = true;
    void navigator.serviceWorker
      .getRegistration("/")
      .then(async (registration) => {
        const subscription = await registration?.pushManager.getSubscription();
        if (mounted) setEnabled(Boolean(subscription));
      })
      .catch(() => {
        if (mounted) setEnabled(false);
      });
    return () => {
      mounted = false;
    };
  }, []);

  const run = async (change: () => Promise<string>, fallback: string) => {
    if (!environmentId) return;
    setBusy(true);
    setMessage(null);
    // A worker update reloads the page; mid-subscribe that would leave push half set up.
    const release = holdWorkerReload();
    try {
      setMessage(await change());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : fallback);
    } finally {
      release();
    }
    setBusy(false);
  };

  const enable = () =>
    run(async () => {
      if (!environmentId) throw new Error(t("Not connected."));
      const blocker = pushBlocker();
      if (blocker) throw new Error(blocker);
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error(t("Allow notifications in system settings."));
      const registration = await navigator.serviceWorker.register("/service-worker.js", {
        scope: "/",
      });
      await navigator.serviceWorker.ready;
      const { key } = await botRequest(environmentId, keyEndpoint, {});
      const decoded = atob(key.replace(/-/g, "+").replace(/_/g, "/"));
      const applicationServerKey = Uint8Array.from(decoded, (c) => c.charCodeAt(0));
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await Promise.race([
          registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }),
          new Promise<never>((_, reject) =>
            window.setTimeout(
              () => reject(new Error(t("The browser push service did not respond. Try again."))),
              30000,
            ),
          ),
        ]));
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth)
        throw new Error(t("The browser did not return a subscription."));
      await botRequest(environmentId, subscribeEndpoint, {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      });
      setEnabled(true);
      return t("On. Bot messages and replies notify this device.");
    }, t("Could not enable notifications."));

  const disable = () =>
    run(async () => {
      if (!environmentId) throw new Error(t("Not connected."));
      const subscription = await (
        await navigator.serviceWorker.getRegistration("/")
      )?.pushManager.getSubscription();
      if (subscription) {
        await botRequest(environmentId, unsubscribeEndpoint, { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      setEnabled(false);
      return t("Off on this device.");
    }, t("Could not disable notifications."));

  return {
    environmentId,
    enabled,
    busy,
    message,
    blocker: pushBlocker(),
    enable,
    disable,
  };
}
