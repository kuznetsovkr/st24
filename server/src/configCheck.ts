#!/usr/bin/env node
import 'dotenv/config';
import {
  assertSupportedNodeVersion,
  validateServerStartupConfig
} from './startupConfig';

type Environment = Record<string, string | undefined>;
type ConfigCheckWriter = { write: (value: string) => unknown };

const SENSITIVE_ENVIRONMENT_NAME =
  /(?:SECRET|TOKEN|PASSWORD|PASS|KEY|API_ID|DATABASE_URL|PROXY_URL|SHOP_ID|CHAT_ID|PHONE)/i;

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const formatConfigCheckError = (
  error: unknown,
  environment: Environment = process.env
): string => {
  let message = error instanceof Error ? error.message : 'unknown configuration error';
  const sensitiveValues = Object.entries(environment)
    .filter(([name, value]) => SENSITIVE_ENVIRONMENT_NAME.test(name) && Boolean(value))
    .flatMap(([, value]) => {
      const raw = value ?? '';
      return [raw, encodeURIComponent(raw)];
    })
    .filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
    .sort((left, right) => right.length - left.length);

  for (const value of sensitiveValues) {
    message = message.replace(new RegExp(escapeRegExp(value), 'g'), '[redacted]');
  }
  const singleLine = message.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 500);
  return singleLine || 'unknown configuration error';
};

export const runBackendConfigCheck = (
  environment: Environment = process.env,
  output: ConfigCheckWriter = process.stdout,
  errorOutput: ConfigCheckWriter = process.stderr,
  options: { nodeVersion?: string } = {}
): number => {
  try {
    assertSupportedNodeVersion(options.nodeVersion);
    validateServerStartupConfig(environment);
    output.write('Backend configuration is valid.\n');
    return 0;
  } catch (error) {
    errorOutput.write(`Backend configuration is invalid: ${formatConfigCheckError(error, environment)}\n`);
    return 1;
  }
};

if (require.main === module) {
  process.exitCode = runBackendConfigCheck();
}
