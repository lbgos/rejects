import * as Context from "effect/Context";
import type * as FileSystem from "effect/FileSystem";
import type { HttpClient, HttpRouter } from "effect/http";
import type * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import type * as BotNotifications from "./bots/BotNotifications.ts";
import type * as BotStore from "./bots/BotStore.ts";
import type * as ServerConfig from "./config.ts";
import type * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import type * as ServerSettings from "./serverSettings.ts";

type PolicyServices =
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig.ServerConfig
  | ServerSettings.ServerSettingsService;

type RouteServices =
  | PolicyServices
  | HttpRouter.HttpRouter
  | HttpClient.HttpClient
  // Route handlers authenticate per request.
  | HttpRouter.Request<"Requires", EnvironmentAuth.EnvironmentAuth>
  | BotNotifications.BotNotifications
  | BotStore.BotStore
  | ThreadManagement.ThreadManagementService;

/**
 * What a deployment's own entry adds to the server: `main(extension)` in `main.ts`.
 * `policy` provides `CallPolicy` in place of `CallPolicy.layerDefault`; `routes` adds HTTP routes
 * and background work.
 */
export interface ServerExtension {
  readonly policy?: Layer.Layer<never, never, PolicyServices>;
  readonly routes?: Layer.Layer<never, never, RouteServices>;
}

export const ServerExtension = Context.Reference<ServerExtension>("t3/ServerExtension", {
  defaultValue: () => ({}),
});
