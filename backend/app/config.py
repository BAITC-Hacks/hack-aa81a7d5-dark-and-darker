import os
from functools import lru_cache
from pathlib import Path

from dotenv import dotenv_values
from pydantic import BaseModel, SecretStr

ENV_PATH = Path(__file__).resolve().parents[1] / ".env"


class AISettings(BaseModel):
    api_key: SecretStr = SecretStr("")
    model: str = ""


@lru_cache(maxsize=1)
def get_ai_settings() -> AISettings:
    # An explicitly empty process variable disables AI in automated tests.
    # Load only the backend file, never Vite env files. Do not print its contents.
    values = dotenv_values(ENV_PATH) if not all(key in os.environ for key in ("OPENAI_API_KEY", "OPENAI_MODEL")) else {}
    return AISettings(
        api_key=os.environ.get("OPENAI_API_KEY", values.get("OPENAI_API_KEY") or "").strip(),
        model=os.environ.get("OPENAI_MODEL", values.get("OPENAI_MODEL") or "").strip(),
    )
