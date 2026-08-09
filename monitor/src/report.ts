import type { CheckResult } from './types';
import type { StateTransition } from './state';

const icon = (status: CheckResult['status']): string => {
  if (status === 'ok') {
    return '🟢';
  }
  if (status === 'warning') {
    return '🟡';
  }
  return '🔴';
};

const latency = (result: CheckResult): string =>
  result.latencyMs === undefined ? '' : ` · ${result.latencyMs} ms`;

export const formatCheck = (result: CheckResult): string =>
  `${icon(result.status)} ${result.label}${latency(result)} — ${result.detail}`;

export const renderConsoleReport = (results: CheckResult[]): string =>
  results.map(formatCheck).join('\n');

export const renderSummaryReport = (results: CheckResult[]): string => {
  const failed = results.filter((result) => result.status === 'failed').length;
  const warnings = results.filter((result) => result.status === 'warning').length;
  const headline = failed > 0 ? '🔴 HER monitor summary' : warnings > 0 ? '🟡 HER monitor summary' : '🟢 HER monitor summary';
  return `${headline}\n${results.map(formatCheck).join('\n')}\nChecked: ${new Date().toISOString()}`;
};

export const renderTransitionReport = (transitions: StateTransition[]): string => {
  const lines = transitions.map(({ type, result }) => {
    if (type === 'failure') {
      const problemIcon = result.status === 'warning' ? '🟡' : '🔴';
      const problemLabel = result.status === 'warning' ? 'WARNING' : 'FAIL';
      return `${problemIcon} ${problemLabel}: ${result.label}${latency(result)} — ${result.detail}`;
    }
    return `🟢 RECOVERY: ${result.label}${latency(result)} — ${result.detail}`;
  });
  return `HER monitor state changed\n${lines.join('\n')}\nChecked: ${new Date().toISOString()}`;
};
