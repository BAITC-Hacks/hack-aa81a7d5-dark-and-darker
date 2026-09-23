import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def database(*, write: bool = False):
    path = os.environ.get("HACKALEM_DB_PATH", str(Path(__file__).resolve().parents[1] / "hackalem.db"))
    connection = sqlite3.connect(path, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    try:
        if write:
            connection.execute("BEGIN IMMEDIATE")
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def initialize_database():
    with database() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS business_users (
                id INTEGER PRIMARY KEY, name TEXT NOT NULL,
                organization TEXT NOT NULL, contact TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                business_id INTEGER NOT NULL REFERENCES business_users(id),
                title TEXT NOT NULL, initial_description TEXT NOT NULL,
                context TEXT NOT NULL DEFAULT '', materials TEXT NOT NULL DEFAULT '',
                expected_result TEXT NOT NULL DEFAULT '', success_criteria TEXT NOT NULL DEFAULT '',
                constraints TEXT NOT NULL DEFAULT '', target_users TEXT NOT NULL DEFAULT '',
                business_contact TEXT NOT NULL DEFAULT '',
                readiness_score INTEGER NOT NULL DEFAULT 0 CHECK(readiness_score BETWEEN 0 AND 100),
                readiness_level TEXT NOT NULL DEFAULT 'Черновик',
                status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
                is_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(is_confirmed IN (0,1)),
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                CHECK(status != 'published' OR is_confirmed = 1)
            );
            CREATE TABLE IF NOT EXISTS student_teams (
                id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                description TEXT NOT NULL, skills TEXT NOT NULL,
                members_count INTEGER NOT NULL CHECK(members_count > 0), contact TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS proposals (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_id INTEGER NOT NULL REFERENCES tasks(id),
                team_id INTEGER NOT NULL REFERENCES student_teams(id),
                message TEXT NOT NULL, proposed_solution TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
                created_at TEXT NOT NULL, UNIQUE(task_id, team_id)
            );
            CREATE TABLE IF NOT EXISTS seed_runs (name TEXT PRIMARY KEY);
            CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
            CREATE INDEX IF NOT EXISTS idx_proposals_team ON proposals(team_id);
        """)
