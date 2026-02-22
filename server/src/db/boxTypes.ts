import { randomUUID } from 'crypto';
import { query } from '../db';

export type BoxTypeRow = {
  id: string;
  name: string;
  length_cm: number;
  width_cm: number;
  height_cm: number;
  max_weight_grams: number;
  empty_weight_grams: number;
  fill_ratio: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
};

type BoxTypeInput = {
  name: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  maxWeightGrams: number;
  emptyWeightGrams: number;
  fillRatio: number;
  sortOrder: number;
};

export const listBoxTypes = async (): Promise<BoxTypeRow[]> => {
  const result = await query(
    `
      SELECT id, name, length_cm, width_cm, height_cm, max_weight_grams, empty_weight_grams, fill_ratio, sort_order, created_at, updated_at
      FROM box_types
      ORDER BY sort_order ASC, created_at ASC;
    `
  );
  return result.rows as BoxTypeRow[];
};

export const createBoxType = async (input: BoxTypeInput): Promise<BoxTypeRow> => {
  const id = randomUUID();
  const result = await query(
    `
      INSERT INTO box_types (
        id,
        name,
        length_cm,
        width_cm,
        height_cm,
        max_weight_grams,
        empty_weight_grams,
        fill_ratio,
        sort_order
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id, name, length_cm, width_cm, height_cm, max_weight_grams, empty_weight_grams, fill_ratio, sort_order, created_at, updated_at;
    `,
    [
      id,
      input.name,
      input.lengthCm,
      input.widthCm,
      input.heightCm,
      input.maxWeightGrams,
      input.emptyWeightGrams,
      input.fillRatio,
      input.sortOrder
    ]
  );

  return result.rows[0] as BoxTypeRow;
};

export const updateBoxType = async (
  id: string,
  input: BoxTypeInput
): Promise<BoxTypeRow | null> => {
  const result = await query(
    `
      UPDATE box_types
      SET name = $2,
          length_cm = $3,
          width_cm = $4,
          height_cm = $5,
          max_weight_grams = $6,
          empty_weight_grams = $7,
          fill_ratio = $8,
          sort_order = $9,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, name, length_cm, width_cm, height_cm, max_weight_grams, empty_weight_grams, fill_ratio, sort_order, created_at, updated_at;
    `,
    [
      id,
      input.name,
      input.lengthCm,
      input.widthCm,
      input.heightCm,
      input.maxWeightGrams,
      input.emptyWeightGrams,
      input.fillRatio,
      input.sortOrder
    ]
  );

  return (result.rows[0] as BoxTypeRow | undefined) ?? null;
};

export const deleteBoxType = async (id: string): Promise<BoxTypeRow | null> => {
  const result = await query(
    `
      DELETE FROM box_types
      WHERE id = $1
      RETURNING id, name, length_cm, width_cm, height_cm, max_weight_grams, empty_weight_grams, fill_ratio, sort_order, created_at, updated_at;
    `,
    [id]
  );

  return (result.rows[0] as BoxTypeRow | undefined) ?? null;
};
