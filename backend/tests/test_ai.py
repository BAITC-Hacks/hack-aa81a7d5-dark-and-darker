"""AI endpoint and SDK contract tests; all OpenAI traffic uses mocks."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import httpx2
from openai import (
    APIConnectionError, APITimeoutError, AuthenticationError, BadRequestError,
    InternalServerError, NotFoundError, OpenAI, PermissionDeniedError, RateLimitError,
)

from backend.app.ai_models import GeneratedCard, GeneratedQuestionSet, QuestionSet
from backend.app.config import AISettings, get_ai_settings
from backend.app.main import app
from backend.app.readiness import CRITERIA, calculate_readiness, generate_questions

IDEA = {"title": "Анализ отзывов кофеен", "initial_description": "Хотим разобраться в отзывах гостей."}
QUESTIONS = [{"field": item["field"], "question": item["question"]} for item in generate_questions()]
ANSWERS = {key: "" for key, *_ in CRITERIA} | {"context": "Разбираем отзывы вручную", "business_contact": "demo@example.com"}
CARD_INPUT = {**IDEA, "questions": QUESTIONS, "answers": ANSWERS}
CARD = {**IDEA, **ANSWERS}


class ConfigTests(unittest.TestCase):
    def tearDown(self):
        get_ai_settings.cache_clear()

    def test_dotenv_loading_process_override_and_secret_repr(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("OPENAI_API_KEY=unit-test-credential\nOPENAI_MODEL=configured-model\n")
            with patch("backend.app.config.ENV_PATH", path), patch.dict(os.environ, {}, clear=True):
                get_ai_settings.cache_clear()
                settings = get_ai_settings()
                self.assertEqual(settings.model, "configured-model")
                self.assertEqual(settings.api_key.get_secret_value(), "unit-test-credential")
                self.assertNotIn("unit-test-credential", repr(settings))
                self.assertNotIn("unit-test-credential", settings.model_dump_json())
            with patch("backend.app.config.ENV_PATH", path), patch.dict(os.environ, {"OPENAI_API_KEY": "", "OPENAI_MODEL": ""}, clear=True):
                get_ai_settings.cache_clear()
                self.assertFalse(get_ai_settings().api_key.get_secret_value())


class AIEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.settings = AISettings(api_key="unit-test-credential", model="configured-model")
        app.dependency_overrides[get_ai_settings] = lambda: self.settings
        self.client = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://test")
        self.constructor = patch("backend.app.ai.OpenAI").start()
        self.sdk = self.constructor.return_value.__enter__.return_value

    async def asyncTearDown(self):
        await self.client.aclose()
        app.dependency_overrides.clear()
        patch.stopall()

    def reply(self, value, status="completed"):
        self.sdk.responses.parse.return_value = SimpleNamespace(status=status, output_parsed=value)

    async def post(self, path, body):
        response = await self.client.post("/api/ai" + path, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("unit-test-credential", response.text)
        return response.json()

    async def test_questions_validated_sorted_and_model_from_settings(self):
        self.reply(GeneratedQuestionSet(questions=list(reversed(QUESTIONS))))
        result = await self.post("/questions", IDEA)
        self.assertEqual(result["source"], "ai")
        self.assertEqual(result["questions"], QUESTIONS)
        self.sdk.responses.parse.assert_called_once()
        request = self.sdk.responses.parse.call_args.kwargs
        self.assertEqual(request["model"], "configured-model")
        self.assertIs(request["text_format"], GeneratedQuestionSet)
        self.assertFalse(request["store"])
        self.assertEqual(json.loads(request["input"]), IDEA)
        self.assertEqual(self.constructor.call_args.kwargs["max_retries"], 0)
        self.assertEqual(self.constructor.call_args.kwargs["timeout"], 45)

    async def test_invalid_question_sets_fall_back(self):
        for value in [None, {"questions": QUESTIONS[:6]}, {"questions": QUESTIONS + [QUESTIONS[0]]},
                      {"questions": [QUESTIONS[0]] * 7},
                      {"questions": [{"field": "unknown", "question": "Вопрос?"}] + QUESTIONS[1:]},
                      {"questions": [{**QUESTIONS[0], "question": "   "}] + QUESTIONS[1:]}]:
            with self.subTest(value=value):
                self.reply(value)
                result = await self.post("/questions", IDEA)
                self.assertEqual(result["source"], "fallback")
                self.assertEqual(result["reason"], "invalid_response")
                self.assertEqual(result["questions"], QUESTIONS)

    async def test_incomplete_response_and_refusal_fall_back(self):
        for status, value in [("incomplete", QuestionSet(questions=QUESTIONS)), ("completed", None)]:
            self.reply(value, status)
            self.assertEqual((await self.post("/questions", IDEA))["reason"], "invalid_response")

    async def test_card_preserves_empty_answers_nonempty_answers_and_contacts(self):
        model_card = {**CARD, "context": "Анализ отзывов сейчас выполняется вручную.",
                      "materials": "Выдуманная база из 100000 записей", "constraints": "Бюджет 100 млн, срок 2 дня",
                      "business_contact": "invented@example.com"}
        self.reply(GeneratedCard(**model_card))
        result = await self.post("/task-card", CARD_INPUT)
        self.assertEqual(result["source"], "ai")
        self.assertEqual(result["card"]["context"], ANSWERS["context"])
        self.assertEqual(result["review"]["context"]["proposed"], model_card["context"])
        self.assertTrue(result["review"]["context"]["requires_review"])
        self.assertEqual(result["review"]["context"]["warnings"], [])
        self.assertEqual(result["card"]["materials"], "")
        self.assertEqual(result["card"]["constraints"], "")
        self.assertEqual(result["card"]["business_contact"], ANSWERS["business_contact"])
        self.assertEqual(calculate_readiness(result["card"])["score"], 30)
        self.assertNotIn("status", result["card"])
        self.assertNotIn("readiness_score", result["card"])
        self.reply(GeneratedCard(**{**CARD, "context": ""}))
        result = await self.post("/task-card", CARD_INPUT)
        self.assertEqual(result["card"]["context"], ANSWERS["context"])

    async def test_duplicate_and_near_duplicate_question_wording_falls_back(self):
        for texts in [
            ["Уточните задачу?"] * 7,
            [f"{index + 1}. УТОЧНИТЕ задачу?!" for index in range(7)],
            ["Какие данные вашей компании нужны для решения этой задачи?"] * 6 + ["Какие данные вашей компании нужны для решения данной задачи?"],
            ["?!"] + [q["question"] for q in QUESTIONS[1:]],
        ]:
            self.reply({"questions": [{**item, "question": text} for item, text in zip(QUESTIONS, texts)]})
            result = await self.post("/questions", IDEA)
            self.assertEqual(result["source"], "fallback")
            self.assertEqual(result["questions"], QUESTIONS)
        # Only one near-duplicate pair is enough; all other questions are valid.
        questions = [dict(item) for item in QUESTIONS]
        questions[0]["question"] = "Какие данные вашей компании нужны для решения этой задачи?"
        questions[1]["question"] = "Какие данные вашей компании нужны для решения данной задачи?"
        self.reply({"questions": questions})
        self.assertEqual((await self.post("/questions", IDEA))["source"], "fallback")

    async def test_individual_questions_with_shared_topic_are_accepted(self):
        texts = [
            "Почему ручной разбор отзывов мешает работе кофеен?",
            "В каком формате доступны отзывы гостей кофеен?",
            "Что команда должна передать вам по итогам анализа отзывов?",
            "Как вы оцените полезность классификации жалоб гостей?",
            "Какие ограничения доступа к отзывам нужно соблюдать?",
            "Кто из сотрудников кофеен будет пользоваться отчётом?",
            "С кем команда сможет обсуждать результаты исследования?",
        ]
        questions = [{**item, "question": text} for item, text in zip(QUESTIONS, texts)]
        self.reply({"questions": questions})
        result = await self.post("/questions", IDEA)
        self.assertEqual(result["source"], "ai")
        self.assertEqual(result["questions"], questions)

    async def test_added_deadlines_budgets_and_unknowns_are_not_applied(self):
        for original, proposed in [
            ("Нужен прототип", "Нужен прототип за 2 недели"),
            ("Есть бюджет", "Бюджет 100000 тенге"),
            ("Сроки и бюджет пока не определены", "Срок разработки — 2 недели. Бюджет — 100000 тенге"),
            ("Срок пока неизвестен", "Завершить к пятнице"),
            ("Срок согласуем", "Завершить за две недели"),
        ]:
            with self.subTest(original=original, proposed=proposed):
                answers = {**ANSWERS, "constraints": original}
                self.reply({**CARD, "constraints": proposed})
                result = await self.post("/task-card", {**CARD_INPUT, "answers": answers})
                self.assertEqual(result["card"]["constraints"], original)
                review = result["review"]["constraints"]
                self.assertEqual(review["original"], original)
                self.assertEqual(review["proposed"], proposed)
                self.assertTrue(review["requires_review"])
                if "100000" in proposed or "2" in proposed:
                    self.assertTrue(any("числовые" in warning for warning in review["warnings"]))
                if "неизвестен" in original or "не определены" in original:
                    self.assertTrue(any("неопределённость" in warning for warning in review["warnings"]))

    async def test_number_formatting_keeps_value_units_and_context(self):
        for original, proposed, safe in [
            ("Бюджет 100 000 тенге", "Бюджет 100000 тенге", True),
            ("Объём 1,50 ГБ", "Объём 1.5 ГБ", True),
            ("Цена 100\u202f000 тенге", "Цена 100000 тенге", True),
            ("Срок 2 дня", "Срок 2 недели", False),
            ("Срок не более 2 недель", "Срок более 2 недель", False),
            ("Срок 2 дня, бюджет 100 тенге", "Срок 100 дней, бюджет 2 тенге", False),
            ("Бюджет 100,000 тенге", "Бюджет 100000 тенге", False),
            ("Бюджет 100,000 тенге", "Бюджет 100 тенге", False),
            ("Бюджет 100.000 тенге", "Бюджет 100,000 тенге", False),
            ("Объём 123456789012345678901234567891", "Объём 123456789012345678901234567892", False),
        ]:
            answers = {**ANSWERS, "constraints": original}
            self.reply({**CARD, "constraints": proposed})
            result = await self.post("/task-card", {**CARD_INPUT, "answers": answers})
            self.assertEqual(result["review"]["constraints"]["requires_review"], not safe, (original, proposed))
            self.assertEqual(result["card"]["constraints"], proposed if safe else original)
            if safe:
                self.assertEqual(result["review"]["constraints"]["warnings"], [])

    async def test_facts_cannot_move_between_fields_or_into_title(self):
        answers = {**ANSWERS, "constraints": "Срок 2 недели", "materials": "Данные уточним"}
        self.reply({**CARD, "constraints": answers["constraints"], "materials": "Данные за 2 недели",
                    "title": "Прототип за 2 недели", "initial_description": "Разработка на Python"})
        result = await self.post("/task-card", {**CARD_INPUT, "answers": answers})
        self.assertEqual(result["card"], {**IDEA, **answers})
        self.assertEqual(set(result["review"]), set(CARD))
        for field in ["materials", "title", "initial_description"]:
            self.assertTrue(result["review"][field]["requires_review"])

    async def test_unchanged_unknown_and_raw_answers_are_preserved(self):
        answers = {**ANSWERS, "constraints": "Сроки пока неизвестны", "context": "  Исходный ответ\nс пробелами  "}
        self.reply({**IDEA, **answers})
        result = await self.post("/task-card", {**CARD_INPUT, "answers": answers})
        self.assertEqual(result["card"]["constraints"], answers["constraints"])
        self.assertFalse(result["review"]["constraints"]["requires_review"])
        self.assertEqual(result["review"]["context"]["original"], answers["context"])

    async def test_invalid_card_and_model_assigned_score_fall_back(self):
        for value in [{"title": "Недостаточная карточка"}, {**CARD, "readiness_score": 100}, {**CARD, "title": ""}]:
            self.reply(value)
            result = await self.post("/task-card", CARD_INPUT)
            self.assertEqual(result["reason"], "invalid_response")
            self.assertEqual(result["card"], CARD)

    async def test_missing_configuration_uses_fallback_without_calling_sdk(self):
        for settings, reason in [(AISettings(), "missing_api_key"), (AISettings(api_key="unit-test-credential"), "missing_model")]:
            self.settings = settings
            self.assertEqual((await self.post("/questions", IDEA))["reason"], reason)
            result = await self.post("/task-card", CARD_INPUT)
            self.assertEqual(result["reason"], reason)
            self.assertEqual(result["card"], CARD)
        self.constructor.assert_not_called()

    async def test_provider_errors_are_safe_and_never_retried(self):
        request = httpx2.Request("POST", "https://api.openai.com/v1/responses")
        cases = [
            (AuthenticationError("unit-test-credential", response=httpx2.Response(401, request=request), body=None), "authentication"),
            (NotFoundError("unit-test-credential", response=httpx2.Response(404, request=request), body=None), "model_unavailable"),
            (PermissionDeniedError("unit-test-credential", response=httpx2.Response(403, request=request), body=None), "model_unavailable"),
            (RateLimitError("unit-test-credential", response=httpx2.Response(429, request=request), body=None), "rate_limit"),
            (APITimeoutError(request=request), "timeout"),
            (APIConnectionError(request=request), "connection"),
            (InternalServerError("unit-test-credential", response=httpx2.Response(500, request=request), body=None), "provider_error"),
            (BadRequestError("unit-test-credential", response=httpx2.Response(400, request=request), body={"code": "model_not_found"}), "model_unavailable"),
            (ValueError("unit-test-credential"), "invalid_response"),
        ]
        for error, reason in cases:
            for path, payload in [("/questions", IDEA), ("/task-card", CARD_INPUT)]:
                with self.subTest(reason=reason, path=path):
                    self.sdk.responses.parse.reset_mock()
                    self.sdk.responses.parse.side_effect = error
                    result = await self.post(path, payload)
                    self.assertEqual(result["source"], "fallback")
                    self.assertEqual(result["reason"], reason)
                    self.sdk.responses.parse.assert_called_once()

    async def test_input_validation_rejects_missing_duplicate_and_extra_fields(self):
        cases = [("/questions", {**IDEA, "title": " "}), ("/questions", {**IDEA, "model": "override"}),
                 ("/task-card", {**CARD_INPUT, "questions": QUESTIONS[:6]}),
                 ("/task-card", {**CARD_INPUT, "questions": [QUESTIONS[0]] * 7}),
                 ("/task-card", {**CARD_INPUT, "answers": {"context": "Неполные ответы"}})]
        for path, payload in cases:
            response = await self.client.post("/api/ai" + path, json=payload)
            self.assertEqual(response.status_code, 422)
        self.constructor.assert_not_called()

    async def test_official_sdk_responses_wire_contract_with_mock_transport(self):
        calls = []

        def handler(request):
            calls.append(json.loads(request.content))
            return httpx2.Response(200, json={
                "id": "resp_unit_test", "object": "response", "created_at": 0,
                "status": "completed", "model": "configured-model",
                "output": [{"id": "msg_unit_test", "type": "message", "role": "assistant", "status": "completed",
                            "content": [{"type": "output_text", "text": json.dumps({"questions": QUESTIONS}), "annotations": []}]}],
            })

        self.constructor.return_value = OpenAI(api_key="unit-test-credential", max_retries=0,
            http_client=httpx2.Client(transport=httpx2.MockTransport(handler)))
        result = await self.post("/questions", IDEA)
        self.assertEqual(result["source"], "ai")
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["text"]["format"]["type"], "json_schema")
        self.assertTrue(calls[0]["text"]["format"]["strict"])


if __name__ == "__main__":
    unittest.main()
