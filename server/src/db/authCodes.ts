import { query } from '../db';

export type AuthCodeRow = {
  phone: string;
  code: string;
  expires_at: string;
  created_at: string;
  delivery_channel: string | null;
  provider_request_id: string | null;
  provider_message_id: string | null;
};

type AuthCodeDeliveryMeta = {
  deliveryChannel?: string | null;
  providerRequestId?: string | null;
  providerMessageId?: string | null;
};

export const saveAuthCode = async (
  phone: string,
  code: string,
  expiresAt: string,
  meta: AuthCodeDeliveryMeta = {}
) => {
  await query(
    `
      INSERT INTO auth_codes (
        phone,
        code,
        expires_at,
        delivery_channel,
        provider_request_id,
        provider_message_id
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (phone) DO UPDATE
        SET code = EXCLUDED.code,
            expires_at = EXCLUDED.expires_at,
            delivery_channel = EXCLUDED.delivery_channel,
            provider_request_id = EXCLUDED.provider_request_id,
            provider_message_id = EXCLUDED.provider_message_id,
            created_at = NOW();
    `,
    [
      phone,
      code,
      expiresAt,
      meta.deliveryChannel ?? null,
      meta.providerRequestId ?? null,
      meta.providerMessageId ?? null
    ]
  );
};

export const findAuthCode = async (phone: string): Promise<AuthCodeRow | null> => {
  const result = await query(
    `
      SELECT
        phone,
        code,
        expires_at,
        created_at,
        delivery_channel,
        provider_request_id,
        provider_message_id
      FROM auth_codes
      WHERE phone = $1;
    `,
    [phone]
  );

  return (result.rows[0] as AuthCodeRow | undefined) ?? null;
};

export const deleteAuthCode = async (phone: string) => {
  await query(`DELETE FROM auth_codes WHERE phone = $1;`, [phone]);
};
