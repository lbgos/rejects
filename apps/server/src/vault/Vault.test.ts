import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  GMAIL_COMPOSE_SCOPE,
  GMAIL_MODIFY_SCOPE,
  ThreadId,
  oauthClientMissing,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  BrowserError,
  type Browsers,
  type PageAction,
  type PageText,
  type Pin,
} from "./browser.ts";
import type { Gmail } from "./gmail.ts";
import { makeFlows } from "./oauth.ts";
import { writeScopes, type Slack } from "./slack.ts";
import type { OAuthClient } from "./services.ts";
import { makeVault, PASSWORD_RETRY_MS } from "./Vault.ts";
import * as VaultStore from "./VaultStore.ts";

const unreachable = new Proxy(
  {},
  {
    get: (_, name) => () => {
      throw new Error(`provider called: ${String(name)}`);
    },
  },
);

interface TestSecret {
  readonly name: string;
  readonly value: string;
  readonly site: string;
  readonly kind?: "username" | "password" | "code";
}

const makeTestVault = (signedIn: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vault-test-" });
    const store = yield* VaultStore.make(dir);
    const acted: Array<PageAction> = [];
    const wiped: Array<string> = [];
    const landing: {
      url: string;
      title: string;
      text: string;
      error?: string | undefined;
      wrongField?: boolean;
      blocked: PageText["blocked"];
      challenge: PageText["challenge"];
      form: PageText["form"];
    } = {
      url: "https://www.olx.ua/uk/chat/1",
      title: "Chat",
      text: "x".repeat(15_000),
      blocked: null,
      challenge: null,
      form: null,
    };
    const browsers = {
      openSheet: () => Effect.void,
      closeSheet: () => Effect.void,
      linkOf: (_profile: string, _pin: Pin, ref: string) =>
        Effect.succeed(ref === "e2" ? "https://www.olx.ua/uk/obyavlenie/1" : null),
      act: (_profile: string, _pin: Pin, action: PageAction) =>
        Effect.suspend(() => {
          acted.push(action);
          return landing.error === undefined
            ? Effect.succeed({
                element: action.action === "type" ? "Message" : "Send",
                ...landing,
              })
            : Effect.fail(
                new BrowserError({
                  message: landing.error,
                  ...(landing.wrongField ? { wrongField: true } : {}),
                }),
              );
        }),
      wipe: (profile: string) => Effect.sync(() => void wiped.push(profile)),
    } as Partial<Browsers> as Browsers;
    const services = {
      flows: yield* makeFlows,
      gmail: unreachable as Gmail,
      oauth: unreachable as OAuthClient,
      slack: unreachable as Slack,
      browsers,
    };
    const vault = makeVault({ store, ...services });
    /** A new vault process on the same state directory. */
    const restart = Effect.map(VaultStore.make(dir), (again) =>
      makeVault({ store: again, ...services }),
    );
    if (signedIn) {
      yield* vault.sheetOpen("olx.ua", "https://www.olx.ua/uk/account/");
      yield* vault.sheetClose("olx.ua", true);
    }
    /** Saves `secret` in the vault as the user's card would, then types it by reference. */
    const act = (
      action: PageAction,
      writes = true,
      more: Pick<Parameters<typeof vault.act>[0], "origins" | "signIn"> & {
        readonly secret?: TestSecret;
      } = {},
    ) =>
      Effect.gen(function* () {
        const { secret, ...rest } = more;
        if (secret !== undefined)
          yield* vault.loginSet({
            id: secret.name,
            site: secret.site,
            kind: secret.kind ?? "username",
            value: secret.value,
          });
        return yield* vault.act({
          site: "olx.ua",
          action,
          actor: "Research",
          writes,
          ...rest,
          ...(secret === undefined ? {} : { secret: { id: secret.name, name: secret.name } }),
        });
      });
    return { store, vault, restart, acted, wiped, landing, act };
  });
const vaultWithAccount = makeTestVault(true);

const typeMessage: PageAction = {
  action: "type",
  ref: "e1",
  text: "Is it still for sale?",
  submit: true,
};

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("Vault accounts", (it) => {
  it.effect("audits every write with the bot, the action and the text sent", () =>
    Effect.gen(function* () {
      const { store, act } = yield* vaultWithAccount;
      const page = yield* act(typeMessage);
      yield* act({ action: "click", ref: "e1" });
      assert.equal(page.snapshot.length, 12_000);
      assert.equal(page.nextOffset, 12_000);
      const audit = (yield* store.readAudit).filter((e) => e.actor === "Research");
      assert.deepEqual(
        audit.map((e) => [e.connection, e.op, e.status, e.detail]),
        [
          [
            "olx.ua",
            "type",
            "ok",
            '"Is it still for sale?" into "Message" + Enter · https://www.olx.ua/uk/chat/1',
          ],
          ["olx.ua", "click", "ok", '"Send" · https://www.olx.ua/uk/chat/1'],
        ],
      );
    }),
  );

  it.effect("a secret is typed into the page and audited by its name only", () =>
    Effect.gen(function* () {
      const { store, acted, landing, act } = yield* vaultWithAccount;
      const secret = { name: "olx-password", value: "hunter2-value", site: "olx.ua" };
      landing.url = `https://www.olx.ua/uk/chat/1?password=${secret.value}#${secret.value}`;
      landing.blocked = `https://evil.example/?p=${secret.value}`;
      yield* act({ ...typeMessage, text: "" }, true, { secret });
      const error = yield* Effect.flip(act({ action: "click", ref: "e1" }, true, { secret }));
      assert.match(error.message, /only typed/);
      assert.deepEqual(acted, [
        { ...typeMessage, text: secret.value, secret: { site: "olx.ua", kind: "username" } },
      ]);
      const audit = yield* store.readAudit;
      assert.deepInclude(
        audit.map((e) => [e.op, e.status, e.detail]),
        [
          "type",
          "ok",
          'secret "olx-password" into "Message" + Enter · https://www.olx.ua/uk/chat/1',
        ],
      );
      assert.notInclude(JSON.stringify(audit), secret.value);
    }),
  );

  it.effect("a kept password is typed once per half hour, a code once, a missing one never", () =>
    Effect.gen(function* () {
      const { store, vault: first, restart } = yield* vaultWithAccount;
      let vault = first;
      const type = (id: string) =>
        vault.act({
          site: "olx.ua",
          action: { ...typeMessage, text: "" },
          actor: "Research",
          writes: true,
          secret: { id, name: id },
        });
      yield* vault.loginSet({ id: "pw", site: "olx.ua", kind: "password", value: "hunter2-pw" });
      const signedInBefore = store.account("olx.ua")?.signedInAt;
      yield* TestClock.adjust("1 second");
      yield* type("pw");
      assert.notEqual(store.account("olx.ua")?.signedInAt, signedInBefore);
      const again = yield* Effect.flip(type("pw"));
      assert.match(again.message, /do not type it again: call request_login/);
      vault = yield* restart;
      assert.match((yield* Effect.flip(type("pw"))).message, /do not type it again/);
      yield* TestClock.adjust(PASSWORD_RETRY_MS);
      yield* type("pw");

      yield* vault.loginSet({ id: "code", site: "olx.ua", kind: "code", value: "481516" });
      yield* type("code");
      assert.match((yield* Effect.flip(type("code"))).message, /is gone/);
      assert.match((yield* Effect.flip(type("never-saved"))).message, /is gone/);
      yield* vault.loginRemove("pw");
      assert.match((yield* Effect.flip(type("pw"))).message, /is gone/);
    }),
  );

  it.effect(
    "signed in only after a page without a sign-in form; a refused password is marked",
    () =>
      Effect.gen(function* () {
        const { store, vault, landing, restart } = yield* makeTestVault(false);
        const act = (action: PageAction, id?: string) =>
          vault.act({
            site: "olx.ua",
            action,
            actor: "Research",
            writes: true,
            signIn: true,
            ...(id === undefined ? {} : { secret: { id, name: id } }),
          });
        const password: PageAction = { action: "type", ref: "e8", text: "", submit: true };
        yield* vault.loginSet({
          id: "wrong",
          site: "olx.ua",
          kind: "password",
          value: "wrong-pass",
        });
        landing.form = "password";
        yield* act(password, "wrong");
        assert.isNull(store.account("olx.ua")?.signedInAt);
        assert.isTrue((yield* vault.loginFailed("wrong")).failed);
        assert.isTrue((yield* (yield* restart).loginFailed("wrong")).failed);

        // A value saved before kinds existed is kept as a password even when it is a sign-in name.
        yield* vault.loginSet({ id: "legacy", site: "olx.ua", kind: "password", value: "me@x.ua" });
        landing.error = "type: Email is not a password field; the secret was not typed.";
        landing.wrongField = true;
        yield* Effect.flip(act({ action: "type", ref: "e7", text: "", submit: false }, "legacy"));
        assert.isTrue((yield* vault.loginFailed("legacy")).failed);
        landing.error = undefined;
        landing.wrongField = false;

        yield* vault.loginSet({
          id: "right",
          site: "olx.ua",
          kind: "password",
          value: "right-pass",
        });
        landing.form = "code";
        yield* act(password, "right");
        assert.isNull(store.account("olx.ua")?.signedInAt);
        assert.isFalse((yield* vault.loginFailed("right")).failed);
        landing.form = null;
        yield* act({ action: "click", ref: "e5" });
        assert.isNotNull(store.account("olx.ua")?.signedInAt);
      }),
  );

  it.effect("a bot holding a login uses the account before anyone signed in to it", () =>
    Effect.gen(function* () {
      const { store, act } = yield* makeTestVault(false);
      const open: PageAction = { action: "open", url: "https://www.olx.ua/uk/account/" };
      assert.match((yield* Effect.flip(act(open))).message, /not an account/);
      yield* act(open, true, { signIn: true });
      assert.deepInclude(store.account("olx.ua"), { signedInAt: null });
    }),
  );

  it.effect(
    "a typed secret never comes back to the bot, in any encoding, in any later action",
    () =>
      Effect.gen(function* () {
        const { landing, act } = yield* vaultWithAccount;
        const secret = { name: "olx-password", value: "pa ss&w0rd!'(*)~é", site: "olx.ua" };
        const forms = [
          secret.value,
          encodeURIComponent(secret.value),
          encodeURIComponent(secret.value).toLowerCase(),
          encodeURIComponent(secret.value).replace(/%20/g, "+"),
          secret.value.replace(/ /g, "+"),
          "pa%20ss%26w0rd%21%27%28%2A%29~%C3%A9",
          "pa+ss%26w0rd%21%27%28%2A%29%7E%C3%A9",
        ];
        const leaky = () => {
          landing.url = `https://www.olx.ua/login?password=${forms[1]}&again=${forms[3]}`;
          landing.title = `Hello ${forms[0]}`;
          landing.text = `# Sign in\n[e1 textbox "Password" = "${forms[0]}"]\n${forms.join("\n")}`;
          landing.blocked = `https://evil.example/?p=${forms[5]}`;
          landing.error = undefined;
        };
        leaky();
        const typed = yield* act({ ...typeMessage, text: "" }, true, { secret });
        const later = yield* act({ action: "snapshot" }, true);
        for (const page of [typed, later]) {
          const everything = JSON.stringify(page);
          for (const form of forms) assert.notInclude(everything, form);
          assert.include(page.snapshot, "[secret olx-password]");
        }
        landing.error = `The page said ${forms[2]} and ${forms[3]}`;
        const failed = yield* Effect.flip(act({ action: "snapshot" }, true));
        for (const form of forms) assert.notInclude(failed.message, form);
      }),
  );

  it.effect(
    "a typed secret is scrubbed when the page splits, recases, base64s or cuts it at a limit",
    () =>
      Effect.gen(function* () {
        const { landing, act } = yield* vaultWithAccount;
        const secret = { name: "olx-password", value: "Zebra-Pass-7782!", site: "olx.ua" };
        const bytes = Buffer.from(secret.value);
        const embedded = [0, 1, 2].map((offset) =>
          Buffer.concat([Buffer.alloc(offset, 65), bytes, Buffer.from("ZZZ")]).toString("base64"),
        );
        const cores = embedded.flatMap((form) => [
          form.slice(4, -4),
          form.slice(4, -4).replace(/\+/g, "-").replace(/\//g, "_"),
        ]);
        const direct = [
          bytes.toString("base64"),
          bytes.toString("base64url"),
          bytes.toString("base64").replace(/=+$/, ""),
        ];
        const variants = [
          "Zeb ra-Pa ss-7782!",
          "Zebra-\n   Pass-7782!",
          "zEBRA-pASS-7782!",
          "ZEBRA-PASS-7782!",
          ...direct,
        ];
        const leaky = () => {
          landing.url = "https://www.olx.ua/login";
          landing.title = "Chat";
          landing.text = [...variants, ...embedded.map((form) => `token=${form}&x=1`)].join("\n");
          landing.blocked = null;
          landing.error = undefined;
        };
        leaky();
        const page = yield* act({ ...typeMessage, text: "" }, true, { secret });
        const everything = JSON.stringify(page);
        for (const form of [...variants, ...cores]) assert.notInclude(everything, form);
        assert.notMatch(everything, /zebra[\s-]*pass/i);
        landing.text = `${"x".repeat(11_996)}${secret.value}`;
        landing.blocked = `https://evil.example/${"y".repeat(170)}${secret.value}`;
        const cut = yield* act({ action: "snapshot" }, true);
        assert.notInclude(JSON.stringify(cut), "Zebra");
        assert.notInclude(JSON.stringify(cut), "Zeb");
      }),
  );

  it.effect(
    "a typed secret is scrubbed when the page hides it behind invisible or encoded text",
    () =>
      Effect.gen(function* () {
        const { landing, act } = yield* vaultWithAccount;
        const secret = { name: "olx-password", value: "hunter2-Zebra", site: "olx.ua" };
        const between = (glue: string) => [...secret.value].join(glue);
        const escapes = (text: string) =>
          [...text]
            .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`)
            .join("");
        const entities = [...secret.value].map((char) => `&#x${char.charCodeAt(0).toString(16)};`);
        const evasions: Record<string, string> = {
          zeroWidthSpace: between("\u200b"),
          softHyphen: between("\u00ad"),
          wordJoiner: between("\u2060"),
          bidiMarks: `\u202e${between("\u200e")}\u202c`,
          byteOrderMark: between("\ufeff"),
          variationSelector: between("\ufe0f"),
          jsonEscapes: escapes(secret.value),
          jsonEscapesWithGlue: escapes(between("\u200b")),
          htmlEntities: entities.join(""),
          htmlDecimalEntities: [...secret.value].map((char) => `&#${char.charCodeAt(0)};`).join(""),
          percentEncodedWithGlue: between("%E2%80%8B"),
          fullwidth: [...secret.value]
            .map((char) =>
              char >= "!" && char <= "~" ? String.fromCharCode(char.charCodeAt(0) + 0xfee0) : char,
            )
            .join(""),
          twiceEncoded: encodeURIComponent(encodeURIComponent(secret.value)),
        };
        for (const [name, evasion] of Object.entries(evasions)) {
          landing.url = "https://www.olx.ua/login";
          landing.title = `Hello ${evasion}`;
          landing.text = `# Sign in\n${evasion}`;
          landing.blocked = null;
          landing.error = undefined;
          const page = yield* act({ ...typeMessage, text: "" }, true, { secret });
          const everything = JSON.stringify(page);
          assert.notMatch(everything, /hunter|zebra/i, name);
          assert.include(page.title, "[secret olx-password]", name);
        }
        const fancy = { name: "fancy", value: "ｐａｓｓ１２３４", site: "olx.ua" };
        landing.title = "Hello pass1234";
        landing.text = "pass1234";
        const page = yield* act({ ...typeMessage, text: "" }, true, { secret: fancy });
        assert.notInclude(JSON.stringify(page), "pass1234");
        landing.title = "Fish &amp; chips %20 caf\u00e9";
        landing.text = "nothing secret here";
        const plain = yield* act({ action: "snapshot" }, true);
        assert.equal(plain.title, "Fish &amp; chips %20 caf\u00e9");
      }),
  );

  it.effect("keeps actions on the account's site and the sites the user allowed", () =>
    Effect.gen(function* () {
      const { store, acted, landing, act } = yield* vaultWithAccount;
      for (const url of [
        "https://evil.example/collect",
        "https://olx.ua.evil.example/",
        "javascript:alert(1)",
        "https://login.olx-st.com/",
      ]) {
        const error = yield* Effect.flip(act({ action: "open", url }));
        assert.match(error.message, /not on olx.ua or a site the user allowed/);
      }
      yield* act({ action: "open", url: "https://m.olx.ua/uk/" });
      yield* act({ action: "open", url: "https://login.olx-st.com/" }, true, {
        origins: ["olx-st.com"],
      });
      assert.deepEqual(acted, [
        { action: "open", url: "https://m.olx.ua/uk/" },
        { action: "open", url: "https://login.olx-st.com/" },
      ]);

      landing.blocked = "https://evil.example/collect";
      const page = yield* act({ action: "click", ref: "e1" });
      assert.match(page.blocked ?? "", /Stopped a page or popup off olx.ua/);
      landing.blocked = null;
      landing.challenge = { vendor: "cloudflare", label: "Cloudflare check" };
      assert.deepEqual((yield* act({ action: "click", ref: "e1" })).challenge, landing.challenge);

      assert.deepEqual(
        (yield* store.readAudit).filter((e) => e.status === "refused").map((e) => [e.op, e.detail]),
        [
          ["open", "off allowlist: https://evil.example/collect"],
          ["open", "off allowlist: https://olx.ua.evil.example/"],
          ["open", "off allowlist: javascript:alert(1)"],
          ["open", "off allowlist: https://login.olx-st.com/"],
          ["navigate", "off allowlist: https://evil.example/collect"],
          ["check", "Cloudflare check · https://www.olx.ua/uk/chat/1"],
        ],
      );
    }),
  );

  it.effect("a read-only run follows links as page loads and refuses everything that acts", () =>
    Effect.gen(function* () {
      const { store, acted, act } = yield* vaultWithAccount;
      yield* act({ action: "click", ref: "e2" }, false);
      yield* act({ action: "scroll", direction: "down" }, false);
      for (const action of [
        typeMessage,
        { action: "click", ref: "e1" },
        { action: "press", key: "Enter" },
      ] satisfies ReadonlyArray<PageAction>) {
        const error = yield* Effect.flip(act(action, false));
        assert.match(error.message, /may only read olx.ua/);
      }
      assert.deepEqual(acted, [
        { action: "open", url: "https://www.olx.ua/uk/obyavlenie/1" },
        { action: "scroll", direction: "down" },
      ]);
      assert.deepEqual(
        (yield* store.readAudit).filter((e) => e.status === "refused").map((e) => e.op),
        ["type", "click", "press"],
      );
    }),
  );

  it.effect("sign-out and revoke end every action and delete the profile", () =>
    Effect.gen(function* () {
      const { vault, wiped, act } = yield* vaultWithAccount;
      yield* vault.signOut("olx.ua");
      assert.match((yield* Effect.flip(act(typeMessage))).message, /signed out of olx.ua/);
      yield* vault.sheetClose("olx.ua", true);
      yield* act(typeMessage);
      yield* vault.revoke("olx.ua");
      assert.match((yield* Effect.flip(act(typeMessage))).message, /olx.ua is not an account/);
      assert.deepEqual(wiped, ["olx.ua", "olx.ua"]);
      assert.deepEqual(
        (yield* vault.state).accounts.map((a) => a.site),
        [],
      );
    }),
  );
});

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("Vault read-only gate", (it) => {
  it.effect("refuses connector writes before any provider call and audits the refusal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const store = yield* VaultStore.make(
        yield* fs.makeTempDirectoryScoped({ prefix: "vault-test-" }),
      );
      const vault = makeVault({
        store,
        flows: yield* makeFlows,
        gmail: unreachable as Gmail,
        oauth: unreachable as OAuthClient,
        slack: unreachable as Slack,
        browsers: unreachable as Browsers,
      });
      for (const [kind, op] of [
        ["gmail", "mail_send"],
        ["slack", "chat.postMessage"],
      ] as const) {
        const error = yield* Effect.flip(Effect.asVoid(vault.op(kind, op, {}, "Inbox")));
        assert.match(error.message, /Only reads run in the vault/);
      }
      assert.match(
        (yield* Effect.flip(Effect.asVoid(vault.op("gmail", "mail_search", {}, "Inbox")))).message,
        /not connected/,
      );
      assert.deepEqual(
        (yield* store.readAudit).map((e) => [e.connection, e.op, e.status, e.actor]),
        [
          ["gmail", "mail_send", "refused", "Inbox"],
          ["slack", "chat.postMessage", "refused", "Inbox"],
          ["gmail", "mail_search", "refused", "Inbox"],
        ],
      );
    }),
  );
});

const SCOPES = `${GMAIL_MODIFY_SCOPE} ${GMAIL_COMPOSE_SCOPE}`;
const INBOX = ThreadId.make("inbox");
const POCHTA = ThreadId.make("pochta");

/**
 * A vault with the Gmail client pasted. Google is faked: code `c-<address>` signs in as that
 * address, refresh token `rt-<address>`, access token `at-<address>`. Gmail calls record the
 * access token they ran with; the draft's message id is `draftMessage`.
 */
const vaultWithGoogle = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "vault-test-" });
  yield* fs.writeFileString(
    `${dir}/config.json`,
    JSON.stringify({ redirectUri: "https://bots.example.net/api/connections/callback" }),
  );
  const store = yield* VaultStore.make(dir);
  yield* store.setSecret("gmail", "clientId", "client-id");
  yield* store.setSecret("gmail", "clientSecret", "client-secret");
  const searched: Array<string> = [];
  const sent: Array<string> = [];
  const revoked: Array<string> = [];
  const google = { draftMessage: "m1", scope: SCOPES };
  const oauth = {
    exchange: (_service: string, input: { code: string }) => {
      const address = input.code.slice(2);
      return Effect.succeed({
        access_token: `at-${address}`,
        expires_in: 3600,
        refresh_token: `rt-${address}`,
        scope: google.scope,
      });
    },
    refresh: () => Effect.die("refresh is not expected within the hour"),
    revoke: (_service: string, token: string) => Effect.sync(() => void revoked.push(token)),
  } as unknown as OAuthClient;
  const gmail = {
    profile: (token: string) => Effect.succeed(token.slice(3)),
    search: (token: string) => Effect.sync(() => (searched.push(token), [])),
    draft: (_token: string, draftId: string) =>
      Effect.succeed({
        draftId,
        messageId: google.draftMessage,
        to: "anna@example.com",
        cc: "",
        bcc: "",
        subject: "Hi",
      }),
    sendDraft: (token: string, draftId: string) =>
      Effect.sync(() => (sent.push(`${token}:${draftId}`), { id: "sent-1" })),
  } as Partial<Gmail> as Gmail;
  const vault = makeVault({
    store,
    flows: yield* makeFlows,
    gmail,
    oauth,
    slack: unreachable as Slack,
    browsers: unreachable as Browsers,
  });
  /** A link the bot minted, opened and consented to as `address`. */
  const connect = (botThreadId: ThreadId, address: string) =>
    Effect.gen(function* () {
      const { handle } = yield* vault.link({ service: "gmail", botThreadId, writes: true });
      const { authUrl } = yield* vault.linkOpen(handle);
      const state = new URL(authUrl).searchParams.get("state")!;
      return yield* vault.callback({ state, code: `c-${address}`, scope: google.scope });
    });
  const accountOf = (botThreadId: ThreadId, address: string) =>
    store.oauthAccounts().find((a) => a.botThreadId === botThreadId && a.address === address)!;
  return { store, vault, connect, accountOf, searched, sent, revoked, google };
});

it.layer(Layer.merge(NodeServices.layer, NodeCrypto.layer))("Vault bot accounts", (it) => {
  it.effect("a link opens once, asks for modify and compose, and binds the bot", () =>
    Effect.gen(function* () {
      const { vault } = yield* vaultWithGoogle;
      const { handle, origin } = yield* vault.link({
        service: "gmail",
        botThreadId: INBOX,
        writes: true,
      });
      assert.strictEqual(origin, "https://bots.example.net");
      assert.deepEqual(yield* vault.linkPeek(handle), { service: "gmail", botThreadId: INBOX });
      const { authUrl } = yield* vault.linkOpen(handle);
      const url = new URL(authUrl);
      assert.strictEqual(url.searchParams.get("scope"), SCOPES);
      assert.notInclude(authUrl, handle);
      assert.match((yield* Effect.flip(vault.linkOpen(handle))).message, /already used/);
      assert.match((yield* Effect.flip(vault.linkPeek(handle))).message, /already used/);
      const state = url.searchParams.get("state")!;
      const done = yield* vault.callback({ state, code: "c-home@example.com", scope: SCOPES });
      assert.deepInclude(done, { kind: "account", writes: true });
      assert.deepInclude((done as { account: object }).account, {
        botThreadId: INBOX,
        address: "home@example.com",
      });
      // The state is spent: a replayed redirect connects nothing.
      assert.match(
        (yield* Effect.flip(vault.callback({ state, code: "c-evil@example.com", scope: SCOPES })))
          .message,
        /expired or was already used/,
      );
    }),
  );

  // The server matches this text exactly to send bots other than Main to Main.
  it.effect("without the client, a link is refused with the shared missing-client text", () =>
    Effect.gen(function* () {
      const { store, vault } = yield* vaultWithGoogle;
      yield* store.removeSecret("gmail", "clientSecret");
      assert.strictEqual(
        (yield* Effect.flip(vault.link({ service: "gmail", botThreadId: INBOX, writes: true })))
          .message,
        oauthClientMissing("gmail"),
      );
    }),
  );

  it.effect("refuses a grant without every scope and revokes it", () =>
    Effect.gen(function* () {
      const { vault, connect, google, revoked } = yield* vaultWithGoogle;
      google.scope = GMAIL_MODIFY_SCOPE;
      assert.match(
        (yield* Effect.flip(connect(INBOX, "home@example.com"))).message,
        /Tick every box/,
      );
      assert.deepEqual(revoked, ["rt-home@example.com"]);
      assert.deepEqual((yield* vault.state).oauthAccounts, []);
    }),
  );

  it.effect("each call runs with its own account's token, and only for its bot", () =>
    Effect.gen(function* () {
      const { vault, connect, accountOf, searched } = yield* vaultWithGoogle;
      yield* connect(INBOX, "home@example.com");
      yield* connect(INBOX, "work@example.org");
      yield* connect(POCHTA, "dad@example.com");
      const run = (botThreadId: ThreadId, accountId: string) =>
        vault.accountOp({ accountId, botThreadId, op: "search", args: {}, actor: "Inbox" });
      yield* run(INBOX, accountOf(INBOX, "work@example.org").id);
      yield* run(INBOX, accountOf(INBOX, "home@example.com").id);
      assert.deepEqual(searched, ["at-work@example.org", "at-home@example.com"]);
      const error = yield* Effect.flip(
        Effect.asVoid(run(INBOX, accountOf(POCHTA, "dad@example.com").id)),
      );
      assert.match(error.message, /not connected to this bot/);
      assert.lengthOf(searched, 2);
    }),
  );

  it.effect("sends only the draft message the user saw", () =>
    Effect.gen(function* () {
      const { vault, connect, accountOf, sent, google } = yield* vaultWithGoogle;
      yield* connect(INBOX, "home@example.com");
      const send = (messageId: string) =>
        vault.accountOp({
          accountId: accountOf(INBOX, "home@example.com").id,
          botThreadId: INBOX,
          op: "send",
          args: { draftId: "r-1", messageId },
          actor: "user",
        });
      google.draftMessage = "m2";
      assert.match(
        (yield* Effect.flip(Effect.asVoid(send("m1")))).message,
        /changed after the user saw it/,
      );
      assert.deepEqual(sent, []);
      yield* send("m2");
      assert.deepEqual(sent, ["at-home@example.com:r-1"]);
    }),
  );

  it.effect("disconnect revokes and deletes the token, unless another bot shares the grant", () =>
    Effect.gen(function* () {
      const { store, vault, connect, accountOf, revoked } = yield* vaultWithGoogle;
      yield* connect(INBOX, "home@example.com");
      yield* connect(POCHTA, "home@example.com");
      yield* connect(INBOX, "work@example.org");
      const shared = accountOf(POCHTA, "home@example.com").id;
      yield* vault.accountDisconnect(shared);
      assert.deepEqual(revoked, []);
      const work = accountOf(INBOX, "work@example.org").id;
      yield* vault.accountDisconnect(work);
      assert.deepEqual(revoked, ["rt-work@example.org"]);
      assert.isTrue(Option.isNone(yield* store.getOAuthToken(work)));
      assert.isTrue(Option.isNone(yield* store.getOAuthToken(shared)));
      assert.deepEqual(
        store.oauthAccounts().map((a) => [a.botThreadId, a.address]),
        [[INBOX, "home@example.com"]],
      );
      const error = yield* Effect.flip(
        Effect.asVoid(
          vault.accountOp({
            accountId: work,
            botThreadId: INBOX,
            op: "search",
            args: {},
            actor: "Inbox",
          }),
        ),
      );
      assert.match(error.message, /not connected/);
    }),
  );
});

it("flags Slack scopes that can write", () => {
  assert.deepEqual(
    writeScopes([
      "channels:history",
      "users:read",
      "users:read.email",
      "identify",
      "chat:write",
      "im:write",
      "files:write",
    ]),
    ["chat:write", "im:write", "files:write"],
  );
});
