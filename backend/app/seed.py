"""Idempotent demo fixtures; never deletes or overwrites user content."""
import json
from datetime import datetime, timedelta, timezone

from .db import database, initialize_database
from .readiness import CRITERIA, calculate_readiness

BUSINESS_ID = 1


def seed_database():
    initialize_database()
    with database(write=True) as db:
        if db.execute("SELECT 1 FROM seed_runs WHERE name = 'demo-v1'").fetchone():
            return
        db.execute("INSERT OR IGNORE INTO business_users VALUES (?, ?, ?, ?)",
                   (BUSINESS_ID, "Айдана Садыкова", "Sana Business Lab", "business@example.com"))
        tasks = [
            ("Анализ отзывов клиентов", "Помогите сети кофеен понять, что ценят гости и что нужно улучшить.", [
                "Каждый месяц получаем 2 000 отзывов. Ручной разбор занимает у менеджера три дня.",
                "Обезличенные отзывы за 6 месяцев в CSV и список категорий обращений.",
                "Прототип панели с темами отзывов, тональностью и примерами проблем.",
                "Точность определения темы не ниже 80% на 200 размеченных отзывах.",
                "Четыре недели; Python; персональные данные не передаются.",
                "Менеджеры кофеен и руководитель службы качества.", "business@example.com; встреча по пятницам."]),
            ("Прогнозирование спроса", "Спрогнозируйте продажи, чтобы уменьшить списание свежих продуктов.", [
                "В трёх магазинах списывается до 12% свежей продукции. Хотим точнее планировать закупки.",
                "Продажи, остатки и цены за 18 месяцев в таблицах CSV.",
                "Модель недельного спроса и отчёт с ошибками прогноза по категориям.",
                "", "Шесть недель; запуск на обычном ноутбуке.", "Специалисты отдела закупок.", ""]),
            ("Оптимизация доставки", "Найдите способ сократить время планирования ежедневных маршрутов.", [
                "Диспетчер вручную распределяет 80 заказов между восемью курьерами.",
                "Обезличенные адреса, временные окна и маршруты за последний месяц.",
                "Прототип планировщика с картой и выгрузкой маршрутов.", "", "", "", ""]),
            ("Автоматизация обработки заявок", "Ускорьте распределение входящих обращений по отделам.", [
                "Оператор каждый день вручную сортирует входящие заявки из общей почты.",
                "", "", "", "", "Операторы поддержки и руководители отделов.", ""]),
            ("Анализ энергопотребления", "Помогите найти необычные скачки потребления энергии на производстве.", [
                "", "", "", "", "", "", "energy@example.com"]),
        ]
        published_ids = []
        for index, (title, description, answers) in enumerate(tasks):
            timestamp = (datetime.now(timezone.utc) - timedelta(days=5 - index)).isoformat()
            for published in (False, True):
                fields = {item[0]: answers[i] if published else "" for i, item in enumerate(CRITERIA)}
                rating = calculate_readiness(fields)
                values = dict(business_id=BUSINESS_ID,
                              title=title if published else f"Идея: {title.lower()}",
                              initial_description=description, **fields,
                              readiness_score=rating["score"], readiness_level=rating["level"],
                              status="published" if published else "draft", is_confirmed=int(published),
                              created_at=timestamp, updated_at=timestamp)
                cursor = db.execute(f"INSERT INTO tasks ({','.join(values)}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))
                if published:
                    published_ids.append(cursor.lastrowid)
        teams = [
            ("Qadam AI", "Исследуем текстовые данные и превращаем их в понятные бизнесу выводы.", ["Python", "NLP", "React"], 4),
            ("Data Nomads", "Команда аналитиков, которая любит временные ряды и прогнозирование.", ["Python", "ML", "Аналитика"], 3),
            ("Route Lab", "Проектируем алгоритмы и интерфейсы для городской логистики.", ["Оптимизация", "Карты", "TypeScript"], 5),
            ("Sana Code", "Создаём веб-приложения и автоматизируем рутинные процессы.", ["FastAPI", "React", "UX"], 4),
            ("Green Byte", "Работаем с данными датчиков и задачами устойчивого развития.", ["IoT", "Python", "Визуализация"], 3),
        ]
        team_ids = []
        for index, (name, description, skills, count) in enumerate(teams):
            cursor = db.execute("INSERT INTO student_teams (name,description,skills,members_count,contact) VALUES (?,?,?,?,?)",
                                (name, description, json.dumps(skills, ensure_ascii=False), count, f"team{index + 1}@example.com"))
            team_ids.append(cursor.lastrowid)
        plans = [
            "Разметим выборку отзывов, сравним подходы к классификации и покажем темы на панели.",
            "Построим базовый прогноз, проверим его на отложенном периоде и сравним с сезонной моделью.",
            "Сравним текущие маршруты с оптимизированными и подготовим интерактивную карту.",
            "Соберём прототип классификатора обращений с возможностью ручной корректировки.",
            "Начнём с уточнения данных датчиков и согласования критериев обнаружения аномалий.",
        ]
        statuses = ["accepted", "pending", "rejected", "pending", "pending"]
        for i, task_id in enumerate(published_ids):
            db.execute("INSERT INTO proposals (task_id,team_id,message,proposed_solution,status,created_at) VALUES (?,?,?,?,?,?)",
                       (task_id, team_ids[i], "Заинтересованы в проекте. Готовы обсудить детали на первой встрече.", plans[i], statuses[i], datetime.now(timezone.utc).isoformat()))
        for task_id, team_id, status in [(published_ids[0], team_ids[3], "rejected"), (published_ids[1], team_ids[0], "accepted")]:
            db.execute("INSERT INTO proposals (task_id,team_id,message,proposed_solution,status,created_at) VALUES (?,?,?,?,?,?)",
                       (task_id, team_id, "Предлагаем помощь нашей команды в исследовании задачи.", "Проведём интервью, изучим данные и согласуем измеримый результат пилота.", status, datetime.now(timezone.utc).isoformat()))
        db.execute("INSERT INTO seed_runs VALUES ('demo-v1')")


if __name__ == "__main__":
    seed_database()
    print("Демонстрационные данные готовы. Существующие данные сохранены.")
