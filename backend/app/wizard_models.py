from uuid import UUID

from pydantic import ConfigDict, Field

from .ai_models import Answers, CardField, FieldReview, GenerationInfo, QuestionSet
from .models import InputModel, TaskCreate, TaskVersion, Text


class DraftFields(TaskCreate):
    model_config = ConfigDict(str_strip_whitespace=False, extra="forbid")
    title: str = Field(max_length=200)
    initial_description: Text


class RawAnswers(Answers):
    model_config = ConfigDict(str_strip_whitespace=False, extra="forbid")


class WizardState(InputModel):
    step: int = Field(ge=1, le=4, strict=True)
    fields: DraftFields
    originalIdea: DraftFields
    answers: RawAnswers
    questionSet: QuestionSet
    hasQuestions: bool
    hasCard: bool
    questionsIdea: str = Field(max_length=25000)
    questionInfo: GenerationInfo | None = None
    cardInfo: GenerationInfo | None = None
    cardReview: dict[CardField, FieldReview] | None = None


class WizardCreate(InputModel):
    client_id: UUID
    state: WizardState


class WizardSave(TaskVersion):
    operation_id: UUID | None = None
    state: WizardState
