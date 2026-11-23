export interface AuditEntry {
  /** users.id pelaku; NULL untuk sistem. */
  userId?: number | null;
  action: string;
  entity: string;
  entityId?: number | null;
  payload?: unknown;
}

/** Statement audit untuk dimasukkan ke dalam DB.batch() bersama mutasinya. */
export function auditStmt(db: D1Database, e: AuditEntry): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(e.userId ?? null, e.action, e.entity, e.entityId ?? null, e.payload === undefined ? null : JSON.stringify(e.payload));
}
