from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Text = Annotated[str, Field(max_length=10000)]
Title = Annotated[str, Field(min_length=1, max_length=200)]
RequiredText = Annotated[str, Field(min_length=1, max_length=10000)]


class InputModel(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="forbid")


class TaskCreate(InputModel):
    title: Title
    initial_description: RequiredText
    context: Text = ""
    materials: Text = ""
    expected_result: Text = ""
    success_criteria: Text = ""
    constraints: Text = ""
    target_users: Text = ""
    business_contact: Text = ""


class TaskPatch(InputModel):
    title: Title | None = None
    initial_description: RequiredText | None = None
    context: Text | None = None
    materials: Text | None = None
    expected_result: Text | None = None
    success_criteria: Text | None = None
    constraints: Text | None = None
    target_users: Text | None = None
    business_contact: Text | None = None

    @model_validator(mode="after")
    def forbid_explicit_null(self):
        if any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Поля карточки должны содержать текст, а не null")
        return self


class ProposalCreate(InputModel):
    team_id: int = Field(gt=0, strict=True)
    message: RequiredText
    proposed_solution: RequiredText


class ProposalStatus(InputModel):
    status: Literal["pending", "accepted", "rejected"]
