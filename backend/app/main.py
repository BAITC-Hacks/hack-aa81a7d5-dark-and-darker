import json
import sqlite3
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Query

from .ai import router as ai_router
from .db import database, now
from .models import ProposalCreate, ProposalStatus, TaskCreate, TaskPatch, TaskVersion
from .readiness import calculate_readiness, generate_questions
from .seed import BUSINESS_ID, seed_database
from .wizard_models import WizardCreate, WizardSave


@asynccontextmanager
async def lifespan(app: FastAPI):
    seed_database()
    yield


app = FastAPI(title="AI Sana Challenge Hub API", version="0.2.0", lifespan=lifespan)
app.include_router(ai_router)


def get_task(db, task_id: int) -> dict:
    row = db.execute("""SELECT t.*, b.organization, b.name AS business_name FROM tasks t
                        JOIN business_users b ON b.id=t.business_id WHERE t.id=?""", (task_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Задача не найдена")
    task = dict(row)
    task["is_confirmed"] = bool(task["is_confirmed"])
    state = db.execute("SELECT data FROM wizard_states WHERE task_id=?", (task_id,)).fetchone()
    task["wizard_state"] = json.loads(state["data"]) if state and state["data"] else None
    return task


def require_owner(task: dict):
    if task["business_id"] != BUSINESS_ID:
        raise HTTPException(403, "Можно изменять только задачи демонстрационного бизнеса")


def require_revision(task: dict, expected_revision: int):
    if task["revision"] != expected_revision:
        raise HTTPException(409, "Карточка была изменена в другой вкладке. Откройте актуальную версию и проверьте изменения перед подтверждением.")


def get_team(db, team_id: int) -> dict:
    row = db.execute("SELECT * FROM student_teams WHERE id=?", (team_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Команда не найдена")
    return {**dict(row), "skills": json.loads(row["skills"])}


PROPOSAL_SELECT = """SELECT p.*, t.title AS task_title, t.status AS task_status,
    s.name AS team_name, s.skills AS team_skills, s.contact AS team_contact
    FROM proposals p JOIN tasks t ON t.id=p.task_id JOIN student_teams s ON s.id=p.team_id"""


def proposal_dict(row):
    return {**dict(row), "team_skills": json.loads(row["team_skills"])}


def get_proposal(db, proposal_id: int) -> dict:
    row = db.execute(PROPOSAL_SELECT + " WHERE p.id=?", (proposal_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "Предложение не найдено")
    return proposal_dict(row)


@app.get("/api/health", tags=["health"])
def health():
    with database() as db:
        db.execute("SELECT 1").fetchone()
    return {"status": "ok", "service": "hackalem-api"}


@app.get("/api/questions", tags=["tasks"])
def questions():
    return generate_questions()


@app.get("/api/tasks", tags=["tasks"])
def list_tasks(
    status: Literal["draft", "published"] | None = None,
    readiness_level: Literal["Черновик", "Рабочая", "Готовая", "Приоритетная"] | None = None,
    sort: Literal["newest", "oldest", "score_desc", "score_asc"] = "newest",
    search: str = Query(default="", max_length=200),
    business_id: int | None = Query(default=None, gt=0),
):
    conditions, args = [], []
    for column, value in [("status", status), ("readiness_level", readiness_level), ("business_id", business_id)]:
        if value is not None:
            conditions.append(f"t.{column}=?")
            args.append(value)
    order = {"newest": "t.created_at DESC, t.id DESC", "oldest": "t.created_at ASC, t.id ASC",
             "score_desc": "t.readiness_score DESC, t.id DESC", "score_asc": "t.readiness_score ASC, t.id DESC"}[sort]
    sql = "SELECT t.id FROM tasks t" + (" WHERE " + " AND ".join(conditions) if conditions else "")
    with database() as db:
        tasks = [get_task(db, row["id"]) for row in db.execute(sql + " ORDER BY " + order, args).fetchall()]
    # Python casefold supports Russian search; SQLite's built-in LOWER does not.
    query = search.strip().casefold()
    return [task for task in tasks if not query or query in (task["title"] + " " + task["initial_description"]).casefold()]


@app.get("/api/tasks/{task_id}", tags=["tasks"])
def task_detail(task_id: int):
    with database() as db:
        return get_task(db, task_id)


@app.post("/api/tasks", status_code=201, tags=["tasks"])
def create_task(body: TaskCreate):
    values = body.model_dump()
    readiness = calculate_readiness(values)
    timestamp = now()
    values.update(business_id=BUSINESS_ID, readiness_score=readiness["score"], readiness_level=readiness["level"],
                  created_at=timestamp, updated_at=timestamp)
    with database(write=True) as db:
        cursor = db.execute(f"INSERT INTO tasks ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))
        return get_task(db, cursor.lastrowid)


@app.patch("/api/tasks/{task_id}", tags=["tasks"])
def update_task(task_id: int, body: TaskPatch):
    values = body.model_dump(exclude_unset=True, exclude={"expected_revision"})
    with database(write=True) as db:
        task = get_task(db, task_id)
        require_owner(task)
        require_revision(task, body.expected_revision)
        changes = {key: value for key, value in values.items() if task[key] != value}
        if changes:
            readiness = calculate_readiness({**task, **changes})
            changes.update(is_confirmed=0, status="draft", readiness_score=readiness["score"],
                           readiness_level=readiness["level"], updated_at=now(), revision=task["revision"] + 1)
            db.execute(f"UPDATE tasks SET {','.join(key + '=?' for key in changes)} WHERE id=?", (*changes.values(), task_id))
            # A separate/manual edit invalidates the old recovery snapshot.
            db.execute("UPDATE wizard_states SET data=NULL WHERE task_id=?", (task_id,))
        return get_task(db, task_id)


@app.post("/api/wizard-drafts", tags=["tasks"])
def create_wizard(body: WizardCreate):
    with database(write=True) as db:
        existing = db.execute("SELECT task_id FROM wizard_states WHERE client_id=?", (str(body.client_id),)).fetchone()
        if existing:
            return get_task(db, existing["task_id"])
        if not body.state.fields.title.strip() or not body.state.fields.initial_description.strip():
            raise HTTPException(422, "Укажите название и краткое описание задачи")
        values = TaskCreate.model_validate(body.state.fields.model_dump()).model_dump()
        readiness = calculate_readiness(values)
        values.update(business_id=BUSINESS_ID, readiness_score=readiness["score"], readiness_level=readiness["level"],
                      created_at=now(), updated_at=now())
        cursor = db.execute(f"INSERT INTO tasks ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))
        db.execute("INSERT INTO wizard_states (task_id,client_id,data) VALUES (?,?,?)",
                   (cursor.lastrowid, str(body.client_id), body.state.model_dump_json()))
        return get_task(db, cursor.lastrowid)


@app.put("/api/tasks/{task_id}/wizard", tags=["tasks"])
def save_wizard(task_id: int, body: WizardSave):
    # BEGIN IMMEDIATE holds the lock across the version check and both writes.
    with database(write=True) as db:
        task = get_task(db, task_id)
        require_owner(task)
        require_revision(task, body.expected_revision)
        state = body.state.model_dump()
        if task["wizard_state"] == state:
            return task
        fields = state["fields"]
        # Even temporarily empty required fields survive reload in the snapshot.
        values = TaskCreate.model_validate(fields).model_dump() if fields["title"].strip() and fields["initial_description"].strip() else {}
        changes = {key: value for key, value in values.items() if task[key] != value}
        previous_fields = (task["wizard_state"] or {}).get("fields", {key: task[key] for key in fields})
        if changes or fields != previous_fields:
            readiness = calculate_readiness({**task, **changes})
            changes.update(is_confirmed=0, status="draft", readiness_score=readiness["score"], readiness_level=readiness["level"])
        changes.update(revision=task["revision"] + 1, updated_at=now())
        db.execute(f"UPDATE tasks SET {','.join(key + '=?' for key in changes)} WHERE id=?", (*changes.values(), task_id))
        db.execute("INSERT INTO wizard_states (task_id,data) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
                   (task_id, body.state.model_dump_json()))
        return get_task(db, task_id)


@app.post("/api/tasks/{task_id}/confirm", tags=["tasks"])
def confirm_task(task_id: int, body: TaskVersion):
    with database(write=True) as db:
        task = get_task(db, task_id)
        require_owner(task)
        require_revision(task, body.expected_revision)
        readiness = calculate_readiness(task)
        db.execute("UPDATE tasks SET is_confirmed=1,readiness_score=?,readiness_level=?,updated_at=?,revision=revision+1 WHERE id=?",
                   (readiness["score"], readiness["level"], now(), task_id))
        return get_task(db, task_id)


@app.post("/api/tasks/{task_id}/publish", tags=["tasks"])
def publish_task(task_id: int, body: TaskVersion):
    with database(write=True) as db:
        task = get_task(db, task_id)
        require_owner(task)
        require_revision(task, body.expected_revision)
        if not task["is_confirmed"]:
            raise HTTPException(409, "Сначала подтвердите текущую версию карточки")
        db.execute("UPDATE tasks SET status='published',updated_at=?,revision=revision+1 WHERE id=?", (now(), task_id))
        return get_task(db, task_id)


@app.get("/api/tasks/{task_id}/readiness", tags=["tasks"])
def task_readiness(task_id: int):
    with database() as db:
        return calculate_readiness(get_task(db, task_id))


@app.get("/api/teams", tags=["teams"])
def list_teams():
    with database() as db:
        return [get_team(db, row["id"]) for row in db.execute("SELECT id FROM student_teams ORDER BY id").fetchall()]


@app.get("/api/teams/{team_id}", tags=["teams"])
def team_detail(team_id: int):
    with database() as db:
        return get_team(db, team_id)


@app.post("/api/tasks/{task_id}/proposals", status_code=201, tags=["proposals"])
def create_proposal(task_id: int, body: ProposalCreate):
    with database(write=True) as db:
        task = get_task(db, task_id)
        get_team(db, body.team_id)
        if task["status"] != "published":
            raise HTTPException(409, "Предложение можно отправить только на опубликованную задачу")
        try:
            cursor = db.execute("INSERT INTO proposals (task_id,team_id,message,proposed_solution,created_at) VALUES (?,?,?,?,?)",
                                (task_id, body.team_id, body.message, body.proposed_solution, now()))
        except sqlite3.IntegrityError:
            raise HTTPException(409, "Эта команда уже отправила предложение на задачу") from None
        return get_proposal(db, cursor.lastrowid)


@app.get("/api/tasks/{task_id}/proposals", tags=["proposals"])
def task_proposals(task_id: int):
    with database() as db:
        require_owner(get_task(db, task_id))
        return [proposal_dict(row) for row in db.execute(PROPOSAL_SELECT + " WHERE p.task_id=? ORDER BY p.created_at DESC,p.id DESC", (task_id,))]


@app.get("/api/teams/{team_id}/proposals", tags=["proposals"])
def team_proposals(team_id: int):
    with database() as db:
        get_team(db, team_id)
        return [proposal_dict(row) for row in db.execute(PROPOSAL_SELECT + " WHERE p.team_id=? ORDER BY p.created_at DESC,p.id DESC", (team_id,))]


@app.get("/api/proposals", tags=["proposals"])
def business_proposals():
    with database() as db:
        return [proposal_dict(row) for row in db.execute(PROPOSAL_SELECT + " WHERE t.business_id=? ORDER BY p.created_at DESC,p.id DESC", (BUSINESS_ID,))]


@app.patch("/api/proposals/{proposal_id}/status", tags=["proposals"])
def update_proposal_status(proposal_id: int, body: ProposalStatus):
    with database(write=True) as db:
        proposal = get_proposal(db, proposal_id)
        require_owner(get_task(db, proposal["task_id"]))
        if proposal["status"] != "pending":
            raise HTTPException(409, "Предложение уже обработано. Повторное решение недоступно")
        db.execute("UPDATE proposals SET status=? WHERE id=?", (body.status, proposal_id))
        return get_proposal(db, proposal_id)
