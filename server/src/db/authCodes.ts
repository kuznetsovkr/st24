import { query } from '../db';

export type AuthCodeRow = {
  phone: string;
  code: string;
  expires_at: string;
  created_at: string;
};

export const saveAuthCode = async (phone: string, code: string, expiresAt: string) => {
  await query(
    `
      INSERT INTO auth_codes (phone, code, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO UPDATE
        SET code = EXCLUDED.code,
            expires_at = EXCLUDED.expires_at,
            created_at = NOW();
    `,
    [phone, code, expiresAt]
  );
};

export const findAuthCode = async (phone: string): Promise<AuthCodeRow | null> => {
  const result = await query(
    `
      SELECT phone, code, expires_at, created_at
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
