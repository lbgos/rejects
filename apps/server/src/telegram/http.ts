import { TELEGRAM_ENDPOINTS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { route } from "../bots/http.ts";
import * as Telegram from "./Telegram.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const telegram = yield* Telegram.Telegram;
    return Layer.mergeAll(
      route(TELEGRAM_ENDPOINTS.state, () => telegram.state),
      route(TELEGRAM_ENDPOINTS.connect, ({ token }) => telegram.connect(token)),
      route(TELEGRAM_ENDPOINTS.code, () => telegram.newCode),
      route(TELEGRAM_ENDPOINTS.settings, telegram.configure),
      route(TELEGRAM_ENDPOINTS.disconnect, () => telegram.disconnect),
    );
  }),
);
