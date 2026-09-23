"""Real HTTP tests using only the standard library and existing backend dependencies."""
import itertools
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from uuid import uuid4
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from backend.app.readiness import CRITERIA, calculate_readiness
from backend.app.db import database, initialize_database
from backend.app.seed import seed_database

ROOT = Path(__file__).resolve().parents[2]


class ReadinessTests(unittest.TestCase):
    def test_additive_migration_preserves_existing_tasks_and_proposals(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"HACKALEM_DB_PATH": str(Path(directory) / "migration.db")}):
            seed_database()
            with database() as db:
                db.execute("DROP TABLE wizard_states")
                db.execute("ALTER TABLE tasks DROP COLUMN revision")
                before = [dict(row) for row in db.execute("SELECT * FROM tasks")]
                proposals = [dict(row) for row in db.execute("SELECT * FROM proposals")]
            initialize_database()
            initialize_database()
            with database() as db:
                after = [dict(row) for row in db.execute("SELECT * FROM tasks")]
                self.assertTrue(all(row.pop("revision") == 1 for row in after))
                self.assertEqual(before, after)
                self.assertEqual(proposals, [dict(row) for row in db.execute("SELECT * FROM proposals")])

    def test_all_combinations_and_levels(self):
        for included in itertools.product([False, True], repeat=7):
            fields = {criterion[0]: "Содержательная информация" if present else " \n\t "
                      for criterion, present in zip(CRITERIA, included)}
            expected = sum(criterion[2] for criterion, present in zip(CRITERIA, included) if present)
            result = calculate_readiness(fields)
            self.assertEqual(result["score"], expected)
            self.assertEqual(sum(item["points"] for item in result["criteria"]), expected)
            self.assertEqual(len(result["missing"]), 7 - sum(included))
            self.assertEqual(len(result["recommendations"]), len(result["missing"]))
            self.assertEqual(result["level"], "Черновик" if expected < 40 else "Рабочая" if expected < 70 else "Готовая" if expected < 90 else "Приоритетная")

    def test_title_and_description_do_not_earn_points(self):
        result = calculate_readiness({"title": "Подробное название", "initial_description": "Описание"})
        self.assertEqual(result["score"], 0)
        self.assertEqual(len(result["criteria"]), 7)


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="hackalem-test-")
        cls.env = {**os.environ, "HACKALEM_DB_PATH": str(Path(cls.temp.name) / "test.db"), "OPENAI_API_KEY": "", "OPENAI_MODEL": ""}
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            cls.port = sock.getsockname()[1]
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.log = open(Path(cls.temp.name) / "server.log", "w+")
        cls.start_server()

    @classmethod
    def start_server(cls):
        cls.process = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", str(cls.port)],
            cwd=ROOT, env=cls.env, stdout=cls.log, stderr=cls.log,
        )
        for _ in range(100):
            try:
                with urlopen(cls.base + "/api/health", timeout=1) as response:
                    if response.status == 200:
                        return
            except (URLError, TimeoutError):
                time.sleep(.05)
        cls.stop_server()
        cls.log.seek(0)
        raise RuntimeError(cls.log.read())

    @classmethod
    def stop_server(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)

    @classmethod
    def tearDownClass(cls):
        cls.stop_server()
        cls.log.close()
        cls.temp.cleanup()

    def request(self, method, path, body=None, expected=200):
        request = Request(self.base + "/api" + path, method=method,
                          data=json.dumps(body).encode() if body is not None else None,
                          headers={"Content-Type": "application/json"})
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            result = json.loads(response.read())
            self.assertEqual(response.status, expected, result)
            return result

    def create(self, **fields):
        return self.request("POST", "/tasks", {"title": "Проверочная задача", "initial_description": "Описание задачи", **fields}, expected=201)

    def wizard_state(self):
        fields = {"title": "Устойчивый черновик", "initial_description": "Первоначальное описание",
                  **{item[0]: "" for item in CRITERIA}}
        return {"step": 2, "fields": fields, "originalIdea": fields.copy(),
                "answers": {item[0]: "" for item in CRITERIA},
                "questionSet": {"questions": [{"field": item[0], "question": f"Уточнение AI: {item[0]}?"} for item in CRITERIA]},
                "hasQuestions": True, "hasCard": False, "questionsIdea": "Исходная идея",
                "questionInfo": {"source": "ai", "reason": None, "message": "Mock AI"}, "cardInfo": None}

    def test_late_ai_save_conflicts_atomically_with_manual_edit(self):
        state = self.wizard_state()
        task = self.request("POST", "/wizard-drafts", {"client_id": str(uuid4()), "state": state})
        path = f'/tasks/{task["id"]}'
        latest = self.request("PATCH", path, {"expected_revision": task["revision"], "context": "Новая ручная правка"})
        state["fields"]["context"] = "Устаревший mock AI"
        self.request("PUT", path + "/wizard", {"expected_revision": task["revision"], "state": state}, expected=409)
        self.assertEqual(latest, self.request("GET", path))
        self.assertIsNone(latest["wizard_state"])

    def test_wizard_persistence_idempotent_creation_and_publication(self):
        state = self.wizard_state()
        state["answers"]["context"] = "  исходный ответ пользователя  "
        state["fields"]["context"] = "AI-формулировка"
        body = {"client_id": str(uuid4()), "state": state}
        before = len(self.request("GET", "/tasks"))
        task = self.request("POST", "/wizard-drafts", body)
        self.assertEqual(task, self.request("POST", "/wizard-drafts", body))
        self.assertEqual(len(self.request("GET", "/tasks")), before + 1)
        self.assertEqual(task["wizard_state"], state)
        state["step"] = 4
        path = f'/tasks/{task["id"]}'
        saved = self.request("PUT", path + "/wizard", {"expected_revision": task["revision"], "state": state})
        self.assertEqual(saved["wizard_state"], state)
        self.stop_server()
        self.start_server()
        self.assertEqual(saved, self.request("GET", path))
        published = self.publish(saved)
        self.assertEqual(published["readiness_score"], 20)
        state["fields"]["materials"] = "Новые материалы"
        edited = self.request("PUT", path + "/wizard", {"expected_revision": published["revision"], "state": state})
        self.assertFalse(edited["is_confirmed"])
        self.assertEqual(edited["status"], "draft")
        self.assertEqual(edited["readiness_score"], 40)
        self.request("POST", path + "/publish", {"expected_revision": edited["revision"]}, expected=409)

    def test_wizard_empty_required_field_recovery_and_snapshot_conflicts(self):
        state = self.wizard_state()
        task = self.request("POST", "/wizard-drafts", {"client_id": str(uuid4()), "state": state})
        path = f'/tasks/{task["id"]}/wizard'
        state["fields"]["title"] = ""
        edited = self.request("PUT", path, {"expected_revision": task["revision"], "state": state})
        self.assertEqual(edited["wizard_state"]["fields"]["title"], "")
        self.assertTrue(edited["title"])
        self.request("PUT", path, {"expected_revision": task["revision"], "state": state}, expected=409)
        self.request("PUT", path, {"state": state}, expected=422)

    def publish(self, task):
        confirmed = self.request("POST", f'/tasks/{task["id"]}/confirm', {"expected_revision": task["revision"]})
        return self.request("POST", f'/tasks/{task["id"]}/publish', {"expected_revision": confirmed["revision"]})

    def test_stale_confirmation_and_publication_require_reviewed_revision(self):
        opened = self.create()
        path = f'/tasks/{opened["id"]}'
        edited = self.request("PATCH", path, {"expected_revision": opened["revision"], "title": "Изменено в другой вкладке"})
        conflict = self.request("POST", path + "/confirm", {"expected_revision": opened["revision"]}, expected=409)
        self.assertEqual(conflict["detail"], "Карточка была изменена в другой вкладке. Откройте актуальную версию и проверьте изменения перед подтверждением.")
        self.assertEqual(edited, self.request("GET", path))
        self.assertFalse(edited["is_confirmed"])
        self.request("POST", path + "/publish", {"expected_revision": edited["revision"]}, expected=409)
        reviewed = self.request("GET", path)
        confirmed = self.request("POST", path + "/confirm", {"expected_revision": reviewed["revision"]})
        self.assertTrue(confirmed["is_confirmed"])
        # The old tab cannot publish even after another tab confirmed the new card.
        self.request("POST", path + "/publish", {"expected_revision": opened["revision"]}, expected=409)
        self.assertEqual(confirmed, self.request("GET", path))
        published = self.request("POST", path + "/publish", {"expected_revision": confirmed["revision"]})
        self.assertEqual(published["readiness_score"], 0)
        self.assertEqual(published["status"], "published")

    def test_stale_edit_cannot_overwrite_or_reset_confirmation(self):
        opened = self.create()
        current = self.publish(opened)
        path = f'/tasks/{opened["id"]}'
        self.request("PATCH", path, {"expected_revision": opened["revision"], "context": "Старый текст"}, expected=409)
        self.assertEqual(current, self.request("GET", path))
        edited = self.request("PATCH", path, {"expected_revision": current["revision"], "context": "Новые сведения"})
        self.assertFalse(edited["is_confirmed"])
        self.assertEqual(edited["status"], "draft")
        self.request("POST", path + "/publish", {"expected_revision": current["revision"]}, expected=409)
        self.assertEqual(edited, self.request("GET", path))

    def test_task_mutations_require_a_valid_explicit_version(self):
        task = self.create()
        path = f'/tasks/{task["id"]}'
        for method, endpoint in [("PATCH", path), ("POST", path + "/confirm"), ("POST", path + "/publish")]:
            for body in [None, {}, {"expected_revision": None}, {"expected_revision": 0}, {"expected_revision": True}, {"expected_revision": "1"}]:
                self.request(method, endpoint, body, expected=422)
        self.assertEqual(task, self.request("GET", path))

    def proposal(self, task, team_id=1, **kwargs):
        return self.request("POST", f'/tasks/{task["id"]}/proposals',
                            {"team_id": team_id, "message": "Готовы обсудить задачу", "proposed_solution": "Проведём исследование данных"}, **kwargs)

    def test_health_questions_and_seed_idempotency(self):
        self.assertEqual(self.request("GET", "/health")["status"], "ok")
        self.assertEqual(len(self.request("GET", "/questions")), 7)
        self.assertGreaterEqual(len(self.request("GET", "/tasks?status=draft")), 5)
        tasks = self.request("GET", "/tasks?status=published")
        self.assertGreaterEqual(len(tasks), 5)
        scores = [task["readiness_score"] for task in tasks]
        self.assertTrue(any(score >= 90 for score in scores))
        self.assertTrue(any(40 <= score < 70 for score in scores))
        self.assertTrue(any(score < 40 for score in scores))
        self.assertGreaterEqual(len(self.request("GET", "/teams")), 5)
        proposals = self.request("GET", "/proposals")
        self.assertGreaterEqual(len(proposals), 5)
        self.assertEqual({proposal["status"] for proposal in proposals}, {"pending", "accepted", "rejected"})
        custom = self.create(title="Не перезаписывать пользовательские данные")
        before = self.request("GET", "/tasks")
        subprocess.run([sys.executable, "-m", "backend.app.seed"], cwd=ROOT, env=self.env, check=True, capture_output=True)
        self.assertEqual(before, self.request("GET", "/tasks"))
        self.assertEqual(custom, self.request("GET", f'/tasks/{custom["id"]}'))

    def test_zero_score_publication_and_confirmation_reset(self):
        task = self.create()
        path = f'/tasks/{task["id"]}'
        self.assertEqual(task["readiness_score"], 0)
        self.request("POST", path + "/publish", {"expected_revision": task["revision"]}, expected=409)
        published = self.publish(task)
        self.assertEqual(published["status"], "published")
        # A no-op edit does not invalidate confirmation.
        unchanged = self.request("PATCH", path, {"expected_revision": published["revision"], "title": task["title"]})
        self.assertTrue(unchanged["is_confirmed"])
        edited = self.request("PATCH", path, {"expected_revision": unchanged["revision"], "context": "Новый бизнес-контекст"})
        self.assertFalse(edited["is_confirmed"])
        self.assertEqual(edited["status"], "draft")
        self.assertEqual(edited["readiness_score"], 20)
        self.request("POST", path + "/publish", {"expected_revision": edited["revision"]}, expected=409)
        self.publish(edited)
        rating = self.request("GET", path + "/readiness")
        self.assertEqual(rating["score"], 20)
        self.assertEqual(len(rating["missing"]), 6)
        self.assertIn(task["id"], [item["id"] for item in self.request("GET", "/tasks?status=published")])

    def test_proposal_lifecycle_and_no_automatic_assignment(self):
        task = self.create()
        self.proposal(task, expected=409)
        self.publish(task)
        first = self.proposal(task, expected=201)
        second = self.proposal(task, team_id=2, expected=201)
        self.assertEqual(first["status"], "pending")
        self.proposal(task, expected=409)
        for proposal, status in [(first, "accepted"), (second, "rejected")]:
            path = f'/proposals/{proposal["id"]}/status'
            self.request("PATCH", path, {"status": "wrong"}, expected=422)
            self.assertEqual(self.request("PATCH", path, {"status": status})["status"], status)
            self.request("PATCH", path, {"status": status}, expected=409)
            self.request("PATCH", path, {"status": "pending"}, expected=409)
            if status == "accepted":
                items = self.request("GET", f'/tasks/{task["id"]}/proposals')
                self.assertEqual(next(item for item in items if item["id"] == second["id"])["status"], "pending")
        own = self.request("GET", "/teams/1/proposals")
        self.assertIn(first["id"], [item["id"] for item in own])

    def test_validation_and_not_found(self):
        for path in ["/tasks/999999", "/tasks/999999/readiness", "/teams/999999", "/teams/999999/proposals", "/tasks/999999/proposals"]:
            self.request("GET", path, expected=404)
        self.request("POST", "/tasks", {"title": "  ", "initial_description": "описание"}, expected=422)
        self.request("POST", "/tasks", {"title": "Название", "initial_description": "  "}, expected=422)
        task = self.create()
        self.request("PATCH", f'/tasks/{task["id"]}', {"expected_revision": task["revision"], "context": None}, expected=422)
        self.request("PATCH", f'/tasks/{task["id"]}', {"expected_revision": task["revision"], "status": "published"}, expected=422)
        self.request("POST", f'/tasks/{task["id"]}/proposals', {"team_id": 999999, "message": "test", "proposed_solution": "test"}, expected=404)
        for field in ["message", "proposed_solution"]:
            body = {"team_id": 1, "message": "Сообщение", "proposed_solution": "Решение", field: " \n "}
            self.request("POST", f'/tasks/{task["id"]}/proposals', body, expected=422)
        for path in ["/tasks?status=wrong", "/tasks?readiness_level=wrong", "/tasks?sort=wrong"]:
            self.request("GET", path, expected=422)
        self.request("PATCH", "/proposals/999999/status", {"status": "accepted"}, expected=404)
        self.request("POST", "/tasks/999999/confirm", {"expected_revision": 1}, expected=404)
        self.request("PATCH", "/tasks/999999", {"expected_revision": 1, "title": "Название"}, expected=404)

    def test_sorting_filtering_and_russian_search(self):
        for sort, reverse in [("score_asc", False), ("score_desc", True)]:
            tasks = self.request("GET", f"/tasks?sort={sort}")
            scores = [item["readiness_score"] for item in tasks]
            self.assertEqual(scores, sorted(scores, reverse=reverse))
        for sort, reverse in [("oldest", False), ("newest", True)]:
            tasks = self.request("GET", f"/tasks?sort={sort}")
            dates = [item["created_at"] for item in tasks]
            self.assertEqual(dates, sorted(dates, reverse=reverse))
        query = urlencode({"search": "ОТЗЫВОВ", "status": "published"})
        tasks = self.request("GET", "/tasks?" + query)
        self.assertTrue(tasks)
        self.assertTrue(all(task["status"] == "published" and "отзывов" in (task["title"] + task["initial_description"]).lower() for task in tasks))
        tasks = self.request("GET", "/tasks?" + urlencode({"readiness_level": "Приоритетная"}))
        self.assertTrue(tasks)
        self.assertTrue(all(task["readiness_score"] >= 90 for task in tasks))

    def test_persistence_after_real_server_restart(self):
        task = self.publish(self.create(title="Сохраняется после перезапуска"))
        proposal = self.proposal(task, expected=201)
        proposal = self.request("PATCH", f'/proposals/{proposal["id"]}/status', {"status": "accepted"})
        self.stop_server()
        self.start_server()
        self.assertEqual(task, self.request("GET", f'/tasks/{task["id"]}'))
        self.assertEqual([proposal], self.request("GET", f'/tasks/{task["id"]}/proposals'))


if __name__ == "__main__":
    unittest.main()
