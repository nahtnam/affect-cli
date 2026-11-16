import { decrypt, encrypt, expand, keypair, parseSync, scan } from "@dotenvx/primitives";
import { Array, Effect, Record, Schema, String } from "effect";
import { CliError } from "effect/cli";

export const PrivateKey = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/u));
export const PublicKey = Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{66}$/u));

const Name = Schema.String.check(
  Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  Schema.makeFilter((name) => !name.startsWith("DOTENV_PRIVATE_KEY")),
);

const Values = Schema.Record(Schema.String, Schema.String);
const Pair = Schema.Struct({ privateKey: PrivateKey, publicKey: PublicKey });

const Scanned = Schema.Struct({
  parsed: Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({ quote: Schema.String, value: Schema.String })),
  ),
});

const Parsed = Schema.Struct({ errors: Schema.Array(Schema.Unknown), parsed: Values });

export interface EncryptedProfile {
  source: string;
  privateKey: string;
  publicKey: string;
}

const failure = () =>
  new CliError.UserError({ cause: "Cannot encrypt or recover the selected Affect profile." });

const profilePair = Effect.fnUntraced(function* profilePair(privateKey?: string) {
  if (privateKey !== undefined) {
    yield* Schema.decodeEffect(PrivateKey)(privateKey).pipe(Effect.mapError(failure));
  }

  const pair = yield* Effect.try({ catch: failure, try: () => keypair(privateKey) });

  const decoded = yield* Schema.decodeEffect(Pair)(pair).pipe(Effect.mapError(failure));

  return { privateKey: privateKey ?? decoded.privateKey, publicKey: decoded.publicKey };
});

export const profilePublicKey = Effect.fnUntraced(function* profilePublicKey(privateKey: string) {
  const pair = yield* profilePair(privateKey);

  return pair.publicKey;
});

export const encryptProfile = Effect.fnUntraced(function* encryptProfile(
  values: Readonly<Record<string, string>>,
  privateKey?: string,
) {
  const decoded = yield* Schema.decodeEffect(Values)(values).pipe(Effect.mapError(failure));
  yield* Schema.decodeEffect(
    Schema.Array(Name.check(Schema.makeFilter((name) => name !== "DOTENV_PUBLIC_KEY"))),
  )(Record.keys(decoded)).pipe(Effect.mapError(failure));
  const pair = yield* profilePair(privateKey);

  const assignments = yield* Effect.forEach(Record.toEntries(decoded), ([name, value]) =>
    Effect.try({ catch: failure, try: () => `${name}='${encrypt(pair.publicKey, value)}'` }),
  );

  return {
    ...pair,
    source: Array.join([`DOTENV_PUBLIC_KEY="${pair.publicKey}"`, ...assignments, ""], "\n"),
  } satisfies EncryptedProfile;
});

const resolveProfileValues = Effect.fnUntraced(function* resolveProfileValues(
  values: Record<string, string>,
  literalNames: ReadonlySet<string>,
  source: string,
  privateKey: string,
) {
  const references = /(?<!\\)\$\{(?<braced>[^{}]+)\}|(?<!\\)\$(?<plain>[A-Za-z_][A-Za-z0-9_]*)/gu;

  const SafeValue = Schema.String.check(
    Schema.makeFilter((value) => {
      if (value.includes("$(")) {
        return false;
      }

      for (const match of value.matchAll(references)) {
        const braced = match.groups?.["braced"];
        const plain = match.groups?.["plain"];
        const [name] = (braced ?? plain ?? "").split(/:\+|\+|:-|-/u);

        if (name === undefined || !Record.has(values, name)) {
          return false;
        }
      }

      return !/(?<!\\)\$\{/u.test(value.replace(references, ""));
    }),
  );

  for (const [name, value] of Record.toEntries(values)) {
    if (!literalNames.has(name)) {
      yield* Schema.decodeEffect(SafeValue)(value).pipe(Effect.mapError(failure));
    }
  }

  const literals: Record<string, string> = {};

  for (const name of literalNames) {
    literals[name] = values[name] ?? "";
  }

  const resolved: Record<string, string> = {};

  for (const [name, value] of Record.toEntries(values)) {
    if (literalNames.has(name)) {
      resolved[name] = value;
      continue;
    }

    const expanded = yield* Effect.try({
      catch: failure,
      try: () =>
        expand(value, {
          literals,
          overload: true,
          processEnv: {},
          runningParsed: resolved,
        }),
    });

    yield* Schema.decodeEffect(SafeValue)(expanded).pipe(Effect.mapError(failure));
    resolved[name] = expanded;
  }

  const native = yield* Effect.try({
    catch: failure,
    try: () =>
      parseSync(source, {
        fk: [],
        overload: true,
        processEnv: { DOTENV_PRIVATE_KEY: privateKey },
        provider: null,
      }),
  });

  const decoded = yield* Schema.decodeEffect(Parsed)(native).pipe(Effect.mapError(failure));

  if (decoded.errors.length !== 0) {
    return yield* failure();
  }

  const result: Record<string, string> = {};

  for (const name of Record.keys(values)) {
    const value = decoded.parsed[name];

    if (value === undefined) {
      return yield* failure();
    }

    result[name] = value;
  }

  return result;
});

export const decryptProfile = Effect.fnUntraced(function* decryptProfile(
  source: string,
  privateKey: string,
) {
  const expected = yield* profilePair(privateKey);

  const scanned = yield* Effect.try({
    catch: failure,
    try: () => scan(source, ({ quote, value }) => ({ quote, value })),
  });

  const { parsed } = yield* Schema.decodeEffect(Scanned)(scanned).pipe(Effect.mapError(failure));
  yield* Schema.decodeEffect(Schema.Array(Name))(Record.keys(parsed)).pipe(
    Effect.mapError(failure),
  );
  const publicValues = parsed["DOTENV_PUBLIC_KEY"];

  if (publicValues?.length !== 1 || publicValues[0]?.value !== expected.publicKey) {
    return yield* failure();
  }

  const values: Record<string, string> = {};
  const literalNames = new Set<string>();

  for (const [name, candidates] of Record.toEntries(parsed)) {
    if (name === "DOTENV_PUBLIC_KEY") {
      continue;
    }

    const [entry] = candidates;
    const value = entry?.value;

    if (entry?.quote === "'") {
      literalNames.add(name);
    }

    if (
      candidates.length !== 1 ||
      value === undefined ||
      (value !== "" && !String.startsWith("encrypted:")(value))
    ) {
      return yield* failure();
    }

    values[name] = yield* Effect.try({ catch: failure, try: () => decrypt(privateKey, value) });
  }

  return yield* resolveProfileValues(values, literalNames, source, privateKey);
});
