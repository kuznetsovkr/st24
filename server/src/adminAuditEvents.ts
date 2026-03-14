import { randomUUID } from 'crypto';
import { query } from './db';

type AdminAuditEventInput = {
  actorUserId?: string | null;
  entityType: string;
  entityId?: string | null;
  action: string;
  beforeJson?: unknown;
  afterJson?: unknown;
};

const trimToUndefined = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const toJsonPayload = (value: unknown) => {
  if (value === undefined) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({ error: 'serialization_failed' });
  }
};

export const logAdminAuditEvent = async (input: AdminAuditEventInput) => {
  try {
    await query(
      `
        INSERT INTO admin_audit_events (
          id,
          actor_user_id,
          entity_type,
          entity_id,
          action,
          before_json,
          after_json
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb);
      `,
      [
        randomUUID(),
        trimToUndefined(input.actorUserId) ?? null,
        trimToUndefined(input.entityType) ?? 'unknown',
        trimToUndefined(input.entityId) ?? null,
        trimToUndefined(input.action) ?? 'unknown',
        toJsonPayload(input.beforeJson),
        toJsonPayload(input.afterJson)
      ]
    );
  } catch (error) {
    console.error('Failed to write admin audit event', error);
  }
};
