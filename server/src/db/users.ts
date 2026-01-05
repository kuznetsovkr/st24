import { randomUUID } from 'crypto';
import { query } from '../db';

export type UserRow = {
  id: string;
  phone: string;
  role: string;
  email: string | null;
  full_name: string | null;
  created_at: string;
  updated_at: string;
};

export const findUserByPhone = async (phone: string): Promise<UserRow | null> => {
  const result = await query(
    `
      SELECT id, phone, role, email, full_name, created_at, updated_at
      FROM users
      WHERE phone = $1;
    `,
    [phone]
  );

  return (result.rows[0] as UserRow | undefined) ?? null;
};

export const findUserById = async (id: string): Promise<UserRow | null> => {
  const result = await query(
    `
      SELECT id, phone, role, email, full_name, created_at, updated_at
      FROM users
      WHERE id = $1;
    `,
    [id]
  );

  return (result.rows[0] as UserRow | undefined) ?? null;
};

export const findUserByEmail = async (email: string): Promise<UserRow | null> => {
  const result = await query(
    `
      SELECT id, phone, role, email, full_name, created_at, updated_at
      FROM users
      WHERE email = $1;
    `,
    [email]
  );

  return (result.rows[0] as UserRow | undefined) ?? null;
};

export const upsertUser = async (phone: string, role: string): Promise<UserRow> => {
  const id = randomUUID();
  const result = await query(
    `
      INSERT INTO users (id, phone, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (phone) DO UPDATE
        SET role = EXCLUDED.role,
            updated_at = NOW()
      RETURNING id, phone, role, email, full_name, created_at, updated_at;
    `,
    [id, phone, role]
  );

  return result.rows[0] as UserRow;
};

export const updateUserProfile = async (
  id: string,
  email: string | null,
  fullName: string | null,
  phone: string
): Promise<UserRow | null> => {
  const result = await query(
    `
      UPDATE users
      SET email = $2,
          full_name = $3,
          phone = $4,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, phone, role, email, full_name, created_at, updated_at;
    `,
    [id, email, fullName, phone]
  );

  return (result.rows[0] as UserRow | undefined) ?? null;
};
