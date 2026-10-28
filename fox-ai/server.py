"""
Fox AI — простой бэкенд на Flask.

Эндпоинты (их ждёт index.html):
  POST /api/chat      {message, mode?, history?}  или multipart с полем file
  POST /api/web-chat  {message, history?}         — ответ с веб-поиском

Ответ: {"answer": "...", "results": [{"title","url","snippet"}]}

Провайдеры (выбираются автоматически по .env):
  1. ANTHROPIC_API_KEY            -> Claude (платно)
  2. OPENAI_BASE_URL (+ MODEL)    -> любой OpenAI-совместимый API:
                                     Ollama (локально, бесплатно), Groq,
                                     OpenRouter, Gemini и т.д.
  3. ничего не задано             -> демо-режим (заглушка)
"""

import base64
import hmac
import json
import os
import threading
import time
import urllib.error
import urllib.request
from collections import defaultdict, deque
from pathlib import Path

from dotenv import load_dotenv
from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()

BASE_DIR = Path(__file__).parent
API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "").strip().rstrip("/")
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "").strip()
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "").strip()
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "2048"))
PORT = int(os.getenv("PORT", "5000"))
# 127.0.0.1 — только твой ПК; 0.0.0.0 — доступно из сети (на хостинге/в Docker)
HOST = os.getenv("HOST", "127.0.0.1")

# --- Защита при публичном доступе -------------------------------------
# Лимиты на один IP-адрес, чтобы чужие люди не сожгли твои бесплатные лимиты.
RATE_PER_MIN = int(os.getenv("RATE_PER_MIN", "10"))
RATE_PER_DAY = int(os.getenv("RATE_PER_DAY", "150"))
# Если задан — сайт спросит логин/пароль (логин любой).
ACCESS_PASSWORD = os.getenv("ACCESS_PASSWORD", "").strip()
MAX_MESSAGE_CHARS = int(os.getenv("MAX_MESSAGE_CHARS", "8000"))
MAX_HISTORY_ITEM_CHARS = 6000
PROVIDER_TIMEOUT = int(os.getenv("PROVIDER_TIMEOUT", "120"))

# --- Модели -------------------------------------------------------------
# Дополнительные модели для выбора в настройках (через запятую).
_default_extra = "openai/gpt-oss-20b" if "groq.com" in OPENAI_BASE_URL else ""
EXTRA_MODELS = [m.strip() for m in os.getenv("EXTRA_MODELS", _default_extra).split(",") if m.strip()]
# Модель, которая понимает картинки (для Groq — qwen/qwen3.8-27b).
_default_vision = "qwen/qwen3.8-27b" if "groq.com" in OPENAI_BASE_URL else ""
VISION_MODEL = os.getenv("VISION_MODEL", _default_vision).strip()
MAX_IMAGES = 3
MAX_STREAM_CHARS = int(os.getenv("MAX_STREAM_CHARS", "70000"))

if API_KEY:
    PROVIDER = "anthropic"
    MODEL = os.getenv("ANTHROPIC_MODEL", "claude-sonnet-5-5")
elif OPENAI_BASE_URL and OPENAI_MODEL:
    PROVIDER = "openai"
    MODEL = OPENAI_MODEL
else:
    PROVIDER = "demo"
    MODEL = "demo"


class ProviderError(Exception):
    """Ошибка провайдера с готовым текстом для пользователя."""

MAX_FILE_BYTES = 2 * 1024 * 1024  # как и во фронтенде
MAX_FILE_CHARS = 60_000           # чтобы не раздувать запрос
ALLOWED_EXT = {"txt", "md", "json", "py", "js", "html", "css", "csv"}

SYSTEM_BASE = (
    "Ты Fox AI — дружелюбный и полезный помощник. "
    "Отвечай на языке пользователя. Используй Markdown: списки, **жирный**, "
    "блоки кода с указанием языка. Не выдумывай факты; если не знаешь — так и скажи."
)
SYSTEM_CREATIVE = (
    SYSTEM_BASE
    + " Сейчас включён творческий режим: отвечай живее, образнее и интереснее, "
    "но оставайся полезным и точным."
)
SYSTEM_WEB = (
    SYSTEM_BASE
    + " У тебя есть веб-поиск: используй его для актуальной информации "
    "и опирайся на найденные источники."
)

client = None
if PROVIDER == "anthropic":
    import anthropic

    client = anthropic.Anthropic(api_key=API_KEY)

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = 14 * 1024 * 1024  # картинки в /api/stream

# На хостинге приложение стоит за прокси — берём настоящий IP посетителя
# из X-Forwarded-For (нужно для лимитов по IP).
if os.getenv("TRUST_PROXY", "1") == "1":
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1)


# --------------------------------------------------------------------------
# Защита: пароль и лимиты
# --------------------------------------------------------------------------

PUBLIC_PATHS = ("/api/health", "/manifest.webmanifest", "/sw.js", "/icons/")


@app.before_request
def require_password():
    if not ACCESS_PASSWORD or request.path.startswith(PUBLIC_PATHS):
        return None

    header = request.headers.get("Authorization", "")
    if header.startswith("Basic "):
        try:
            decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
            password = decoded.split(":", 1)[1] if ":" in decoded else ""
        except (ValueError, UnicodeError):
            password = ""
        if hmac.compare_digest(password.encode(), ACCESS_PASSWORD.encode()):
            return None

    return Response(
        "Нужен пароль.", 401,
        {"WWW-Authenticate": 'Basic realm="Fox AI", charset="UTF-8"'},
    )


_rate_lock = threading.Lock()
_rate_hits = defaultdict(deque)  # ip -> времена запросов за последние сутки


def rate_limited():
    """True, если IP превысил лимит. Хранится в памяти процесса."""
    if RATE_PER_MIN <= 0 and RATE_PER_DAY <= 0:
        return False

    ip = request.remote_addr or "unknown"
    now = time.time()

    with _rate_lock:
        hits = _rate_hits[ip]
        while hits and now - hits[0] > 86400:
            hits.popleft()

        last_minute = sum(1 for t in hits if now - t < 60)
        if (RATE_PER_MIN > 0 and last_minute >= RATE_PER_MIN) or (
            RATE_PER_DAY > 0 and len(hits) >= RATE_PER_DAY
        ):
            return True

        hits.append(now)

        # изредка чистим старые IP, чтобы память не росла
        if len(_rate_hits) > 5000:
            for key in [k for k, v in _rate_hits.items() if not v or now - v[-1] > 86400]:
                del _rate_hits[key]

    return False


def rate_limit_response():
    return jsonify({
        "error": "Слишком много сообщений. Подожди минуту и попробуй снова."
    }), 429


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    return resp


# --------------------------------------------------------------------------
# Вспомогательные функции
# --------------------------------------------------------------------------

def clean_history(raw):
    """Оставляет только валидные реплики user/assistant и чередует роли."""
    if not isinstance(raw, list):
        return []

    cleaned = []
    for item in raw[-20:]:
        if not isinstance(item, dict):
            continue
        role = item.get("role")
        content = item.get("content")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        content = content.strip()[:MAX_HISTORY_ITEM_CHARS]
        if not content:
            continue
        # API требует чередования ролей — склеиваем подряд идущие одинаковые
        if cleaned and cleaned[-1]["role"] == role:
            cleaned[-1]["content"] += "\n\n" + content
        else:
            cleaned.append({"role": role, "content": content})

    # Диалог должен начинаться с user
    while cleaned and cleaned[0]["role"] != "user":
        cleaned.pop(0)

    return cleaned


def build_messages(history, user_text):
    messages = clean_history(history)

    # Новый вопрос — это всегда user; если история закончилась на user,
    # склеиваем, чтобы не нарушить чередование.
    if messages and messages[-1]["role"] == "user":
        messages[-1]["content"] += "\n\n" + user_text
    else:
        messages.append({"role": "user", "content": user_text})

    return messages


def read_uploaded_file(storage):
    """Читает текстовый файл из multipart-запроса. Возвращает (name, text)."""
    name = storage.filename or "file"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""

    if ext not in ALLOWED_EXT:
        raise ValueError("Этот тип файла не поддерживается.")

    data = storage.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("Файл слишком большой. Максимум 2 МБ.")

    text = data.decode("utf-8", errors="replace")
    if len(text) > MAX_FILE_CHARS:
        text = text[:MAX_FILE_CHARS] + "\n…[файл обрезан]"

    return name, text


def extract_answer(response):
    """Собирает текст ответа и список источников из ответа API."""
    parts = []
    results = []
    seen = set()

    for block in response.content:
        btype = getattr(block, "type", "")

        if btype == "text":
            parts.append(block.text)

            for citation in getattr(block, "citations", None) or []:
                url = getattr(citation, "url", None)
                if url and url not in seen:
                    seen.add(url)
                    results.append({
                        "title": getattr(citation, "title", None) or url,
                        "url": url,
                        "snippet": (getattr(citation, "cited_text", "") or "")[:160],
                    })

        elif btype == "web_search_tool_result":
            content = block.content
            if isinstance(content, list):  # при ошибке тут один объект
                for item in content:
                    url = getattr(item, "url", None)
                    if url and url not in seen:
                        seen.add(url)
                        results.append({
                            "title": getattr(item, "title", None) or url,
                            "url": url,
                            "snippet": "",
                        })

    answer = "".join(parts).strip()
    return answer, results[:6]


def api_error_message(exc):
    """Человекочитаемая ошибка для фронта."""
    if isinstance(exc, ProviderError):
        return str(exc)

    if PROVIDER == "anthropic":
        import anthropic

        if isinstance(exc, anthropic.AuthenticationError):
            return "Неверный API-ключ. Проверь ANTHROPIC_API_KEY в файле .env."
        if isinstance(exc, anthropic.RateLimitError):
            return "Слишком много запросов. Подожди немного и попробуй снова."
        if isinstance(exc, anthropic.APIConnectionError):
            return "Не удалось связаться с API. Проверь интернет."
        if isinstance(exc, anthropic.BadRequestError):
            return f"Запрос отклонён API: {exc.message}"
        if isinstance(exc, anthropic.APIStatusError):
            return f"Ошибка API ({exc.status_code})."

    return "Внутренняя ошибка сервера."


def log_error(exc, label):
    """Ожидаемые ошибки провайдера — одной строкой, остальные — с трассировкой."""
    if isinstance(exc, ProviderError):
        app.logger.warning("%s: %s", label, exc)
    else:
        app.logger.exception(label)


def demo_answer(text, web=False):
    preview = text.strip().replace("\n", " ")[:120]
    answer = (
        "**Демо-режим.** Сервер работает, но ИИ-провайдер не настроен.\n\n"
        f"Ты написал: «{preview}»\n\n"
        "Как подключить настоящий ИИ (есть бесплатные варианты):\n"
        "1. Создай файл `.env` рядом с `server.py` (копия `.env.example`)\n"
        "2. Выбери провайдера и впиши его настройки — Ollama работает локально без ключа\n"
        "3. Перезапусти сервер\n\n"
        "Подробности — в `README.md`."
    )
    results = []
    if web:
        results = [{
            "title": "Пример источника (демо)",
            "url": "https://example.com",
            "snippet": "В реальном режиме здесь будут найденные страницы.",
        }]
    return {"answer": answer, "results": results}


# --------------------------------------------------------------------------
# Провайдер: OpenAI-совместимый API (Ollama, Groq, OpenRouter, Gemini ...)
# --------------------------------------------------------------------------

def ask_openai_compatible(messages, system):
    payload = {
        "model": OPENAI_MODEL,
        "max_tokens": MAX_TOKENS,
        "messages": [{"role": "system", "content": system}] + messages,
    }
    req = urllib.request.Request(
        OPENAI_BASE_URL + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY or 'none'}",
            # Cloudflare (Groq и др.) блокирует стандартный "Python-urllib" (ошибка 1010)
            "User-Agent": "FoxAI/1.0",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=PROVIDER_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:300]
        if exc.code in (401, 403):
            raise ProviderError(
                "Провайдер отклонил запрос: неверный ключ или сервис недоступен "
                f"в твоём регионе. Проверь OPENAI_API_KEY. ({exc.code}: {body[:200]})"
            ) from exc
        if exc.code == 429:
            raise ProviderError(
                "Достигнут лимит бесплатных запросов. Подожди немного или попробуй позже."
            ) from exc
        if exc.code == 404:
            raise ProviderError(
                f"Модель или адрес не найдены. Проверь OPENAI_MODEL ({OPENAI_MODEL}) "
                f"и OPENAI_BASE_URL. Ответ сервера: {body}"
            ) from exc
        raise ProviderError(f"Ошибка провайдера ({exc.code}): {body}") from exc
    except urllib.error.URLError as exc:
        raise ProviderError(
            f"Не удалось подключиться к {OPENAI_BASE_URL}. "
            "Если это Ollama — он запущен?"
        ) from exc
    except TimeoutError as exc:
        raise ProviderError("Провайдер слишком долго отвечает. Попробуй ещё раз.") from exc

    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ProviderError("Провайдер вернул неожиданный ответ.") from exc

    return (text or "").strip()


def web_search(query):
    """Бесплатный веб-поиск через DuckDuckGo (пакет ddgs) для не-Claude провайдеров."""
    try:
        from ddgs import DDGS
    except ImportError as exc:
        raise ProviderError(
            "Для веб-поиска установи пакет: pip install ddgs"
        ) from exc

    try:
        hits = DDGS().text(query[:200], max_results=5)
    except Exception as exc:  # noqa: BLE001
        raise ProviderError("Веб-поиск сейчас недоступен. Попробуй позже.") from exc

    results = []
    for hit in hits or []:
        url = hit.get("href") or hit.get("url")
        if not url:
            continue
        results.append({
            "title": hit.get("title") or url,
            "url": url,
            "snippet": (hit.get("body") or "")[:200],
        })
    return results


def ask_model(messages, system, web=False, query=""):
    if PROVIDER == "openai":
        results = []

        if web:
            try:
                results = web_search(query)
            except ProviderError as exc:
                # Поиск упал (например, DuckDuckGo ограничил IP хостинга) —
                # отвечаем без поиска, а не ошибкой.
                app.logger.warning("web search failed: %s", exc)
                results = []
            if results:
                context = "\n".join(
                    f"[{i}] {r['title']} — {r['snippet']} ({r['url']})"
                    for i, r in enumerate(results, 1)
                )
                last = messages[-1]["content"]
                messages = messages[:-1] + [{
                    "role": "user",
                    "content": (
                        f"Результаты веб-поиска:\n{context}\n\n"
                        f"Вопрос пользователя: {last}\n\n"
                        "Ответь, опираясь на эти результаты, и ссылайся на "
                        "источники по номерам [1], [2]."
                    ),
                }]

        answer = ask_openai_compatible(messages, system)
        if not answer:
            answer = "Модель вернула пустой ответ. Попробуй переформулировать вопрос."
        return {"answer": answer, "results": results}

    # --- Claude (Anthropic API) ---
    kwargs = dict(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=messages,
    )
    if web:
        kwargs["tools"] = [{
            "type": "web_search_20250305",
            "name": "web_search",
            "max_uses": 3,
        }]

    response = client.messages.create(**kwargs)
    answer, results = extract_answer(response)

    if not answer:
        answer = "Модель вернула пустой ответ. Попробуй переформулировать вопрос."

    return {"answer": answer, "results": results}


# --------------------------------------------------------------------------
# Маршруты
# --------------------------------------------------------------------------

@app.get("/")
def index():
    resp = send_from_directory(BASE_DIR, "index.html")
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/manifest.webmanifest")
def manifest():
    resp = send_from_directory(BASE_DIR, "manifest.webmanifest")
    resp.headers["Content-Type"] = "application/manifest+json"
    return resp


@app.get("/sw.js")
def service_worker():
    resp = send_from_directory(BASE_DIR, "sw.js")
    resp.headers["Content-Type"] = "application/javascript"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/icons/<path:name>")
def icons(name):
    resp = send_from_directory(BASE_DIR / "icons", name)
    resp.headers["Cache-Control"] = "public, max-age=604800"
    return resp


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "demo": PROVIDER == "demo",
        "provider": PROVIDER,
        "model": MODEL,
        "models": available_models(),
        "vision": PROVIDER == "anthropic" or bool(VISION_MODEL) or PROVIDER == "demo",
        "stream": True,
    })


@app.post("/api/chat")
def chat():
    file_info = None

    if request.files.get("file"):
        # multipart: message + file (+ mode, history как строки)
        message = (request.form.get("message") or "").strip()
        mode = request.form.get("mode") or "normal"
        try:
            history = json.loads(request.form.get("history") or "[]")
        except json.JSONDecodeError:
            history = []
        try:
            file_info = read_uploaded_file(request.files["file"])
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
    else:
        data = request.get_json(silent=True) or {}
        message = (data.get("message") or "").strip()
        mode = data.get("mode") or "normal"
        history = data.get("history") or []

    if not message and not file_info:
        return jsonify({"error": "Пустое сообщение."}), 400
    if len(message) > MAX_MESSAGE_CHARS:
        return jsonify({"error": f"Сообщение слишком длинное (максимум {MAX_MESSAGE_CHARS} символов)."}), 400
    if PROVIDER != "demo" and rate_limited():
        return rate_limit_response()

    user_text = message or "Проанализируй прикреплённый файл."
    if file_info:
        name, text = file_info
        user_text += f"\n\nВложенный файл «{name}»:\n```\n{text}\n```"

    if PROVIDER == "demo":
        return jsonify(demo_answer(user_text))

    system = SYSTEM_CREATIVE if mode == "creative" else SYSTEM_BASE

    try:
        return jsonify(ask_model(build_messages(history, user_text), system))
    except Exception as exc:  # noqa: BLE001
        log_error(exc, "chat failed")
        return jsonify({"error": api_error_message(exc)}), 502


@app.post("/api/web-chat")
def web_chat():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []

    if not message:
        return jsonify({"error": "Пустое сообщение."}), 400
    if len(message) > MAX_MESSAGE_CHARS:
        return jsonify({"error": f"Сообщение слишком длинное (максимум {MAX_MESSAGE_CHARS} символов)."}), 400

    if PROVIDER == "demo":
        return jsonify(demo_answer(message, web=True))

    if rate_limited():
        return rate_limit_response()

    try:
        return jsonify(
            ask_model(
                build_messages(history, message),
                SYSTEM_WEB,
                web=True,
                query=message,
            )
        )
    except Exception as exc:  # noqa: BLE001
        log_error(exc, "web chat failed")
        return jsonify({"error": api_error_message(exc)}), 502


# --------------------------------------------------------------------------
# Потоковый ответ (текст печатается по мере генерации), выбор модели, картинки
# --------------------------------------------------------------------------

def available_models():
    """Список моделей для выбора в настройках."""
    if PROVIDER == "openai":
        ids = [OPENAI_MODEL] + [m for m in EXTRA_MODELS if m != OPENAI_MODEL]
    else:
        ids = [MODEL]
    out = []
    for i, mid in enumerate(ids):
        if i == 0:
            label = "Умная"
        elif "20b" in mid or "mini" in mid or "instant" in mid or "8b" in mid:
            label = "Быстрая"
        else:
            label = mid.split("/")[-1]
        out.append({"id": mid, "label": label})
    return out


def resolve_model(requested):
    allowed = [m["id"] for m in available_models()]
    return requested if requested in allowed else allowed[0]


def _openai_open(payload):
    """Открывает запрос к OpenAI-совместимому API, ошибки — в ProviderError."""
    req = urllib.request.Request(
        OPENAI_BASE_URL + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {OPENAI_API_KEY or 'none'}",
            "User-Agent": "FoxAI/1.0",
            "Accept": "text/event-stream",
        },
        method="POST",
    )
    try:
        return urllib.request.urlopen(req, timeout=PROVIDER_TIMEOUT)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:300]
        if exc.code in (401, 403):
            raise ProviderError(f"Провайдер отклонил запрос ({exc.code}). Проверь OPENAI_API_KEY.") from exc
        if exc.code == 429:
            raise ProviderError("Достигнут лимит бесплатных запросов. Подожди немного или попробуй позже.") from exc
        if exc.code == 413:
            raise ProviderError("Запрос слишком большой. Попробуй картинку поменьше или короче текст.") from exc
        if exc.code in (400, 404):
            raise ProviderError(f"Провайдер не принял запрос ({exc.code}): {body}") from exc
        raise ProviderError(f"Ошибка провайдера ({exc.code}): {body}") from exc
    except urllib.error.URLError as exc:
        raise ProviderError(f"Не удалось подключиться к {OPENAI_BASE_URL}.") from exc
    except TimeoutError as exc:
        raise ProviderError("Провайдер слишком долго отвечает. Попробуй ещё раз.") from exc


def stream_openai(messages, system, model):
    payload = {
        "model": model,
        "max_tokens": MAX_TOKENS,
        "stream": True,
        "messages": [{"role": "system", "content": system}] + messages,
    }
    resp = _openai_open(payload)
    try:
        for raw in resp:
            line = raw.decode("utf-8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue
            if chunk.get("error"):
                raise ProviderError(str(chunk["error"].get("message", chunk["error"]))[:300])
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = (choices[0].get("delta") or {}).get("content")
            if delta:
                yield delta
    finally:
        resp.close()


def stream_anthropic(messages, system, model, web=False):
    kwargs = dict(model=model, max_tokens=MAX_TOKENS, system=system, messages=messages)
    if web:
        kwargs["tools"] = [{"type": "web_search_20250305", "name": "web_search", "max_uses": 3}]
    with client.messages.stream(**kwargs) as stream:
        for text in stream.text_stream:
            yield text


def parse_images(raw):
    """Принимает список data:image/...;base64 строк от фронта."""
    if not isinstance(raw, list) or not raw:
        return []
    if len(raw) > MAX_IMAGES:
        raise ValueError(f"Можно прикрепить не больше {MAX_IMAGES} картинок.")
    images = []
    for item in raw:
        if not isinstance(item, str) or not item.startswith("data:image/") or ";base64," not in item:
            raise ValueError("Картинка в неверном формате.")
        if len(item) > 6 * 1024 * 1024:
            raise ValueError("Картинка слишком большая.")
        images.append(item)
    return images


def with_images(messages, images):
    """Добавляет картинки к последнему сообщению пользователя."""
    if not images:
        return messages
    last = messages[-1]
    if PROVIDER == "anthropic":
        parts = []
        for url in images:
            media, b64 = url[5:].split(";base64,", 1)
            parts.append({"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}})
        parts.append({"type": "text", "text": last["content"]})
    else:
        parts = [{"type": "text", "text": last["content"]}]
        parts += [{"type": "image_url", "image_url": {"url": url}} for url in images]
    return messages[:-1] + [{"role": "user", "content": parts}]


def _ndjson(obj):
    return json.dumps(obj, ensure_ascii=False) + "\n"


@app.post("/api/stream")
def chat_stream():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    mode = data.get("mode") or "normal"
    web = bool(data.get("web"))

    try:
        images = parse_images(data.get("images"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not message and not images:
        return jsonify({"error": "Пустое сообщение."}), 400
    if len(message) > MAX_STREAM_CHARS:
        return jsonify({"error": f"Сообщение слишком длинное (максимум {MAX_STREAM_CHARS} символов вместе с файлом)."}), 400
    if not message:
        message = "Опиши, что на картинке."

    if PROVIDER == "demo":
        demo = demo_answer(message, web=web)

        def demo_gen():
            if demo["results"]:
                yield _ndjson({"sources": demo["results"]})
            for word in demo["answer"].split(" "):
                yield _ndjson({"d": word + " "})
                time.sleep(0.02)
            yield _ndjson({"done": True, "model": "demo"})

        return Response(stream_with_context(demo_gen()), mimetype="application/x-ndjson",
                        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    if rate_limited():
        return rate_limit_response()

    if images and PROVIDER == "openai" and not VISION_MODEL:
        return jsonify({"error": "Картинки не поддерживаются: не задана VISION_MODEL."}), 400

    model = resolve_model(data.get("model"))
    if images and PROVIDER == "openai":
        model = VISION_MODEL

    system = SYSTEM_WEB if web else (SYSTEM_CREATIVE if mode == "creative" else SYSTEM_BASE)
    messages = build_messages(history, message)

    results = []
    if web and PROVIDER == "openai":
        try:
            results = web_search(message)
        except ProviderError as exc:
            app.logger.warning("web search failed: %s", exc)
        if results:
            context = "\n".join(
                f"[{i}] {r['title']} — {r['snippet']} ({r['url']})" for i, r in enumerate(results, 1)
            )
            messages[-1] = {
                "role": "user",
                "content": (
                    f"Результаты веб-поиска:\n{context}\n\nВопрос пользователя: {messages[-1]['content']}\n\n"
                    "Ответь, опираясь на эти результаты, и ссылайся на источники по номерам [1], [2]."
                ),
            }

    messages = with_images(messages, images)

    def gen():
        if results:
            yield _ndjson({"sources": results})
        got = False
        try:
            source = (stream_openai(messages, system, model) if PROVIDER == "openai"
                      else stream_anthropic(messages, system, model, web=web))
            for piece in source:
                got = True
                yield _ndjson({"d": piece})
            if not got:
                yield _ndjson({"d": "Модель вернула пустой ответ. Попробуй переформулировать вопрос."})
            yield _ndjson({"done": True, "model": model})
        except Exception as exc:  # noqa: BLE001
            log_error(exc, "stream failed")
            yield _ndjson({"error": api_error_message(exc)})

    return Response(stream_with_context(gen()), mimetype="application/x-ndjson",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/fox-extra.js")
def fox_extra_js():
    resp = send_from_directory(BASE_DIR, "fox-extra.js")
    resp.headers["Content-Type"] = "application/javascript; charset=utf-8"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/fox-extra.css")
def fox_extra_css():
    resp = send_from_directory(BASE_DIR, "fox-extra.css")
    resp.headers["Content-Type"] = "text/css; charset=utf-8"
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.errorhandler(413)
def too_large(_):
    return jsonify({"error": "Слишком большой запрос. Файл — до 2 МБ, картинки — поменьше."}), 413


if __name__ == "__main__":
    mode = "ДЕМО (провайдер не настроен)" if PROVIDER == "demo" else f"{PROVIDER}, модель {MODEL}"
    print(f"Fox AI: http://localhost:{PORT}  —  {mode}")
    # Для локального запуска. На хостинге сервер запускается через gunicorn
    # (см. Dockerfile / render.yaml).
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
