import assert from 'node:assert/strict';
import test from 'node:test';
import { isPaymentAnomalyMateriallyChanged } from './db/paymentAnomalies';

const orphan = {
  anomalyCode: 'orphan_succeeded_payment' as const,
  metadataOrderId: null,
  linkedOrderId: null
};

test('does not reopen a resolved provider anomaly for an identical observation', () => {
  assert.equal(isPaymentAnomalyMateriallyChanged(orphan, orphan), false);
});

test('reopens a resolved provider anomaly when its code changes', () => {
  assert.equal(
    isPaymentAnomalyMateriallyChanged(orphan, {
      ...orphan,
      anomalyCode: 'payment_order_association_conflict'
    }),
    true
  );
});

test('reopens a resolved provider anomaly for a newly discovered association', () => {
  assert.equal(
    isPaymentAnomalyMateriallyChanged(orphan, {
      ...orphan,
      metadataOrderId: '6ee579dc-95d4-4db9-9bc3-41885dfdf4b4'
    }),
    true
  );
});

test('does not erase a known association when a later observation omits it', () => {
  assert.equal(
    isPaymentAnomalyMateriallyChanged(
      {
        ...orphan,
        linkedOrderId: '5b1f91e4-f768-486f-aee8-cf7d9a11ed42'
      },
      orphan
    ),
    false
  );
});
