from typing import Literal

from pydantic import Field, model_validator

from .models import InputModel, RequiredText, Text, Title
from .readiness import CRITERIA

CriterionField = Literal["context", "materials", "expected_result", "success_criteria", "constraints", "target_users", "business_contact"]


class QuestionInput(InputModel):
    title: Title
    initial_description: RequiredText


class AIQuestion(InputModel):
    field: CriterionField
    question: str = Field(min_length=1, max_length=1500)


class QuestionSet(InputModel):
    questions: list[AIQuestion] = Field(min_length=7, max_length=7)

    @model_validator(mode="after")
    def every_criterion_once(self):
        if {item.field for item in self.questions} != {item[0] for item in CRITERIA}:
            raise ValueError("Нужен ровно один вопрос по каждому из семи критериев")
        return self


class Answers(InputModel):
    context: Text
    materials: Text
    expected_result: Text
    success_criteria: Text
    constraints: Text
    target_users: Text
    business_contact: Text


class CardInput(QuestionInput, QuestionSet):
    answers: Answers


class GeneratedCard(QuestionInput, Answers):
    """All nine fields are required in the model's JSON; no rating/status fields."""


class GenerationInfo(InputModel):
    source: Literal["ai", "fallback"]
    reason: str | None = None
    message: str


class QuestionsResult(GenerationInfo, QuestionSet):
    pass


class CardResult(GenerationInfo):
    card: GeneratedCard
