import 'dotenv/config';
import { getOperatingSystemAuditActor } from './adminAuditIdentity';
import { closeDatabasePools } from './db';
import {
  acknowledgeTelegramOutboxLoss,
  redriveTelegramOutboxEvent
} from './db/telegramOutbox';

const main = async () => {
  const [command, eventId, expectedEventKey, ...reasonParts] =
    process.argv.slice(2);
  if (command === 'redrive' && eventId) {
    const result = await redriveTelegramOutboxEvent(eventId);
    console.log(`Telegram outbox redrive: ${result}`);
    if (result !== 'queued') process.exitCode = 2;
    return;
  }
  if (
    command === 'acknowledge-loss' &&
    eventId &&
    expectedEventKey &&
    reasonParts.length > 0
  ) {
    const result = await acknowledgeTelegramOutboxLoss({
      eventId,
      expectedEventKey,
      acknowledgedBy: getOperatingSystemAuditActor(),
      reason: reasonParts.join(' ')
    });
    console.log(`Telegram outbox acknowledge-loss: ${result}`);
    if (result !== 'acknowledged') process.exitCode = 2;
    return;
  }
  throw new Error(
    'Usage: telegramOutboxAdmin redrive <event-id> | acknowledge-loss <event-id> <expected-event-key> <ticket/reason>'
  );
};

main()
  .catch((error) => {
    console.error(
      'Telegram outbox admin failed:',
      error instanceof Error ? error.message : 'unknown_error'
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabasePools().catch(() => undefined);
  });
