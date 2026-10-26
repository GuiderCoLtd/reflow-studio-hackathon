// SQLite access (node:sqlite). The database uses the rollback journal
// (journal_mode=DELETE), so a plain file copy is always a complete snapshot.
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH } from './config.mjs';

export const SCHEMA = `
CREATE TABLE departments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL
);
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  dept_id INTEGER NOT NULL REFERENCES departments(id),
  title TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  invited INTEGER NOT NULL DEFAULT 0,
  phone TEXT,
  employee_no TEXT,
  joined_on TEXT,
  leave_total REAL NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL,
  invite_resent_at TEXT
);
CREATE TABLE leave_requests (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  approver_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_note TEXT
);
CREATE TABLE expenses (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  used_on TEXT NOT NULL,
  category TEXT NOT NULL,
  amount INTEGER NOT NULL,
  merchant TEXT NOT NULL,
  memo TEXT NOT NULL DEFAULT '',
  receipt_name TEXT,
  receipt_type TEXT,
  receipt BLOB,
  status TEXT NOT NULL,
  approver_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decision_note TEXT
);
CREATE TABLE approval_docs (
  id INTEGER PRIMARY KEY,
  doc_no TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  drafter_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL,
  body TEXT NOT NULL,
  ref_type TEXT,
  ref_id INTEGER,
  drafted_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE TABLE approval_steps (
  id INTEGER PRIMARY KEY,
  doc_id INTEGER NOT NULL REFERENCES approval_docs(id),
  seq INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  acted_at TEXT,
  comment TEXT,
  UNIQUE (doc_id, seq)
);
CREATE TABLE attendance (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  clock_in TEXT,
  clock_out TEXT,
  status TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  corrected INTEGER NOT NULL DEFAULT 0,
  UNIQUE (user_id, work_date)
);
CREATE TABLE corrections (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  work_date TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('in', 'out')),
  time TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE notices (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id),
  pinned INTEGER NOT NULL DEFAULT 0,
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  photo TEXT
);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  link TEXT,
  created_at TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  end_date TEXT,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE TABLE settings (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);
CREATE INDEX idx_leave_user ON leave_requests(user_id, created_at);
CREATE INDEX idx_exp_user ON expenses(user_id, used_on);
CREATE INDEX idx_steps_user ON approval_steps(user_id, status);
CREATE INDEX idx_att_user ON attendance(user_id, work_date);
`;

// Columns added after the first schema. Older database files (snapshots taken
// before them) get them when opened, so restoring an old snapshot keeps working.
const ADDED_COLUMNS = [
  ['users', 'invite_resent_at', 'TEXT'],
  ['notices', 'photo', 'TEXT'],
];

export function openDb(file = DB_PATH) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = DELETE; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  for (const [table, column, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all();
    if (cols.length && !cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
