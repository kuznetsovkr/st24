import { query } from './db';

export const SUPER_ADMIN_LOG_KINDS = [
  'security',
  'order_lifecycle',
  'admin_audit',
  'integration',
  'error',
  'phone_code_delivery_events',
  'phone_code_delivery_stats',
  'lead_requests',
  'telegram_subscribers',
  'telegram_order_subscribers',
  'telegram_b2b_subscribers'
] as const;

export type SuperAdminLogKind = (typeof SUPER_ADMIN_LOG_KINDS)[number];

type ListSuperAdminLogsInput = {
  kind: SuperAdminLogKind;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
};

type LogSourceDefinition = {
  table: string;
  columns: string[];
  orderByColumn?: string;
};

type ListSuperAdminLogsResult = {
  columns: string[];
  items: Array<Record<string, unknown>>;
  total: number;
};

const LOG_SOURCES: Record<SuperAdminLogKind, LogSourceDefinition> = {
  security: {
    table: 'security_events',
    columns: [
      'id',
      'event_type',
      'ip_hash',
      'phone_masked',
      'email_masked',
      'reason',
      'route',
      'method',
      'user_id',
      'created_at'
    ]
  },
  order_lifecycle: {
    table: 'order_lifecycle_events',
    columns: [
      'id',
      'event_type',
      'order_id',
      'order_number',
      'payment_id',
      'old_status',
      'new_status',
      'amount_cents',
      'provider',
      'error',
      'created_at'
    ]
  },
  admin_audit: {
    table: 'admin_audit_events',
    columns: [
      'id',
      'actor_user_id',
      'entity_type',
      'entity_id',
      'action',
      'before_json',
      'after_json',
      'created_at'
    ]
  },
  integration: {
    table: 'integration_events',
    columns: [
      'id',
      'provider',
      'operation',
      'attempt',
      'status_code',
      'latency_ms',
      'fallback_used',
      'error',
      'created_at'
    ]
  },
  error: {
    table: 'error_events',
    columns: [
      'id',
      'error_class',
      'message',
      'stack',
      'request_id',
      'route',
      'user_id',
      'created_at'
    ]
  },
  phone_code_delivery_events: {
    table: 'phone_code_delivery_events',
    columns: [
      'id',
      'phone',
      'channel',
      'context',
      'status',
      'preferred_channel',
      'fallback_used',
      'provider_request_id',
      'provider_message_id',
      'error',
      'ip',
      'created_at'
    ]
  },
  phone_code_delivery_stats: {
    table: 'phone_code_delivery_stats',
    orderByColumn: 'updated_at',
    columns: [
      'phone',
      'telegram_sent_count',
      'sms_sent_count',
      'last_action',
      'last_channel',
      'last_context',
      'last_event_status',
      'last_event_at',
      'updated_at',
      'created_at'
    ]
  },
  lead_requests: {
    table: 'lead_requests',
    orderByColumn: 'created_at',
    columns: [
      'id',
      'kind',
      'full_name',
      'phone',
      'email',
      'payload',
      'telegram_status',
      'telegram_error',
      'telegram_sent_at',
      'updated_at',
      'created_at'
    ]
  },
  telegram_subscribers: {
    table: 'telegram_subscribers',
    columns: [
      'chat_id',
      'username',
      'first_name',
      'last_name',
      'language_code',
      'chat_type',
      'is_active',
      'updated_at',
      'created_at'
    ]
  },
  telegram_order_subscribers: {
    table: 'telegram_order_subscribers',
    columns: [
      'chat_id',
      'username',
      'first_name',
      'last_name',
      'language_code',
      'chat_type',
      'is_active',
      'updated_at',
      'created_at'
    ]
  },
  telegram_b2b_subscribers: {
    table: 'telegram_b2b_subscribers',
    columns: [
      'chat_id',
      'username',
      'first_name',
      'last_name',
      'language_code',
      'chat_type',
      'is_active',
      'updated_at',
      'created_at'
    ]
  }
};

const csvEscape = (value: string) => `"${value.replace(/"/g, '""')}"`;

const formatCsvCell = (value: unknown) => {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
};

const buildCreatedAtFilter = (from?: string, to?: string) => {
  const clauses: string[] = [];
  const params: Array<string | number | boolean | string[] | null> = [];

  if (from) {
    params.push(from);
    clauses.push(`created_at >= $${params.length}::timestamptz`);
  }

  if (to) {
    params.push(to);
    clauses.push(`created_at <= $${params.length}::timestamptz`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    params
  };
};

export const isSuperAdminLogKind = (value: string): value is SuperAdminLogKind =>
  SUPER_ADMIN_LOG_KINDS.includes(value as SuperAdminLogKind);

export const listSuperAdminLogs = async (
  input: ListSuperAdminLogsInput
): Promise<ListSuperAdminLogsResult> => {
  const source = LOG_SOURCES[input.kind];
  const filter = buildCreatedAtFilter(input.from, input.to);
  const whereSql = filter.whereSql;
  const selectColumnsSql = source.columns.join(', ');
  const orderByColumn = source.orderByColumn ?? 'created_at';

  const countResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM ${source.table}
      ${whereSql};
    `,
    filter.params
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  const rowsParams = [...filter.params, input.limit, input.offset];
  const limitParamIndex = filter.params.length + 1;
  const offsetParamIndex = filter.params.length + 2;
  const rowsResult = await query(
    `
      SELECT ${selectColumnsSql}
      FROM ${source.table}
      ${whereSql}
      ORDER BY ${orderByColumn} DESC
      LIMIT $${limitParamIndex}
      OFFSET $${offsetParamIndex};
    `,
    rowsParams
  );

  return {
    columns: source.columns,
    items: rowsResult.rows as Array<Record<string, unknown>>,
    total
  };
};

export const superAdminLogsToCsv = (
  columns: string[],
  rows: Array<Record<string, unknown>>
) => {
  const header = columns.map(csvEscape).join(',');
  const lines = rows.map((row) =>
    columns.map((column) => csvEscape(formatCsvCell(row[column]))).join(',')
  );
  return [header, ...lines].join('\n');
};
