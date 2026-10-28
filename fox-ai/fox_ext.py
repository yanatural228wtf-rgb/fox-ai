"""
Fox AI — серверные расширения.

  • /api/v2/stream   — ответ потоком + запасные модели/провайдеры + характер + память
  • /api/image/*     — генерация картинок (Pollinations, бесплатно)
  • /api/sync/*      — синхронизация чатов между устройствами (нужна DATABASE_URL)
  • /stats           — простая статистика (нужен STATS_KEY)

Подключается из server.py:  import fox_ext; fox_ext.register(globals())
"""

import hashlib
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import OrderedDict, defaultdict
from datetime import date, datetime, timezone

from flask import Response, jsonify, request, stream_with_context

S = {}  # глобальные объекты server.py (app, PROVIDER, функции ...)

# ---------------------------------------------------------------------------
# Настройки
# ---------------------------------------------------------------------------

FALLBACK_BASE_URL = os.getenv("FALLBACK_BASE_URL", "https://openrouter.ai/api/v1").strip().rstrip("/")
FALLBACK_API_KEY = os.getenv("FALLBACK_API_KEY", "").strip()
FALLBACK_MODEL = os.getenv("FALLBACK_MODEL", "openrouter/free").strip()

POLLINATIONS_KEY = os.getenv("POLLINATIONS_KEY", "").strip()
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
STATS_KEY = os.getenv("STATS_KEY", "").strip()

MAX_MEMORY_ITEMS = 30
MAX_MEMORY_CHARS = 200
MAX_SYNC_BYTES = 3 * 1024 * 1024

PERSONA = (
    "Ты — Фокс, ИИ-помощник Fox AI: умная, находчивая и дружелюбная лиса. "
    "Характер: живой, с лёгким юмором и самоиронией, но без клоунады — польза всегда важнее шутки. "
    "Иногда (не в каждом ответе) можешь уместно ввернуть лисью метафору. "
    "Пиши просто и по делу, как умный друг, а не как справочник. Эмодзи — редко или совсем без них. "
    "Отвечай на языке пользователя. Используй Markdown: списки, **жирный**, блоки кода с указанием языка. "
    "Не выдумывай факты; если не знаешь — честно скажи."
)
PERSONA_CREATIVE = " Сейчас творческий режим: больше образности, неожиданных идей и игры словами."
PERSONA_WEB = " У тебя есть результаты веб-поиска: опирайся на них и ссылайся на источники по номерам [1], [2]."
MEMORY_RULE = (
    "\n\nПамять. Если пользователь сообщил о себе устойчивый факт, который пригодится в будущих разговорах "
    "(имя, чем занимается, интересы, цели, предпочтения в ответах), добавь в самом конце ответа отдельной "
    "строкой тег <remember>короткий факт в третьем лице</remember>. Не больше одного тега за ответ. "
    "Не запоминай пароли, адреса, телефоны, документы и другие чувствительные данные. "
    "Не упоминай этот тег и механизм памяти в тексте ответа."
)


def system_prompt(mode, web, profile, memory):
    text = PERSONA
    if mode == "creative":
        text += PERSONA_CREATIVE
    if web:
        text += PERSONA_WEB
    name = (profile or {}).get("name", "").strip()[:60]
    about = (profile or {}).get("about", "").strip()[:300]
    if name and name.lower() not in ("fox user",):
        text += f"\n\nПользователя зовут {name}. Обращайся по имени иногда, не в каждом сообщении."
    if about:
        text += f"\nО себе пользователь написал: {about}"
    if memory:
        facts = "\n".join(f"- {m}" for m in memory)
        text += f"\n\nЧто ты уже знаешь о пользователе:\n{facts}"
    text += MEMORY_RULE
    return text


def clean_memory(raw):
    if not isinstance(raw, list):
        return []
    out = []
    for item in raw[:MAX_MEMORY_ITEMS]:
        if isinstance(item, str) and item.strip():
            out.append(item.strip()[:MAX_MEMORY_CHARS])
    return out


# ---------------------------------------------------------------------------
# Статистика (в памяти, а при наличии БД — ещё и в БД)
# ---------------------------------------------------------------------------

_stats_lock = threading.Lock()
_stats = defaultdict(lambda: defaultdict(int))     # day -> key -> count
_visitors = defaultdict(set)                       # day -> {hash}
_salt = secrets.token_hex(8)


def _today():
    return date.today().isoformat()


def stat(key, n=1):
    day = _today()
    with _stats_lock:
        _stats[day][key] += n
    db_stat(day, key, n)


def visit():
    ip = request.remote_addr or "?"
    ua = (request.headers.get("User-Agent") or "")[:80]
    day = _today()
    vh = hashlib.sha256(f"{_salt}|{day}|{ip}|{ua}".encode()).hexdigest()[:20]
    with _stats_lock:
        new = vh not in _visitors[day]
        _visitors[day].add(vh)
    if new:
        stat("visitors")


# ---------------------------------------------------------------------------
# База данных (Postgres, например бесплатный Neon) — для синхронизации и статистики
# ---------------------------------------------------------------------------

_db_ready = False


def db():
    import psycopg  # импорт только если включена БД
    return psycopg.connect(DATABASE_URL, connect_timeout=8, autocommit=True)


def db_init():
    global _db_ready
    if not DATABASE_URL:
        return
    try:
        with db() as conn:
            conn.execute("""create table if not exists fox_sync (
                code_hash text primary key, data jsonb not null default '{}'::jsonb,
                updated_at timestamptz not null default now())""")
            conn.execute("""create table if not exists fox_stats (
                day date not null, key text not null, value bigint not null default 0,
                primary key (day, key))""")
        _db_ready = True
    except Exception as exc:  # noqa: BLE001
        S["app"].logger.warning("DB init failed: %s", exc)


def db_stat(day, key, n):
    if not _db_ready:
        return

    def work():
        try:
            with db() as conn:
                conn.execute(
                    "insert into fox_stats(day,key,value) values (%s,%s,%s) "
                    "on conflict (day,key) do update set value = fox_stats.value + excluded.value",
                    (day, key, n))
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=work, daemon=True).start()


# ---------------------------------------------------------------------------
# Потоковый ответ с запасными вариантами
# ---------------------------------------------------------------------------

class Retryable(Exception):
    pass


def _open(base_url, api_key, payload):
    req = urllib.request.Request(
        base_url + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key or 'none'}",
            "User-Agent": "FoxAI/1.0",
            "Accept": "text/event-stream",
            "HTTP-Referer": "https://fox-ai.onrender.com",
            "X-Title": "Fox AI",
        },
        method="POST",
    )
    ProviderError = S["ProviderError"]
    try:
        return urllib.request.urlopen(req, timeout=S["PROVIDER_TIMEOUT"])
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:300]
        if exc.code in (429, 500, 502, 503, 504):
            raise Retryable(f"{exc.code}: {body}") from exc
        if exc.code in (401, 403):
            raise ProviderError(f"Провайдер отклонил запрос ({exc.code}). Проверь ключ API.") from exc
        if exc.code == 413:
            raise ProviderError("Запрос слишком большой. Попробуй картинку поменьше или короче текст.") from exc
        raise ProviderError(f"Провайдер не принял запрос ({exc.code}): {body}") from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise Retryable(str(exc)) from exc


def _iter_sse(resp):
    ProviderError = S["ProviderError"]
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
            if choices:
                delta = (choices[0].get("delta") or {}).get("content")
                if delta:
                    yield delta
    finally:
        resp.close()


def candidates(model, has_images):
    """Цепочка (base_url, key, model, label): выбранная модель → другие модели провайдера → запасной провайдер."""
    out = []
    if has_images:
        if S["VISION_MODEL"]:
            out.append((S["OPENAI_BASE_URL"], S["OPENAI_API_KEY"], S["VISION_MODEL"], "main"))
    else:
        out.append((S["OPENAI_BASE_URL"], S["OPENAI_API_KEY"], model, "main"))
        for m in S["available_models"]():
            if m["id"] != model:
                out.append((S["OPENAI_BASE_URL"], S["OPENAI_API_KEY"], m["id"], "sibling"))
    if FALLBACK_API_KEY:
        out.append((FALLBACK_BASE_URL, FALLBACK_API_KEY, FALLBACK_MODEL, "fallback"))
    return out


def stream_with_fallback(messages, system, model, has_images):
    """Возвращает (генератор_текста, использованная_модель)."""
    full = [{"role": "system", "content": system}] + messages
    last_err = None
    for base, key, mid, kind in candidates(model, has_images):
        payload = {"model": mid, "max_tokens": S["MAX_TOKENS"], "stream": True, "messages": full}
        try:
            resp = _open(base, key, payload)
            if kind != "main":
                stat("fallback_used")
            return _iter_sse(resp), mid
        except Retryable as exc:
            last_err = exc
            S["app"].logger.warning("model %s unavailable (%s), trying next", mid, str(exc)[:120])
            continue
    if last_err and "429" in str(last_err):
        raise S["ProviderError"]("Все бесплатные лимиты на сегодня исчерпаны. Попробуй чуть позже.")
    raise S["ProviderError"]("ИИ сейчас недоступен. Попробуй ещё раз через минуту.")


def chat_stream_v2():
    data = request.get_json(silent=True) or {}
    message = (data.get("message") or "").strip()
    history = data.get("history") or []
    mode = data.get("mode") or "normal"
    web = bool(data.get("web"))
    memory = clean_memory(data.get("memory"))
    profile = data.get("profile") if isinstance(data.get("profile"), dict) else {}

    try:
        images = S["parse_images"](data.get("images"))
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if not message and not images:
        return jsonify({"error": "Пустое сообщение."}), 400
    if len(message) > S["MAX_STREAM_CHARS"]:
        return jsonify({"error": f"Сообщение слишком длинное (максимум {S['MAX_STREAM_CHARS']} символов вместе с файлом)."}), 400
    if not message:
        message = "Опиши, что на картинке."

    PROVIDER = S["PROVIDER"]
    _ndjson = S["_ndjson"]
    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}

    if PROVIDER == "demo":
        demo = S["demo_answer"](message, web=web)

        def demo_gen():
            for word in demo["answer"].split(" "):
                yield _ndjson({"d": word + " "})
                time.sleep(0.015)
            yield _ndjson({"done": True, "model": "demo"})

        return Response(stream_with_context(demo_gen()), mimetype="application/x-ndjson", headers=headers)

    if S["rate_limited"]():
        return S["rate_limit_response"]()

    if images and PROVIDER == "openai" and not S["VISION_MODEL"] and not FALLBACK_API_KEY:
        return jsonify({"error": "Картинки не поддерживаются на этом сервере."}), 400

    stat("messages")
    if images:
        stat("vision")

    model = S["resolve_model"](data.get("model"))
    system = system_prompt(mode, web, profile, memory)
    messages = S["build_messages"](history, message)

    results = []
    if web and PROVIDER == "openai":
        stat("web")
        try:
            results = S["web_search"](message)
        except S["ProviderError"] as exc:
            S["app"].logger.warning("web search failed: %s", exc)
        if results:
            context = "\n".join(
                f"[{i}] {r['title']} — {r['snippet']} ({r['url']})" for i, r in enumerate(results, 1))
            messages[-1] = {"role": "user", "content": (
                f"Результаты веб-поиска:\n{context}\n\nВопрос пользователя: {messages[-1]['content']}")}

    messages = S["with_images"](messages, images)

    def gen():
        if results:
            yield _ndjson({"sources": results})
        got = False
        try:
            if PROVIDER == "openai":
                source, used = stream_with_fallback(messages, system, model, bool(images))
            else:
                source, used = S["stream_anthropic"](messages, system, model, web=web), model
            for piece in source:
                got = True
                yield _ndjson({"d": piece})
            if not got:
                yield _ndjson({"d": "Модель вернула пустой ответ. Попробуй переформулировать вопрос."})
            yield _ndjson({"done": True, "model": used})
        except GeneratorExit:
            return
        except Exception as exc:  # noqa: BLE001
            S["log_error"](exc, "stream v2 failed")
            yield _ndjson({"error": S["api_error_message"](exc)})

    return Response(stream_with_context(gen()), mimetype="application/x-ndjson", headers=headers)


# ---------------------------------------------------------------------------
# Картинки (Pollinations)
# ---------------------------------------------------------------------------

_img_cache = OrderedDict()
_img_lock = threading.Lock()
_img_last = [0.0]


def quick_completion(prompt_text, max_tokens=200):
    """Короткий неструимый запрос к самой быстрой модели (для перевода промпта)."""
    if S["PROVIDER"] != "openai":
        return ""
    models = [m["id"] for m in S["available_models"]()]
    order = models[1:] + models[:1]  # сначала «быстрая»
    for mid in order:
        payload = {"model": mid, "max_tokens": max_tokens, "stream": False,
                   "messages": [{"role": "user", "content": prompt_text}]}
        if "gpt-oss" in mid:
            payload["reasoning_effort"] = "low"  # иначе модель тратит все токены на «размышления»
        try:
            resp = _open(S["OPENAI_BASE_URL"], S["OPENAI_API_KEY"], payload)
            data = json.loads(resp.read().decode("utf-8"))
            resp.close()
            text = (data["choices"][0]["message"].get("content") or "").strip().strip('"')
            if text:
                return text
        except Exception:  # noqa: BLE001
            continue
    return ""


def image_prompt():
    data = request.get_json(silent=True) or {}
    text = (data.get("prompt") or "").strip()[:500]
    if not text:
        return jsonify({"error": "Опиши, что нарисовать."}), 400
    if S["rate_limited"]():
        return S["rate_limit_response"]()
    en = quick_completion(
        "Turn this request into one detailed English prompt for an image generator "
        "(subject, style, lighting, composition). Reply with the prompt only, no quotes:\n\n" + text, 700)
    en = (en or text).replace("\n", " ").strip()[:400]
    seed = secrets.randbelow(10_000_000)
    stat("images")
    url = "/api/image/render?" + urllib.parse.urlencode({"p": en, "seed": seed})
    return jsonify({"url": url, "prompt": en})


def image_render():
    p = (request.args.get("p") or "").strip()[:400]
    seed = request.args.get("seed", "1")
    if not p or not seed.isdigit():
        return jsonify({"error": "bad request"}), 400
    key = f"{seed}|{p}"
    with _img_lock:
        if key in _img_cache:
            _img_cache.move_to_end(key)
            body, ctype = _img_cache[key]
            return Response(body, mimetype=ctype, headers={"Cache-Control": "public, max-age=31536000, immutable"})
        wait = 15.5 - (time.time() - _img_last[0]) if not POLLINATIONS_KEY else 0
    if wait > 0:
        return jsonify({"error": "busy", "retry": round(wait, 1)}), 429

    params = {"width": "1024", "height": "1024", "seed": seed, "nologo": "true", "model": "flux"}
    url = "https://image.pollinations.ai/prompt/" + urllib.parse.quote(p) + "?" + urllib.parse.urlencode(params)
    headers = {"User-Agent": "FoxAI/1.0"}
    if POLLINATIONS_KEY:
        headers["Authorization"] = f"Bearer {POLLINATIONS_KEY}"
    with _img_lock:
        _img_last[0] = time.time()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as resp:
            body = resp.read()
            ctype = resp.headers.get("Content-Type", "image/jpeg")
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            return jsonify({"error": "busy", "retry": 15}), 429
        return jsonify({"error": f"Генератор картинок ответил ошибкой ({exc.code})."}), 502
    except Exception:  # noqa: BLE001
        return jsonify({"error": "Генератор картинок недоступен. Попробуй позже."}), 502
    if not ctype.startswith("image/"):
        return jsonify({"error": "Генератор вернул не картинку."}), 502
    with _img_lock:
        _img_cache[key] = (body, ctype)
        while len(_img_cache) > 40:
            _img_cache.popitem(last=False)
    return Response(body, mimetype=ctype, headers={"Cache-Control": "public, max-age=31536000, immutable"})


# ---------------------------------------------------------------------------
# Синхронизация
# ---------------------------------------------------------------------------

ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"


def _hash_code(code):
    norm = "".join(ch for ch in code.upper() if ch in ALPHABET)
    return hashlib.sha256(("fox-sync|" + norm).encode()).hexdigest(), norm


def _sync_guard():
    if not _db_ready:
        return jsonify({"error": "Синхронизация не настроена на сервере."}), 503
    if S["rate_limited"]():
        return S["rate_limit_response"]()
    return None


def sync_create():
    bad = _sync_guard()
    if bad:
        return bad
    raw = "".join(secrets.choice(ALPHABET) for _ in range(16))
    code = "FOX-" + "-".join(raw[i:i + 4] for i in range(0, 16, 4))
    h, _ = _hash_code(code)
    with db() as conn:
        conn.execute("insert into fox_sync(code_hash, data) values (%s, '{}'::jsonb)", (h,))
    return jsonify({"code": code})


def sync_pull():
    bad = _sync_guard()
    if bad:
        return bad
    code = ((request.get_json(silent=True) or {}).get("code") or "").strip()
    h, norm = _hash_code(code)
    if len(norm) != 16:
        return jsonify({"error": "Неверный код."}), 400
    with db() as conn:
        row = conn.execute("select data, updated_at from fox_sync where code_hash=%s", (h,)).fetchone()
    if not row:
        return jsonify({"error": "Код не найден."}), 404
    return jsonify({"data": row[0], "updated_at": row[1].isoformat()})


def sync_push():
    bad = _sync_guard()
    if bad:
        return bad
    if (request.content_length or 0) > MAX_SYNC_BYTES:
        return jsonify({"error": "Слишком много данных для синхронизации."}), 413
    body = request.get_json(silent=True) or {}
    code = (body.get("code") or "").strip()
    data = body.get("data")
    h, norm = _hash_code(code)
    if len(norm) != 16 or not isinstance(data, dict):
        return jsonify({"error": "Неверный запрос."}), 400
    from psycopg.types.json import Jsonb
    with db() as conn:
        cur = conn.execute("update fox_sync set data=%s, updated_at=now() where code_hash=%s", (Jsonb(data), h))
        if cur.rowcount == 0:
            return jsonify({"error": "Код не найден."}), 404
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# Статистика
# ---------------------------------------------------------------------------

def stats_page():
    if not STATS_KEY or request.args.get("key") != STATS_KEY:
        return Response("Not found", 404)
    rows = {}
    if _db_ready:
        try:
            with db() as conn:
                for day, key, value in conn.execute(
                        "select day, key, value from fox_stats where day > current_date - 30 order by day desc"):
                    rows.setdefault(day.isoformat(), {})[key] = value
        except Exception:  # noqa: BLE001
            rows = {}
    if not rows:
        with _stats_lock:
            rows = {d: dict(v) for d, v in sorted(_stats.items(), reverse=True)}
    cols = [("visitors", "Посетители"), ("messages", "Сообщения"), ("images", "Картинки"),
            ("vision", "Фото"), ("web", "Поиск"), ("fallback_used", "Запасной ИИ")]
    head = "".join(f"<th>{t}</th>" for _, t in cols)
    body = "".join(
        "<tr><td>" + d + "</td>" + "".join(f"<td>{v.get(k, 0)}</td>" for k, _ in cols) + "</tr>"
        for d, v in rows.items()) or f"<tr><td colspan='{len(cols) + 1}'>Пока пусто</td></tr>"
    total = {k: sum(v.get(k, 0) for v in rows.values()) for k, _ in cols}
    cards = "".join(f"<div class='c'><b>{total[k]}</b><span>{t}</span></div>" for k, t in cols[:4])
    note = "" if _db_ready else "<p class='n'>Без базы данных статистика сбрасывается при перезапуске сервера.</p>"
    html = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Fox AI — статистика</title>
<style>body{{margin:0;background:#0d0d0f;color:#f5f5f7;font:15px/1.5 system-ui,sans-serif;padding:24px}}
h1{{font-size:22px;margin:0 0 18px}}.g{{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:22px}}
.c{{background:#18181d;border-radius:16px;padding:16px;box-shadow:0 10px 30px rgba(0,0,0,.3)}}
.c b{{display:block;font-size:28px;color:#ff9d42}}.c span{{color:#a1a1aa;font-size:13px}}
table{{width:100%;border-collapse:collapse;background:#141418;border-radius:16px;overflow:hidden}}
th,td{{padding:10px 12px;text-align:right}}th:first-child,td:first-child{{text-align:left}}
th{{color:#a1a1aa;font-weight:600;font-size:13px;background:#1b1b21}}tr:nth-child(even) td{{background:#17171c}}
.n{{color:#a1a1aa;font-size:13px}}</style></head><body><h1>Fox AI — статистика за 30 дней</h1>
<div class="g">{cards}</div><table><tr><th>День</th>{head}</tr>{body}</table>{note}</body></html>"""
    return Response(html, mimetype="text/html")


# ---------------------------------------------------------------------------
# Android-приложение (TWA): подтверждение домена и скачивание APK
# ---------------------------------------------------------------------------

ANDROID_PACKAGE = os.getenv("ANDROID_PACKAGE", "ai.fox.app").strip()
ANDROID_SHA256 = os.getenv(
    "ANDROID_SHA256",
    "80:8D:DE:04:31:F9:9A:E3:B3:4B:BB:83:43:4D:C6:B0:EE:10:BB:2E:31:46:A2:0E:6E:86:C9:20:A2:CA:86:C6",
).strip()


def assetlinks():
    own = os.path.join(os.path.dirname(os.path.abspath(__file__)), "android", "assetlinks.json")
    if os.path.exists(own):
        try:
            return Response(open(own, "rb").read(), mimetype="application/json")
        except Exception:  # noqa: BLE001
            pass
    if "assetlinks.json" in RELAY:
        return Response(RELAY["assetlinks.json"], mimetype="application/json")
    data = [{
        "relation": ["delegate_permission/common.handle_all_urls"],
        "target": {"namespace": "android_app", "package_name": ANDROID_PACKAGE,
                   "sha256_cert_fingerprints": [ANDROID_SHA256]},
    }]
    return Response(json.dumps(data), mimetype="application/json")


# Временная передача собранных файлов (принимаются только файлы с известным SHA-256),
# чтобы GitHub Actions мог забрать их и положить в репозиторий.
RELAY_ALLOWED = {
    "b4b84d78fffed21bc5a12494a534262a20369f7e8fd2db728da30c565b98db70": "FoxAI.apk",
    "c7aeb9b55ebceeec740c58f739bba9fb3030730756382d1f8cd6f55e428f7a94": "assetlinks.json",
}
RELAY = {}


def relay_put():
    import hashlib
    body = request.get_data(cache=False)
    if len(body) > 8 * 1024 * 1024:
        return Response("too big", 413)
    name = RELAY_ALLOWED.get(hashlib.sha256(body).hexdigest())
    if not name:
        return Response("unknown file", 403)
    RELAY[name] = body
    return Response("ok " + name, headers={"Access-Control-Allow-Origin": "*"})


def relay_get(name):
    body = RELAY.get(name)
    if body is None:
        return Response("not here", 404)
    return Response(body, mimetype="application/octet-stream")


def android_apk():
    """Отдаёт APK из архива PWABuilder, лежащего в папке android/."""
    import glob
    import zipfile
    if "FoxAI.apk" in RELAY and not glob.glob(os.path.join(os.path.dirname(os.path.abspath(__file__)), "android", "*.apk")):
        stat("apk_downloads")
        return Response(RELAY["FoxAI.apk"], mimetype="application/vnd.android.package-archive", headers={
            "Content-Disposition": 'attachment; filename="FoxAI.apk"', "Cache-Control": "no-cache"})
    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "android")
    for path in sorted(glob.glob(os.path.join(folder, "*.zip"))) + sorted(glob.glob(os.path.join(folder, "*.apk"))):
        try:
            if path.endswith(".apk"):
                body = open(path, "rb").read()
            else:
                with zipfile.ZipFile(path) as z:
                    names = [n for n in z.namelist() if n.lower().endswith(".apk")]
                    names.sort(key=lambda n: ("signed" not in n.lower(), len(n)))
                    if not names:
                        continue
                    body = z.read(names[0])
            stat("apk_downloads")
            return Response(body, mimetype="application/vnd.android.package-archive", headers={
                "Content-Disposition": 'attachment; filename="FoxAI.apk"', "Cache-Control": "no-cache"})
        except Exception:  # noqa: BLE001
            continue
    return Response("APK ещё не готов.", 404)


# ---------------------------------------------------------------------------
# Регистрация
# ---------------------------------------------------------------------------

def register(g):
    S.update(g)
    app = g["app"]

    app.add_url_rule("/api/v2/stream", "chat_stream_v2", chat_stream_v2, methods=["POST"])
    app.add_url_rule("/api/image/prompt", "image_prompt", image_prompt, methods=["POST"])
    app.add_url_rule("/api/image/render", "image_render", image_render, methods=["GET"])
    app.add_url_rule("/api/sync/create", "sync_create", sync_create, methods=["POST"])
    app.add_url_rule("/api/sync/pull", "sync_pull", sync_pull, methods=["POST"])
    app.add_url_rule("/api/sync/push", "sync_push", sync_push, methods=["POST"])
    app.add_url_rule("/stats", "stats_page", stats_page, methods=["GET"])
    app.add_url_rule("/.well-known/assetlinks.json", "assetlinks", assetlinks, methods=["GET"])
    app.add_url_rule("/download/android", "android_apk", android_apk, methods=["GET"])
    app.add_url_rule("/api/android/relay", "relay_put", relay_put, methods=["POST"])
    app.add_url_rule("/api/android/relay/<name>", "relay_get", relay_get, methods=["GET"])

    @app.before_request
    def _count_visit():
        if request.method == "GET" and request.path == "/":
            visit()

    @app.after_request
    def _features(resp):
        if request.path == "/api/health" and resp.is_json:
            data = resp.get_json()
            data.update({
                "v2": True,
                "images": S["PROVIDER"] != "demo",
                "sync": _db_ready,
                "fallback": bool(FALLBACK_API_KEY),
            })
            resp.set_data(json.dumps(data))
        return resp

    db_init()
