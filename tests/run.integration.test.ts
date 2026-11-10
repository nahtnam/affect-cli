import { afterEach, describe, expect, it } from "vitest";

import { fixtureEnv, makeFixture, runCli } from "./cli-test-helpers";
import type { Fixture } from "./cli-test-helpers";

const active: Fixture[] = [];

const fixture = async (options?: Parameters<typeof makeFixture>[0]) => {
  const value = await makeFixture(options);
  active.push(value);

  return value;
};

describe("affect run", () => {
  afterEach(async () => {
    await Promise.all(
      active.splice(0).map(async (value) => {
        await value.cleanup();
      }),
    );
  });

  it.each([
    ["development", {}, "development"],
    ["development", { CI: "false" }, "development"],
    ["ci", { CI: "true" }, "ci"],
    ["preview", { VERCEL_ENV: "preview" }, "preview"],
    ["production", { CI: "true", VERCEL_ENV: "production" }, "production"],
  ])("loads the selected %s environment", async (environment, overrides, selected) => {
    const f = await fixture({ environment, values: { AFFECT_SELECTED: selected } });

    const result = runCli(
      f,
      ["run", "--", "node", "-e", "process.stdout.write(process.env.AFFECT_SELECTED ?? '')"],
      { ...fixtureEnv(f), ...overrides },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(selected);
  });

  it("preserves inherited values over encrypted values", async () => {
    const f = await fixture({
      values: { AFFECT_VALUE: "secret-value", VITE_CONVEX_URL: "encrypted-url" },
    });

    const result = runCli(
      f,
      [
        "run",
        "--",
        "node",
        "-e",
        "process.stdout.write(process.env.VITE_CONVEX_URL + '|' + process.env.AFFECT_VALUE)",
      ],
      { ...fixtureEnv(f), VITE_CONVEX_URL: "inherited-url" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("inherited-url|secret-value");
  });

  it("passes arguments containing spaces and quotes without shell interpretation", async () => {
    const f = await fixture({ values: { AFFECT_VALUE: "loaded" } });
    const argument = "space value 'and' \"quotes\"";

    const result = runCli(
      f,
      ["run", "--", "node", "-e", "process.stdout.write(process.argv[1])", argument],
      fixtureEnv(f),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(argument);
  });

  it("runs without credentials when no encrypted project file exists", async () => {
    const f = await fixture();

    const result = runCli(f, ["run", "--", "node", "-e", "process.stdout.write('ok')"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  it("rejects a key when the selected encrypted project file is missing", async () => {
    const f = await fixture();

    const result = runCli(f, ["run", "--", "node", "-e", "process.stdout.write('child-started')"], {
      DOTENV_PRIVATE_KEY: "synthetic-unused-key",
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/Missing encrypted project file/u);
    expect(result.stderr).not.toContain("child-started");
  });

  it("fails before spawning a child when decryption fails", async () => {
    const f = await fixture({ values: { AFFECT_SECRET: "secret-fixture" } });

    const result = runCli(f, ["run", "--", "node", "-e", "process.stdout.write('child-started')"], {
      DOTENV_PRIVATE_KEY: "0".repeat(64),
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-fixture");
  });

  it("reports a nonzero child exit", async () => {
    const f = await fixture({ values: { AFFECT_VALUE: "loaded" } });

    const result = runCli(f, ["run", "--", "node", "-e", "process.exitCode = 7"], fixtureEnv(f));

    expect(result.status).toBe(7);
    expect(result.stderr).toBe("");
  });
});
