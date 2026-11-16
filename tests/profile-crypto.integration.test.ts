import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "@dotenvx/dotenvx";
import { encrypt, keypair } from "@dotenvx/primitives";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptProfile, encryptProfile } from "../src/profile-crypto";

const failure = "Cannot encrypt or recover the selected Affect profile.";
const active: string[] = [];

const legacyProfile = (values: Record<string, string>) => {
  const pair = keypair();

  const assignments = Object.entries(values).map(
    ([name, value]) => `${name}="${encrypt(pair.publicKey, value)}"`,
  );

  return {
    ...pair,
    source: [`DOTENV_PUBLIC_KEY="${pair.publicKey}"`, ...assignments, ""].join("\n"),
  };
};

describe("profile recovery follows isolated native dotenvx expansion", () => {
  afterEach(async () => {
    vi.unstubAllEnvs();
    const cleanups: Promise<void>[] = [];

    for (const directory of active.splice(0)) {
      cleanups.push(rm(directory, { force: true, recursive: true }));
    }

    await Promise.all(cleanups);
  });

  it("matches normal native activation for references between encrypted profile values", async () => {
    vi.stubEnv("DOMAIN", "ambient.example");

    const encrypted = legacyProfile({
      DOMAIN: "synthetic.example",
      SITE_URL: `https://\${DOMAIN}`,
      TRUSTED_ORIGINS: `\${SITE_URL},https://secondary.\${DOMAIN}`,
      UNBRACED_ORIGIN: "https://$DOMAIN",
    });

    const activated = parse(encrypted.source, {
      overload: true,
      privateKey: encrypted.privateKey,
      processEnv: {},
    });

    const recovered = await Effect.runPromise(
      decryptProfile(encrypted.source, encrypted.privateKey),
    );

    expect(recovered).toStrictEqual({
      DOMAIN: activated["DOMAIN"],
      SITE_URL: activated["SITE_URL"],
      TRUSTED_ORIGINS: activated["TRUSTED_ORIGINS"],
      UNBRACED_ORIGIN: activated["UNBRACED_ORIGIN"],
    });
    expect(recovered["SITE_URL"]).toBe("https://synthetic.example");
    expect(recovered["TRUSTED_ORIGINS"]).toBe(
      "https://synthetic.example,https://secondary.synthetic.example",
    );
  });

  it.each([
    `\${DOTENV_PRIVATE_KEY}`,
    `\${AFFECT_CONVEX_TOKEN}`,
    "$DOTENV_PRIVATE_KEY",
    "$AFFECT_CONVEX_TOKEN",
    `https://\${DOMAIN}`,
    "$(printf synthetic-command-secret)",
  ])(
    "rejects an external reference or command without importing ambient authority",
    async (value) => {
      const ambient = "synthetic-ambient-bootstrap-secret";
      vi.stubEnv("AFFECT_CONVEX_TOKEN", ambient);
      vi.stubEnv("DOMAIN", "ambient.example");
      const encrypted = legacyProfile({ SERVER_SETTING: value });

      const error = await Effect.runPromise(
        decryptProfile(encrypted.source, encrypted.privateKey).pipe(Effect.flip),
      );

      expect(error.cause).toBe(failure);
      expect(String(error)).not.toContain(ambient);
      expect(String(error)).not.toContain(encrypted.privateKey);
      expect(String(error)).not.toContain(value);
    },
  );

  it("preserves literal settings during recovery and native activation without executing command-looking values", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "affect-profile-literals-"));
    active.push(directory);
    const marker = path.join(directory, "must-not-exist");
    vi.stubEnv("AFFECT_CONVEX_TOKEN", "synthetic-ambient-bootstrap-secret");

    const values = {
      BACKSLASHES: "one\\two\\three",
      COMMAND_LITERAL: `$(touch ${marker})`,
      EXPRESSION_LITERAL: `\${AFFECT_CONVEX_TOKEN}`,
      NEWLINES: "first line\nsecond line",
      QUOTES: "one 'single' and \"double\" quote",
      TOKEN_LITERAL: "$AFFECT_CONVEX_TOKEN",
    };

    const encrypted = await Effect.runPromise(encryptProfile(values));

    const recovered = await Effect.runPromise(
      decryptProfile(encrypted.source, encrypted.privateKey),
    );

    const activated = parse(encrypted.source, {
      overload: true,
      privateKey: encrypted.privateKey,
      processEnv: {},
    });

    expect(recovered).toStrictEqual(values);
    expect(activated).toMatchObject(values);
    expect(JSON.stringify(recovered)).not.toContain(encrypted.privateKey);
    await expect(lstat(marker)).rejects.toThrow("ENOENT");
  });

  it.each(["duplicate", "malformed", "plaintext"])(
    "rejects %s encrypted values with a fixed safe error",
    async (kind) => {
      const secret = "synthetic-never-echo-profile-secret";
      const encrypted = await Effect.runPromise(encryptProfile({ SERVER_SECRET: secret }));
      let source = `${encrypted.source}SERVER_SECRET="encrypted:malformed-${secret}"\n`;

      if (kind === "malformed") {
        source = `DOTENV_PUBLIC_KEY="${encrypted.publicKey}"\nSERVER_SECRET="encrypted:malformed-${secret}"\n`;
      } else if (kind === "plaintext") {
        source = `DOTENV_PUBLIC_KEY="${encrypted.publicKey}"\nSERVER_SECRET="${secret}"\n`;
      }

      const error = await Effect.runPromise(
        decryptProfile(source, encrypted.privateKey).pipe(Effect.flip),
      );

      expect(error.cause).toBe(failure);
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(encrypted.privateKey);
    },
  );
});
