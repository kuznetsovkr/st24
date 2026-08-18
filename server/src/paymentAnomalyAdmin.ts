import 'dotenv/config';
import { getOperatingSystemAuditActor } from './adminAuditIdentity';
import { closeDatabasePools } from './db';
import {
  resolveOrderPaymentAnomaly,
  resolveProviderPaymentAnomaly
} from './db/paymentAnomalies';

const main = async () => {
  const [command, entityId, expectedCode, ...reasonParts] =
    process.argv.slice(2);
  if (!entityId || !expectedCode || reasonParts.length === 0) {
    throw new Error(
      'Usage: paymentAnomalyAdmin resolve-order|resolve-provider <id> <expected-code> <ticket/reason>'
    );
  }
  const common = {
    expectedCode,
    resolvedBy: getOperatingSystemAuditActor(),
    reason: reasonParts.join(' ')
  };
  const result =
    command === 'resolve-order'
      ? await resolveOrderPaymentAnomaly({ ...common, orderId: entityId })
      : command === 'resolve-provider'
        ? await resolveProviderPaymentAnomaly({
            ...common,
            anomalyId: entityId
          })
        : null;
  if (result === null) {
    throw new Error(
      'Usage: paymentAnomalyAdmin resolve-order|resolve-provider <id> <expected-code> <ticket/reason>'
    );
  }
  console.log(`Payment anomaly resolution: ${result}`);
  if (result !== 'resolved') process.exitCode = 2;
};

main()
  .catch((error) => {
    console.error(
      'Payment anomaly admin failed:',
      error instanceof Error ? error.message : 'unknown_error'
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePools().catch(() => undefined);
  });
