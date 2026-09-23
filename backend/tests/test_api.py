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
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from backend.app.readiness import CRITERIA, calculate_readiness

ROOT = Path(__file__).resolve().parents[2]


class ReadinessTests(unittest.TestCase):
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

    def publish(self, task):
        self.request("POST", f'/tasks/{task["id"]}/confirm')
        return self.request("POST", f'/tasks/{task["id"]}/publish')

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
        self.request("POST", path + "/publish", expected=409)
        self.assertEqual(self.publish(task)["status"], "published")
        # A no-op edit does not invalidate confirmation.
        unchanged = self.request("PATCH", path, {"title": task["title"]})
        self.assertTrue(unchanged["is_confirmed"])
        edited = self.request("PATCH", path, {"context": "Новый бизнес-контекст"})
        self.assertFalse(edited["is_confirmed"])
        self.assertEqual(edited["status"], "draft")
        self.assertEqual(edited["readiness_score"], 20)
        self.request("POST", path + "/publish", expected=409)
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
        self.request("PATCH", f'/tasks/{task["id"]}', {"context": None}, expected=422)
        self.request("PATCH", f'/tasks/{task["id"]}', {"status": "published"}, expected=422)
        self.request("POST", f'/tasks/{task["id"]}/proposals', {"team_id": 999999, "message": "test", "proposed_solution": "test"}, expected=404)
        for field in ["message", "proposed_solution"]:
            body = {"team_id": 1, "message": "Сообщение", "proposed_solution": "Решение", field: " \n "}
            self.request("POST", f'/tasks/{task["id"]}/proposals', body, expected=422)
        for path in ["/tasks?status=wrong", "/tasks?readiness_level=wrong", "/tasks?sort=wrong"]:
            self.request("GET", path, expected=422)
        self.request("PATCH", "/proposals/999999/status", {"status": "accepted"}, expected=404)
        self.request("POST", "/tasks/999999/confirm", expected=404)
        self.request("PATCH", "/tasks/999999", {"title": "Название"}, expected=404)

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
