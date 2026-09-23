"""Deterministic readiness policy and replaceable local question provider."""

CRITERIA = [
    ("context", "Контекст и потребность", 20, "Какую проблему должен решить проект и почему это важно для бизнеса?"),
    ("materials", "Данные и материалы", 20, "Какие данные, материалы или ресурсы доступны исполнителям?"),
    ("expected_result", "Ожидаемый результат", 15, "Какой конкретный результат вы хотите получить?"),
    ("success_criteria", "Критерии успеха", 15, "По каким критериям будете оценивать успешность решения?"),
    ("constraints", "Ограничения", 10, "Какие существуют ограничения по срокам, технологиям или бюджету?"),
    ("target_users", "Пользователи", 10, "Кто будет использовать результат проекта?"),
    ("business_contact", "Связь с бизнесом", 10, "Как студенческая команда сможет связаться с представителем бизнеса?"),
]
LEVELS = ("Черновик", "Рабочая", "Готовая", "Приоритетная")


def generate_questions() -> list[dict]:
    # Replace this provider later without changing the card or rating API.
    return [dict(field=key, label=label, weight=weight, question=question)
            for key, label, weight, question in CRITERIA]


def calculate_readiness(task: dict) -> dict:
    criteria = [dict(field=key, label=label, maximum=weight,
                     points=weight if str(task.get(key) or "").strip() else 0)
                for key, label, weight, _ in CRITERIA]
    score = sum(item["points"] for item in criteria)
    level = LEVELS[0 if score < 40 else 1 if score < 70 else 2 if score < 90 else 3]
    missing = [item["label"] for item in criteria if not item["points"]]
    return dict(score=score, level=level, criteria=criteria, missing=missing,
                recommendations=[f'Заполните поле «{label}».' for label in missing])
