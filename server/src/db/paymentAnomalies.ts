import { query, withClient } from '../db';

const SAFE_VALUE_PATTERN = /^[A-Za-z0-9._:-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const assertSafeValue = (value: string, field: string, maximum: number) => {
  if (
    value.length < 1 ||
    value.length > maximum ||
    !SAFE_VALUE_PATTERN.test(value)
  ) {
    throw new Error(`Invalid ${field}`);
  }
};

const assertOptionalUuid = (value: string | null, field: string) => {
  if (value !== null && !UUID_PATTERN.test(value)) {
    throw new Error(`Invalid ${field}`);
  }
};

export type PaymentAnomalyCode =
  | 'orphan_succeeded_payment'
  | 'payment_order_association_conflict';

type PaymentAnomalyIdentity = {
  anomalyCode: PaymentAnomalyCode;
  metadataOrderId: string | null;
  linkedOrderId: string | null;
};

export const isPaymentAnomalyMateriallyChanged = (
  existing: PaymentAnomalyIdentity,
  incoming: PaymentAnomalyIdentity
) =>
  existing.anomalyCode !== incoming.anomalyCode ||
  (incoming.metadataOrderId !== null &&
    existing.metadataOrderId !== incoming.metadataOrderId) ||
  (incoming.linkedOrderId !== null &&
    existing.linkedOrderId !== incoming.linkedOrderId);

export const recordPaymentAnomaly = async (input: {
  provider: 'yookassa';
  paymentId: string;
  anomalyCode: PaymentAnomalyCode;
  paymentStatus: string;
  amountCents: number | null;
  metadataOrderId?: string | null;
  linkedOrderId?: string | null;
}): Promise<boolean> => {
  assertSafeValue(input.paymentId, 'paymentId', 128);
  assertSafeValue(input.paymentStatus, 'paymentStatus', 64);
  if (
    input.amountCents !== null &&
    (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0)
  ) {
    throw new Error('Invalid amountCents');
  }
  const metadataOrderId = input.metadataOrderId ?? null;
  const linkedOrderId = input.linkedOrderId ?? null;
  assertOptionalUuid(metadataOrderId, 'metadataOrderId');
  assertOptionalUuid(linkedOrderId, 'linkedOrderId');
  const result = await query(
    `
      INSERT INTO payment_anomalies (
        provider,
        external_payment_id,
        anomaly_code,
        payment_status,
        amount_cents,
        metadata_order_id,
        linked_order_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (provider, external_payment_id) DO UPDATE
      SET anomaly_code = EXCLUDED.anomaly_code,
          payment_status = EXCLUDED.payment_status,
          amount_cents = EXCLUDED.amount_cents,
          metadata_order_id =
            COALESCE(EXCLUDED.metadata_order_id, payment_anomalies.metadata_order_id),
          linked_order_id =
            COALESCE(EXCLUDED.linked_order_id, payment_anomalies.linked_order_id),
          resolved_at = CASE
            WHEN payment_anomalies.anomaly_code IS DISTINCT FROM EXCLUDED.anomaly_code
              OR (
                EXCLUDED.metadata_order_id IS NOT NULL
                AND payment_anomalies.metadata_order_id
                  IS DISTINCT FROM EXCLUDED.metadata_order_id
              )
              OR (
                EXCLUDED.linked_order_id IS NOT NULL
                AND payment_anomalies.linked_order_id
                  IS DISTINCT FROM EXCLUDED.linked_order_id
              )
            THEN NULL
            ELSE payment_anomalies.resolved_at
          END,
          last_seen_at = NOW(),
          seen_count = payment_anomalies.seen_count + 1,
          updated_at = NOW()
      RETURNING id;
    `,
    [
      input.provider,
      input.paymentId,
      input.anomalyCode,
      input.paymentStatus,
      input.amountCents,
      metadataOrderId,
      linkedOrderId
    ]
  );
  return (result.rowCount ?? 0) > 0;
};

export const recordOrphanPaymentAnomaly = async (
  input: Omit<
    Parameters<typeof recordPaymentAnomaly>[0],
    'anomalyCode' | 'linkedOrderId'
  >
) =>
  recordPaymentAnomaly({
    ...input,
    anomalyCode: 'orphan_succeeded_payment'
  });

export type PaymentAnomalyResolutionResult =
  | 'resolved'
  | 'not_found'
  | 'no_active_anomaly'
  | 'already_resolved'
  | 'code_mismatch';

const normalizeAuditText = (
  value: string,
  field: string,
  minimum: number,
  maximum: number
) => {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (
    normalized.length < minimum ||
    normalized.length > maximum ||
    hasControlCharacter
  ) {
    throw new Error(`Invalid ${field}`);
  }
  return normalized;
};

const normalizeResolutionInput = (input: {
  expectedCode: string;
  resolvedBy: string;
  reason: string;
}) => ({
  expectedCode: normalizeAuditText(
    input.expectedCode,
    'expectedCode',
    1,
    128
  ),
  resolvedBy: normalizeAuditText(input.resolvedBy, 'resolvedBy', 1, 256),
  reason: normalizeAuditText(input.reason, 'reason', 10, 1_000)
});

export const resolveOrderPaymentAnomaly = async (input: {
  orderId: string;
  expectedCode: string;
  resolvedBy: string;
  reason: string;
}): Promise<PaymentAnomalyResolutionResult> => {
  assertOptionalUuid(input.orderId, 'orderId');
  const audit = normalizeResolutionInput(input);
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `
          SELECT payment_anomaly_code, payment_id
          FROM orders
          WHERE id = $1
          FOR UPDATE;
        `,
        [input.orderId]
      );
      const order = result.rows[0] as
        | { payment_anomaly_code: string | null; payment_id: string | null }
        | undefined;
      if (!order) {
        await client.query('COMMIT');
        return 'not_found';
      }
      if (!order.payment_anomaly_code) {
        await client.query('COMMIT');
        return 'no_active_anomaly';
      }
      if (order.payment_anomaly_code !== audit.expectedCode) {
        await client.query('COMMIT');
        return 'code_mismatch';
      }
      await client.query(
        `
          INSERT INTO payment_anomaly_resolutions (
            scope,
            order_id,
            original_anomaly_code,
            external_payment_id,
            resolved_by,
            source,
            reason
          )
          VALUES ('order', $1, $2, $3, $4, 'cli', $5);
        `,
        [
          input.orderId,
          order.payment_anomaly_code,
          order.payment_id,
          audit.resolvedBy,
          audit.reason
        ]
      );
      await client.query(
        `
          UPDATE orders
          SET payment_anomaly_code = NULL,
              payment_anomaly_at = NULL,
              updated_at = NOW()
          WHERE id = $1
            AND payment_anomaly_code = $2;
        `,
        [input.orderId, audit.expectedCode]
      );
      await client.query('COMMIT');
      return 'resolved';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};

export const resolveProviderPaymentAnomaly = async (input: {
  anomalyId: string;
  expectedCode: string;
  resolvedBy: string;
  reason: string;
}): Promise<PaymentAnomalyResolutionResult> => {
  if (!/^[1-9][0-9]*$/.test(input.anomalyId)) {
    throw new Error('Invalid anomalyId');
  }
  const audit = normalizeResolutionInput(input);
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const result = await client.query(
        `
          SELECT id, anomaly_code, external_payment_id, resolved_at
          FROM payment_anomalies
          WHERE id = $1
          FOR UPDATE;
        `,
        [input.anomalyId]
      );
      const anomaly = result.rows[0] as
        | {
            id: string;
            anomaly_code: string;
            external_payment_id: string;
            resolved_at: Date | string | null;
          }
        | undefined;
      if (!anomaly) {
        await client.query('COMMIT');
        return 'not_found';
      }
      if (anomaly.resolved_at !== null) {
        await client.query('COMMIT');
        return 'already_resolved';
      }
      if (anomaly.anomaly_code !== audit.expectedCode) {
        await client.query('COMMIT');
        return 'code_mismatch';
      }
      await client.query(
        `
          INSERT INTO payment_anomaly_resolutions (
            scope,
            provider_payment_anomaly_id,
            original_anomaly_code,
            external_payment_id,
            resolved_by,
            source,
            reason
          )
          VALUES ('provider_payment', $1, $2, $3, $4, 'cli', $5);
        `,
        [
          input.anomalyId,
          anomaly.anomaly_code,
          anomaly.external_payment_id,
          audit.resolvedBy,
          audit.reason
        ]
      );
      await client.query(
        `
          UPDATE payment_anomalies
          SET resolved_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
            AND resolved_at IS NULL;
        `,
        [input.anomalyId]
      );
      await client.query('COMMIT');
      return 'resolved';
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
};
