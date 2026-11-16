import { Effect, FileSystem, Path, Schema } from "effect";
import { CliError } from "effect/cli";

import { encryptProfile } from "./profile-crypto";

const failure = (cause: string) => new CliError.UserError({ cause });

const HttpOrigin = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) =>
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "",
  ),
);

export const previewOrigin = Effect.fnUntraced(function* previewOrigin(
  inherited: Record<string, string>,
) {
  const explicit = inherited["AFFECT_PREVIEW_ORIGIN"] ?? "";
  const host = inherited["VERCEL_URL"] ?? "";

  if (explicit === "" && host === "") {
    return yield* failure("Preview deploy requires AFFECT_PREVIEW_ORIGIN or VERCEL_URL.");
  }

  const origin = yield* Schema.decodeEffect(HttpOrigin)(
    explicit || (host.includes("://") ? host : `https://${host}`),
  ).pipe(Effect.mapError(() => failure("Preview frontend URL must be an HTTP(S) origin.")));

  return origin.origin;
});

export const previewValues = (values: Record<string, string>, origin: string) => {
  const result = { ...values };
  result["SITE_URL"] = origin;
  result["TRUSTED_ORIGINS"] = origin;
  result["VITE_SITE_URL"] = origin;

  return result;
};

export const materializePreviewProfile = Effect.fn("Preview.materializeProfile")(
  function* materializePreviewProfile(
    root: string,
    values: Readonly<Record<string, string>>,
    privateKey: string,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(root, "env", "preview", ".env");
    const lock = path.join(root, "env", "preview", ".affect-deploy");
    const original = path.join(lock, "original.env");
    const runtime = path.join(lock, "runtime.env");
    const { source } = yield* encryptProfile(values, privateKey);

    yield* Effect.acquireRelease(
      fs
        .makeDirectory(lock)
        .pipe(Effect.mapError(() => failure("Cannot lock the preview profile for deployment."))),
      () =>
        Effect.gen(function* releasePreviewLock() {
          if (!(yield* fs.exists(original))) {
            yield* fs.remove(lock, { recursive: true });
          }
        }).pipe(
          Effect.mapError(() => failure("Cannot remove the preview profile deployment lock.")),
          Effect.orDie,
        ),
    );

    yield* Effect.acquireRelease(Effect.succeed(runtime), () =>
      fs.remove(runtime, { force: true }).pipe(
        Effect.mapError(() => failure("Cannot remove the encrypted preview runtime staging file.")),
        Effect.orDie,
      ),
    );

    yield* fs
      .writeFileString(runtime, source, { flag: "wx", mode: 0o600 })
      .pipe(
        Effect.mapError(() => failure("Cannot prepare the encrypted preview runtime profile.")),
      );

    yield* Effect.acquireRelease(
      fs
        .rename(file, original)
        .pipe(Effect.mapError(() => failure("Cannot preserve the original preview profile."))),
      () =>
        Effect.gen(function* restorePreviewProfile() {
          if (yield* fs.exists(file)) {
            const current = yield* fs.readFileString(file);

            if (current !== source) {
              return yield* failure(
                "Preview profile changed during deployment; preserved the original in .affect-deploy/original.env.",
              );
            }
          }

          yield* fs.rename(original, file);

          return yield* Effect.void;
        }).pipe(
          Effect.mapError(() =>
            failure(
              "Cannot restore the preview profile; preserved the original in .affect-deploy/original.env.",
            ),
          ),
          Effect.orDie,
        ),
    );

    yield* fs
      .rename(runtime, file)
      .pipe(
        Effect.mapError(() => failure("Cannot install the encrypted preview runtime profile.")),
      );
  },
);
