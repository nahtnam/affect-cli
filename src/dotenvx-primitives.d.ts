declare module "@dotenvx/primitives" {
  export function keypair(privateKey?: string): { privateKey: string; publicKey: string };
  export function encrypt(publicKey: string, value: string): string;
  export function decrypt(privateKey: string, value: string): string;
  export function scan(source: string): { parsed: Record<string, string[]> };
  export function scan<A>(
    source: string,
    transform: (assignment: { name: string; quote: string; value: string }) => A,
  ): { parsed: Record<string, A[]> };
  export function parseSync(
    source: string,
    options: {
      fk: string[];
      overload: boolean;
      processEnv: Record<string, string>;
      provider: null;
    },
  ): { parsed: Record<string, string>; errors: unknown[] };
  export function expand(
    value: string,
    options: {
      literals: Record<string, string>;
      overload: boolean;
      processEnv: Record<string, string>;
      runningParsed: Record<string, string>;
    },
  ): string;
}
