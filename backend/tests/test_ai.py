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

from backend.app.ai_models import GeneratedCard, QuestionSet
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
        self.reply(QuestionSet(questions=list(reversed(QUESTIONS))))
        result = await self.post("/questions", IDEA)
        self.assertEqual(result["source"], "ai")
        self.assertEqual(result["questions"], QUESTIONS)
        self.sdk.responses.parse.assert_called_once()
        request = self.sdk.responses.parse.call_args.kwargs
        self.assertEqual(request["model"], "configured-model")
        self.assertIs(request["text_format"], QuestionSet)
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
        self.assertEqual(result["card"]["context"], model_card["context"])
        self.assertEqual(result["card"]["materials"], "")
        self.assertEqual(result["card"]["constraints"], "")
        self.assertEqual(result["card"]["business_contact"], ANSWERS["business_contact"])
        self.assertEqual(calculate_readiness(result["card"])["score"], 30)
        self.assertNotIn("status", result["card"])
        self.assertNotIn("readiness_score", result["card"])
        self.reply(GeneratedCard(**{**CARD, "context": ""}))
        result = await self.post("/task-card", CARD_INPUT)
        self.assertEqual(result["card"]["context"], ANSWERS["context"])

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
