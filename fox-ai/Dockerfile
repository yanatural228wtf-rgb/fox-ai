# Fox AI — образ для любого хостинга с Docker (Hugging Face Spaces, Koyeb, VPS ...)
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HOST=0.0.0.0 \
    PORT=7860

# Не запускаем от root
RUN useradd -m -u 1000 fox
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=fox:fox . .
USER fox

EXPOSE 7860

# 1 процесс + потоки: лимиты по IP хранятся в памяти и должны быть общими.
# timeout больше, чем PROVIDER_TIMEOUT, чтобы долгие ответы не обрывались.
CMD gunicorn server:app --bind 0.0.0.0:${PORT} --workers 1 --threads 8 --timeout 150
