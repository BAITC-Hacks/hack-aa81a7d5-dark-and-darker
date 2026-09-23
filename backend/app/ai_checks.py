"""Local, conservative checks; these do not establish semantic truth."""
from collections import Counter
from decimal import Decimal
from difflib import SequenceMatcher
from itertools import combinations
import re
import unicodedata


def question_tokens(text: str) -> list[str]:
    text = unicodedata.normalize("NFKC", text).casefold().replace("ё", "е")
    text = re.sub(r"^\s*\d+[.)]\s*", "", text)
    return [word for word in re.findall(r"\w+", text) if word not in {"пожалуйста", "please"}]


def repeated_questions(texts: list[str]) -> bool:
    tokens = list(map(question_tokens, texts))
    if any(not any(word.isalpha() for word in question) for question in tokens):
        return True
    for left, right in combinations(tokens, 2):
        if left == right:
            return True
        # Lexical near-duplicates, not a semantic similarity classifier.
        if min(len(left), len(right)) >= 4:
            overlap = len(set(left) & set(right)) / len(set(left) | set(right))
            if overlap >= .85 or SequenceMatcher(None, left, right, autojunk=False).ratio() >= .85:
                return True
    return False


# Space-grouped integers and decimal comma/dot; ambiguous comma thousands,
# spelled numbers, unit conversions and dates are deliberately not equated.
NUMBER = re.compile(r"(?<!\w)[+-]?(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,]\d+)?(?!\w)")
UNKNOWN = re.compile(r"не\s*(?:извест\w*|определ\w*|установ\w*|согласован\w*)|пока\s+нет|уточн\w*\s+позже|не\s+зна\w*|\b(?:unknown|tbd|not determined)\b", re.I)


def number_value(match: re.Match) -> str:
    value = format(Decimal(re.sub(r"\s", "", match[0]).replace(",", ".")), "f")
    return value.rstrip("0").rstrip(".") if "." in value else value


def numbers(text: str) -> Counter:
    return Counter(number_value(match) for match in NUMBER.finditer(text))


def formatting_signature(text: str) -> str:
    # Preserve order, units, negations and punctuation around every number.
    # Equal bags of numbers alone never mean equal requirements.
    def signature(match: re.Match) -> str:
        # 100,000 / 100.000 can mean a decimal or a thousands separator.
        # Never silently choose an interpretation when the notation changes.
        if re.fullmatch(r"[+-]?\d{1,3}[.,]\d{3}", match[0]):
            return f"<ambiguous:{match[0]}>"
        return f"<{number_value(match)}>"
    text = NUMBER.sub(signature, text)
    return " ".join(text.casefold().split())


def check_field(original: str, proposed: str, *, contact: bool = False) -> dict:
    equivalent = formatting_signature(original) == formatting_signature(proposed)
    warnings = []
    if not equivalent:
        if numbers(proposed) - numbers(original):
            warnings.append("AI добавил или изменил числовые значения. Сроки, суммы и объёмы требуют проверки по исходному ответу.")
        if UNKNOWN.search(original):
            warnings.append("В исходном ответе есть неопределённость. AI-редакция не может заменить её подтверждёнными требованиями.")
        if not original.strip() and proposed.strip():
            warnings.append("Исходный ответ пуст: факты из других полей или предположения не перенесены в карточку.")
        if original.strip() and not proposed.strip():
            warnings.append("AI удалил исходные сведения. Исходный ответ сохранён.")
        if contact:
            warnings.append("Контактные сведения сохраняются точно, без автоматической редакции AI.")
    return {"original": original, "proposed": proposed, "requires_review": not equivalent, "warnings": warnings}
