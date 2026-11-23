-- =====================================================================
-- v2: undangan user (owner membuat tautan sekali pakai untuk admin/staff)
-- =====================================================================

CREATE TABLE user_invites (
  code        TEXT PRIMARY KEY,                -- acak, dipakai di t.me/<bot>?start=join_<code>
  role        TEXT NOT NULL CHECK (role IN ('admin','staff')),
  created_by  INTEGER REFERENCES users(id),
  expires_at  TEXT NOT NULL,                   -- ISO UTC; undangan kedaluwarsa tidak bisa dipakai
  used_at     TEXT,                            -- NULL = belum dipakai (sekali pakai)
  used_by     INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_user_invites_expires ON user_invites(expires_at);
