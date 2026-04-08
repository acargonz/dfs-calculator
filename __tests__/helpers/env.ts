/**
 * `process.env.NODE_ENV` is typed `readonly` in newer @types/node so a
 * direct assignment errors under TS strict mode. The cast widens the
 * type so tests can flip the env between 'development' / 'production' /
 * 'test' freely.
 */
export function setNodeEnv(value: 'development' | 'production' | 'test'): void {
  (process.env as Record<string, string | undefined>).NODE_ENV = value;
}
