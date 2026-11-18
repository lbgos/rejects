self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: "/icon-192x192.png",
        badge: "/icon-192x192.png",
        tag: `bot:${data.threadId}`,
        data: { threadId: data.threadId },
      }),
      self.navigator.setAppBadge?.(data.unreadCount || 0),
    ]),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const threadId = event.notification.data?.threadId;
  const url = new URL(`/bots?thread=${encodeURIComponent(threadId || "")}`, self.location.origin)
    .href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      const existing = windows.find(
        (client) => new URL(client.url).origin === self.location.origin,
      );
      if (!existing) return self.clients.openWindow(url);
      // Push only comes from the server that serves this origin, so its bot route is enough.
      await existing.focus();
      return existing.navigate(url).catch(() => self.clients.openWindow(url));
    }),
  );
});
self.addEventListener("message", (event) => {
  if (event.data?.type === "badge")
    event.waitUntil(
      Promise.resolve(
        event.data.count
          ? self.navigator.setAppBadge?.(event.data.count)
          : self.navigator.clearAppBadge?.(),
      ),
    );
});
// A first install runs inside "turn on notifications" on a page that just came from the server,
// so only a worker that replaces an older one reloads pages.
let replacing = false;
self.addEventListener("install", () => {
  replacing = self.registration.active !== null;
  return self.skipWaiting();
});

// iOS can restore a Home Screen app from a stored page that runs a bundle the server no longer
// serves. A page with current code answers and reloads itself once nothing holds it; a page that
// does not answer runs an older bundle and is reloaded here.
const ANSWER_TIMEOUT_MS = 1000;
const answers = (client) =>
  new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), ANSWER_TIMEOUT_MS);
    channel.port1.onmessage = () => {
      clearTimeout(timer);
      resolve(true);
    };
    client.postMessage({ type: "worker-updated" }, [channel.port2]);
  });

self.addEventListener("activate", (event) => {
  const claimed = self.clients.claim();
  event.waitUntil(claimed);
  if (!replacing) return;
  // Outside waitUntil: a navigation waits for this worker to finish activating.
  void claimed
    .then(() => self.clients.matchAll({ type: "window" }))
    .then((windows) =>
      Promise.all(
        windows.map(async (client) => {
          if (!(await answers(client))) await client.navigate(client.url).catch(() => null);
        }),
      ),
    );
});
