import { query } from '../db';

export type EmailCodeRow = {
  email: string;
  code: string;
  expires_at: string;
  created_at: string;
};

export const saveEmailCode = async (email: string, code: string, expiresAt: string) => {
  await query(
    `
      INSERT INTO email_codes (email, code, expires_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE
        SET code = EXCLUDED.code,
            expires_at = EXCLUDED.expires_at,
            created_at = NOW();
    `,
    [email, code, expiresAt]
  );
};

export const findEmailCode = async (email: string): Promise<EmailCodeRow | null> => {
  const result = await query(
    `
      SELECT email, code, expires_at, created_at
      FROM email_codes
      WHERE email = $1;
    `,
    [email]
  );

  return (result.rows[0] as EmailCodeRow | undefined) ?? null;
};

export const deleteEmailCode = async (email: string) => {
  await query(`DELETE FROM email_codes WHERE email = $1;`, [email]);
};
