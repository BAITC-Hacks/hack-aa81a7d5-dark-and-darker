from typing import Literal

from pydantic import ConfigDict, Field, model_validator

from .ai_checks import repeated_questions

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
    model_config = ConfigDict(str_strip_whitespace=False, extra="forbid")
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


class GeneratedQuestionSet(QuestionSet):
    # Apply to newly generated questions only: older stored drafts remain editable.
    @model_validator(mode="after")
    def distinct_wording(self):
        if repeated_questions([item.question for item in self.questions]):
            raise ValueError("Вопросы повторяются или практически совпадают")
        return self


CardField = Literal["title", "initial_description", "context", "materials", "expected_result", "success_criteria", "constraints", "target_users", "business_contact"]


class FieldReview(InputModel):
    model_config = ConfigDict(str_strip_whitespace=False, extra="forbid")
    original: Text
    proposed: Text
    requires_review: bool
    warnings: list[str] = Field(default_factory=list, max_length=10)


class GenerationInfo(InputModel):
    source: Literal["ai", "fallback"]
    reason: str | None = None
    message: str


class QuestionsResult(GenerationInfo, QuestionSet):
    pass


class CardResult(GenerationInfo):
    card: GeneratedCard
    review: dict[CardField, FieldReview] | None = None
