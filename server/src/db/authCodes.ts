import { query } from '../db';

export type AuthCodeRow = {
  phone: string;
  code: string;
  expires_at: string;
  created_at: string;
  delivery_channel: string | null;
  provider_request_id: string | null;
  provider_message_id: string | null;
  call_check_status: string | null;
  call_check_status_text: string | null;
  call_verified_at: string | null;
};

type AuthCodeDeliveryMeta = {
  deliveryChannel?: string | null;
  providerRequestId?: string | null;
  providerMessageId?: string | null;
  callCheckStatus?: string | null;
  callCheckStatusText?: string | null;
  callVerifiedAt?: string | null;
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
        provider_message_id,
        call_check_status,
        call_check_status_text,
        call_verified_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (phone) DO UPDATE
        SET code = EXCLUDED.code,
            expires_at = EXCLUDED.expires_at,
            delivery_channel = EXCLUDED.delivery_channel,
            provider_request_id = EXCLUDED.provider_request_id,
            provider_message_id = EXCLUDED.provider_message_id,
            call_check_status = EXCLUDED.call_check_status,
            call_check_status_text = EXCLUDED.call_check_status_text,
            call_verified_at = EXCLUDED.call_verified_at,
            created_at = NOW();
    `,
    [
      phone,
      code,
      expiresAt,
      meta.deliveryChannel ?? null,
      meta.providerRequestId ?? null,
      meta.providerMessageId ?? null,
      meta.callCheckStatus ?? null,
      meta.callCheckStatusText ?? null,
      meta.callVerifiedAt ?? null
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
        provider_message_id,
        call_check_status,
        call_check_status_text,
        call_verified_at
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

export const updateAuthCodeCallStatusByRequestId = async (
  requestId: string,
  status: string,
  statusText?: string | null
) => {
  const result = await query(
    `
      UPDATE auth_codes
      SET
        call_check_status = $2,
        call_check_status_text = $3,
        call_verified_at = CASE WHEN $2 = 'confirmed' THEN NOW() ELSE call_verified_at END
      WHERE provider_request_id = $1;
    `,
    [requestId, status, statusText ?? null]
  );
  return (result.rowCount ?? 0) > 0;
};
