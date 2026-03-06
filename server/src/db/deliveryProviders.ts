import { query } from '../db';

export const DELIVERY_PROVIDER_KEYS = ['cdek', 'dellin', 'russian_post'] as const;

export type DeliveryProviderKey = (typeof DELIVERY_PROVIDER_KEYS)[number];

export type DeliveryProviderRow = {
  key: DeliveryProviderKey;
  name: string;
  is_enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

export const isDeliveryProviderKey = (value: string): value is DeliveryProviderKey =>
  DELIVERY_PROVIDER_KEYS.includes(value as DeliveryProviderKey);

export const listDeliveryProviders = async (): Promise<DeliveryProviderRow[]> => {
  const result = await query(
    `
      SELECT key, name, is_enabled, sort_order, created_at, updated_at
      FROM delivery_providers
      ORDER BY sort_order ASC, created_at ASC;
    `
  );

  return result.rows as DeliveryProviderRow[];
};

export const findDeliveryProviderByKey = async (
  key: DeliveryProviderKey
): Promise<DeliveryProviderRow | null> => {
  const result = await query(
    `
      SELECT key, name, is_enabled, sort_order, created_at, updated_at
      FROM delivery_providers
      WHERE key = $1
      LIMIT 1;
    `,
    [key]
  );
  return (result.rows[0] as DeliveryProviderRow | undefined) ?? null;
};

export const updateDeliveryProviderEnabled = async (
  key: DeliveryProviderKey,
  isEnabled: boolean
): Promise<DeliveryProviderRow | null> => {
  const result = await query(
    `
      UPDATE delivery_providers
      SET is_enabled = $2,
          updated_at = NOW()
      WHERE key = $1
      RETURNING key, name, is_enabled, sort_order, created_at, updated_at;
    `,
    [key, isEnabled]
  );
  return (result.rows[0] as DeliveryProviderRow | undefined) ?? null;
};

export const isDeliveryProviderEnabled = async (key: DeliveryProviderKey): Promise<boolean> => {
  const item = await findDeliveryProviderByKey(key);
  return item?.is_enabled ?? false;
};
