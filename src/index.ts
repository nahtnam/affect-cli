#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { ConfigProvider, Console, Effect, Layer, Logger } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { version } from "../package.json";
import { deploy } from "./deploy";
import { dotenvx } from "./dotenv";
import { exports } from "./environment";
import { run } from "./run";
import { setup } from "./setup";
import { syncDev } from "./sync-dev";
import { onboardHosted } from "./hosted";

const hostedFlags = () => ({
  configureHostBuild: Flag.Boolean("configure-host-build").pipe(Flag.withDefault(false)),
  createProject: Flag.String("create-project").pipe(Flag.withDefault("")),
  devDeployment: Flag.String("dev-deployment").pipe(Flag.withDefault("")),
  devOrigin: Flag.String("dev-origin").pipe(Flag.withDefault("")),
  nonInteractive: Flag.Boolean("non-interactive").pipe(Flag.withDefault(false)),
  prodDeployment: Flag.String("prod-deployment").pipe(Flag.withDefault("")),
  profiles: Flag.String("profiles").pipe(Flag.withDefault("")),
  project: Flag.String("project").pipe(Flag.withDefault("")),
  siteUrl: Flag.String("site-url").pipe(Flag.withDefault("")),
  team: Flag.String("team").pipe(Flag.withDefault("")),
  values: Flag.String("values").pipe(Flag.withDefault("")),
  vercelAccount: Flag.String("vercel-account").pipe(Flag.withDefault("")),
  vercelProject: Flag.String("vercel-project").pipe(Flag.withDefault("")),
  vercelTeam: Flag.String("vercel-team").pipe(Flag.withDefault("")),
});

const hostedRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
      ),
    ),
  );

const program = Command.make("affect").pipe(
  Command.withDescription("Environment and native deployment commands for Affect applications."),
  Command.withSubcommands([
    Command.make("env", {}, () => exports().pipe(Effect.flatMap(Console.log))).pipe(
      Command.withDescription("Print shell exports for the selected encrypted environment."),
      Command.withSubcommands([
        Command.make("init", hostedFlags(), (options) =>
          hostedRuntime(onboardHosted({ ...options, recoverOnly: false })),
        ).pipe(
          Command.withDescription(
            "Configure selected hosted environments with recoverable keys; preserve existing credentials and settings.",
          ),
        ),
        Command.make("restore", hostedFlags(), (options) =>
          hostedRuntime(onboardHosted({ ...options, recoverOnly: true })),
        ).pipe(
          Command.withDescription(
            "Restore selected encrypted profiles and keys from their verified existing Convex recovery records.",
          ),
        ),
        Command.make(
          "sync-dev",
          { force: Flag.Boolean("force").pipe(Flag.withDefault(false)) },
          ({ force }) => syncDev(force),
        ).pipe(
          Command.withDescription(
            "Sync declared server settings to the verified hosted development backend; --force overwrites conflicts. No deployment.",
          ),
        ),
      ]),
    ),
    Command.make(
      "run",
      {
        command: Argument.String("command"),
        params: Argument.String("args").pipe(Argument.variadic()),
      },
      ({ command, params }) => run(command, params),
    ).pipe(Command.withDescription("Run a command with the selected encrypted environment.")),
    Command.make(
      "dotenvx",
      { args: Argument.String("args").pipe(Argument.variadic()) },
      ({ args }) => dotenvx(args, false),
    ).pipe(Command.withDescription("Run the bundled dotenvx CLI; pass its flags after --.")),
    Command.make("setup", {}, setup).pipe(
      Command.withDescription("Initialize or retry an anonymous local Convex backend."),
    ),
    Command.make(
      "deploy",
      { build: Flag.Boolean("build").pipe(Flag.withDefault(false)) },
      ({ build }) => deploy(build),
    ).pipe(
      Command.withDescription(
        "Run native Convex deploy and the TanStack build for the selected Vercel target; does not publish frontend output. --build is the internal callback.",
      ),
    ),
  ]),
  Command.run({ version }),
  Effect.provide(BunServices.layer),
  Effect.provideService(Logger.LogToStderr, true),
);

BunRuntime.runMain(program);
