/* =========================================================
   Fox AI — расширения интерфейса (v2)
   • ответ потоком, кнопка «Стоп», редактирование сообщений
   • характер лисы и память о пользователе
   • вложения: текст, код, PDF, картинки; генерация картинок
   • голосовой ввод и озвучка; блоки кода с подсветкой
   • выбор модели; поиск по чатам; экспорт; «Поделиться»
   • синхронизация между устройствами (если включена на сервере)
   • мобильные панели
   Подключается после основного скрипта и переопределяет sendMessage.
========================================================== */
(() => {
    "use strict";

    const $ = (sel, root = document) => root.querySelector(sel);
    const store = {
        get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим */ } },
        json(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
        setJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* полно */ } },
    };
    const toast = (msg) => (typeof showToast === "function" ? showToast(msg) : console.log(msg));
    const esc = (s) => (typeof escapeHtml === "function" ? escapeHtml(s) : String(s));
    const icon = (name) => '<i class="ph-fill ph-' + name + '"></i>';

    let server = { models: [], vision: false, images: false, sync: false };

    /* ---------------------------------------------------------
       Ленивая загрузка библиотек
    --------------------------------------------------------- */
    const loaded = {};
    function loadScript(src) {
        if (!loaded[src]) {
            loaded[src] = new Promise((resolve, reject) => {
                const s = document.createElement("script");
                s.src = src;
                s.async = true;
                s.onload = resolve;
                s.onerror = () => reject(new Error("Не удалось загрузить " + src));
                document.head.appendChild(s);
            });
        }
        return loaded[src];
    }
    const HLJS = "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js";
    const PDFJS = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

    /* ---------------------------------------------------------
       Память о пользователе
    --------------------------------------------------------- */
    const memory = {
        list() { return store.json("fox_memory", []); },
        enabled() { return store.get("fox_memory_on", "1") === "1"; },
        add(fact) {
            fact = String(fact || "").replace(/\s+/g, " ").trim().slice(0, 200);
            if (!fact) return false;
            const items = memory.list();
            if (items.some((x) => x.toLowerCase() === fact.toLowerCase())) return false;
            items.push(fact);
            store.setJson("fox_memory", items.slice(-30));
            renderMemoryUI();
            sync.schedule();
            return true;
        },
        remove(i) {
            const items = memory.list();
            items.splice(i, 1);
            store.setJson("fox_memory", items);
            renderMemoryUI();
            sync.schedule();
        },
    };

    const REMEMBER_RE = /<remember>([\s\S]*?)<\/remember>/gi;
    const visibleText = (t) => String(t).replace(/<remember>[\s\S]*?(<\/remember>|$)/gi, "").replace(/<\/?remember>?$/i, "").trimEnd();

    /* ---------------------------------------------------------
       Markdown: блоки кода и сгенерированные картинки
    --------------------------------------------------------- */
    const baseRender = window.renderMarkdown;
    const GEN_RE = /!\[([^\]\n]{0,400})\]\((\/api\/image\/render\?[^)\s]+)\)/g;

    window.renderMarkdown = function (text) {
        let src = visibleText(text ?? "");
        if ((src.match(/```/g) || []).length % 2 === 1) src += "\n```";

        const gens = [];
        src = src.replace(GEN_RE, (m, alt, url) => {
            gens.push({ alt, url });
            return "\u0002GEN" + (gens.length - 1) + "\u0002";
        });

        const langs = [];
        src.replace(/```([^\n]*)\n?[\s\S]*?```/g, (m, lang) => {
            langs.push((lang || "").trim().split(/\s+/)[0].toLowerCase());
            return m;
        });

        let k = 0;
        return baseRender(src)
            .replace(/<div class="code-wrap"><pre><code>/g, () => {
                const lang = (langs[k++] || "").replace(/[^\w+#.-]/g, "");
                return '<div class="code-wrap fox-code"><div class="code-head">' +
                    '<span class="code-lang">' + icon("code") + (lang || "код") + "</span>" +
                    '<button type="button" class="fox-copy-code">' + icon("copy") + "<span>Копировать</span></button>" +
                    "</div><pre><code" + (lang ? ' data-lang="' + lang + '"' : "") + ">";
            })
            .replace(/<\/code><\/pre><button class="copy-code">Копировать<\/button><\/div>/g, "</code></pre></div>")
            .replace(/\u0002GEN(\d+)\u0002/g, (m, i) => {
                const g = gens[i];
                return '<figure class="fox-gen" data-src="' + esc(g.url) + '" data-alt="' + esc(g.alt) + '">' +
                    '<div class="fox-gen-frame"><div class="fox-gen-wait">' + icon("paint-brush") + "<span>Рисую…</span></div></div>" +
                    '<figcaption><span>' + esc(g.alt) + "</span>" +
                    '<button type="button" class="fox-gen-dl" title="Скачать">' + icon("download-simple") + "</button></figcaption></figure>";
            });
    };

    function highlightIn(root) {
        if (!window.hljs || !root) return;
        root.querySelectorAll(".fox-code pre code:not(.hljs)").forEach((el) => {
            if (el.closest(".streaming")) return;
            const lang = el.dataset.lang;
            if (lang && window.hljs.getLanguage(lang)) el.classList.add("language-" + lang);
            try { window.hljs.highlightElement(el); } catch { /* не страшно */ }
        });
    }

    /* Загрузка сгенерированных картинок (сервер может попросить подождать) */
    function loadGenerated(root) {
        root.querySelectorAll(".fox-gen:not([data-state])").forEach(async (fig) => {
            fig.dataset.state = "loading";
            const frame = fig.querySelector(".fox-gen-frame");
            for (let attempt = 0; attempt < 12; attempt++) {
                try {
                    const res = await fetch(fig.dataset.src);
                    if (res.status === 429) {
                        const j = await res.json().catch(() => ({}));
                        await new Promise((r) => setTimeout(r, Math.max(2, j.retry || 8) * 1000));
                        continue;
                    }
                    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Ошибка " + res.status);
                    const blob = await res.blob();
                    const img = new Image();
                    img.alt = fig.dataset.alt || "";
                    img.src = URL.createObjectURL(blob);
                    fig.dataset.blob = img.src;
                    await img.decode().catch(() => {});
                    frame.innerHTML = "";
                    frame.appendChild(img);
                    fig.dataset.state = "done";
                    return;
                } catch (e) {
                    frame.innerHTML = '<div class="fox-gen-wait err">' + icon("warning-circle") + "<span>" + esc(e.message || "Не получилось") + "</span></div>";
                    fig.dataset.state = "error";
                    return;
                }
            }
            frame.innerHTML = '<div class="fox-gen-wait err">' + icon("hourglass") + "<span>Генератор занят, попробуй позже</span></div>";
            fig.dataset.state = "error";
        });
    }

    document.addEventListener("click", async (e) => {
        const copyBtn = e.target.closest(".fox-copy-code");
        if (copyBtn) {
            const code = copyBtn.closest(".fox-code")?.querySelector("pre code")?.innerText || "";
            try {
                await navigator.clipboard.writeText(code);
                copyBtn.classList.add("done");
                copyBtn.innerHTML = icon("check") + "<span>Скопировано</span>";
                setTimeout(() => {
                    copyBtn.classList.remove("done");
                    copyBtn.innerHTML = icon("copy") + "<span>Копировать</span>";
                }, 1600);
            } catch { toast("Не удалось скопировать код."); }
            return;
        }
        const dl = e.target.closest(".fox-gen-dl");
        if (dl) {
            const fig = dl.closest(".fox-gen");
            if (!fig?.dataset.blob) return toast("Картинка ещё рисуется.");
            const a = document.createElement("a");
            a.href = fig.dataset.blob;
            a.download = "fox-ai-" + Date.now() + ".jpg";
            a.click();
        }
    });

    /* ---------------------------------------------------------
       Озвучка
    --------------------------------------------------------- */
    let speakingBtn = null;

    function stopSpeaking() {
        try { speechSynthesis.cancel(); } catch { /* нет поддержки */ }
        if (speakingBtn) speakingBtn.innerHTML = icon("speaker-high");
        speakingBtn?.classList.remove("active");
        speakingBtn = null;
    }

    function pickVoice(lang) {
        const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
        return voices.find((v) => /google|microsoft|natural|online|siri|milena|yuri/i.test(v.name)) || voices[0] || null;
    }

    function bubbleText(msgEl) {
        const bubble = msgEl?.querySelector(".bubble");
        if (!bubble) return "";
        const clone = bubble.cloneNode(true);
        clone.querySelectorAll(".fox-code, .code-wrap").forEach((n) => n.replaceWith(" (пример кода) "));
        clone.querySelectorAll(".fox-gen").forEach((n) => n.replaceWith(" (картинка) "));
        return clone.innerText.replace(/\s+/g, " ").trim();
    }

    function speak(btn) {
        if (!("speechSynthesis" in window)) return toast("Озвучка не поддерживается этим браузером.");
        if (speakingBtn === btn) return stopSpeaking();
        stopSpeaking();
        const text = bubbleText(btn.closest(".message"));
        if (!text) return;

        const lang = /[а-яё]/i.test(text) ? "ru" : "en";
        const voice = pickVoice(lang);
        const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) || [text];
        const chunks = [];
        let cur = "";
        for (const p of parts) {
            if ((cur + p).length > 220 && cur) { chunks.push(cur); cur = ""; }
            cur += p;
        }
        if (cur) chunks.push(cur);

        speakingBtn = btn;
        btn.classList.add("active");
        btn.innerHTML = icon("stop-circle");
        chunks.forEach((chunk, i) => {
            const u = new SpeechSynthesisUtterance(chunk);
            u.lang = lang === "ru" ? "ru-RU" : "en-US";
            if (voice) u.voice = voice;
            u.rate = 1.03;
            if (i === chunks.length - 1) u.onend = () => { if (speakingBtn === btn) stopSpeaking(); };
            speechSynthesis.speak(u);
        });
    }
    if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();

    async function share(btn) {
        const text = bubbleText(btn.closest(".message"));
        if (!text) return;
        const payload = { title: "Fox AI", text: text + "\n\n— Fox AI · " + location.origin };
        try {
            if (navigator.share) { await navigator.share(payload); return; }
            await navigator.clipboard.writeText(payload.text);
            toast("Ответ скопирован — можно вставить куда угодно.");
        } catch (e) {
            if (e?.name !== "AbortError") toast("Не удалось поделиться.");
        }
    }

    /* ---------------------------------------------------------
       Кнопки у сообщений
    --------------------------------------------------------- */
    function decorateMessages(root) {
        root.querySelectorAll(".message.assistant .message-actions").forEach((actions) => {
            if (actions.dataset.fox) return;
            actions.dataset.fox = "1";
            const sp = document.createElement("button");
            sp.className = "fox-speak";
            sp.title = "Озвучить";
            sp.innerHTML = icon("speaker-high");
            sp.addEventListener("click", () => speak(sp));
            const sh = document.createElement("button");
            sh.className = "fox-share";
            sh.title = "Поделиться";
            sh.innerHTML = icon("share-network");
            sh.addEventListener("click", () => share(sh));
            actions.append(sp, sh);
        });
        root.querySelectorAll(".message.user .message-body").forEach((body) => {
            if (body.querySelector(".fox-user-actions")) return;
            const row = document.createElement("div");
            row.className = "fox-user-actions";
            row.innerHTML = '<button type="button" class="fox-edit" title="Изменить">' + icon("pencil-simple") + "</button>";
            row.firstChild.addEventListener("click", () => editMessage(body.closest(".message")));
            body.appendChild(row);
        });
        loadGenerated(root);
    }

    function messageIndex(msgEl) {
        const all = [...document.querySelectorAll("#messagesInner > .message")].filter((m) => !m.querySelector(".typing"));
        return all.indexOf(msgEl);
    }

    function editMessage(msgEl) {
        if (isSending) return toast("Подожди, пока Фокс допишет ответ.");
        const chat = getCurrentChat();
        const idx = messageIndex(msgEl);
        if (!chat || idx < 0 || chat.messages[idx]?.role !== "user") return;
        const text = chat.messages[idx].content;
        chat.messages = chat.messages.slice(0, idx);
        chat.updatedAt = Date.now();
        saveChats();
        renderCurrentChat();
        renderHistory();
        const input = $("#messageInput");
        input.value = text;
        autoResize();
        input.focus();
        toast("Исправь сообщение и отправь заново.");
    }

    /* ---------------------------------------------------------
       Голосовой ввод
    --------------------------------------------------------- */
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let rec = null;

    function toggleMic(btn) {
        if (!SR) return toast("Голосовой ввод работает в Chrome, Edge и Safari.");
        if (rec) { rec.stop(); return; }

        const input = $("#messageInput");
        const base = input.value ? input.value.replace(/\s*$/, " ") : "";
        rec = new SR();
        rec.lang = store.get("fox_language", "ru") === "en" ? "en-US" : "ru-RU";
        rec.interimResults = true;
        rec.continuous = true;

        let finalText = "";
        rec.onresult = (e) => {
            let interim = "";
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) finalText += t; else interim += t;
            }
            input.value = base + finalText + interim;
            autoResize();
        };
        rec.onerror = (e) => {
            if (e.error === "not-allowed") toast("Разреши доступ к микрофону в настройках браузера.");
            else if (e.error !== "aborted" && e.error !== "no-speech") toast("Микрофон: " + e.error);
        };
        rec.onend = () => {
            rec = null;
            btn.classList.remove("recording");
            btn.innerHTML = icon("microphone");
            input.focus();
        };
        try {
            rec.start();
            btn.classList.add("recording");
            btn.innerHTML = icon("stop-circle");
        } catch { rec = null; }
    }

    /* ---------------------------------------------------------
       Вложения
    --------------------------------------------------------- */
    const TEXT_EXT = ["txt", "md", "json", "py", "js", "ts", "tsx", "jsx", "html", "css", "csv", "xml",
        "yml", "yaml", "log", "java", "c", "cpp", "h", "cs", "go", "rs", "php", "rb", "sql", "sh", "ini", "toml", "kt", "swift"];
    const MAX_TEXT_CHARS = 60000;
    let attachments = [];

    function kindOf(file) {
        const ext = (file.name.split(".").pop() || "").toLowerCase();
        if (file.type.startsWith("image/")) return "image";
        if (ext === "pdf" || file.type === "application/pdf") return "pdf";
        if (TEXT_EXT.includes(ext) || file.type.startsWith("text/")) return "text";
        return null;
    }

    function renderChip() {
        const chip = $("#attachedFile");
        const name = $("#attachedFileName");
        if (!chip || !name) return;
        if (!attachments.length) { chip.classList.remove("visible"); return; }
        const icons = { image: "image", pdf: "file-pdf", text: "file-text" };
        name.innerHTML = attachments.map((a) =>
            '<span class="fox-att">' +
            (a.kind === "image" && a.preview ? '<img src="' + a.preview + '" alt="">' : icon(icons[a.kind])) +
            "<span>" + esc(a.file.name) + "</span></span>").join("");
        chip.classList.add("visible");
    }

    function setupFileInput() {
        const old = $("#fileInput");
        if (!old) return;
        const input = old.cloneNode(false);
        input.accept = "image/*,.pdf," + TEXT_EXT.map((e) => "." + e).join(",");
        input.multiple = true;
        old.replaceWith(input);

        input.addEventListener("change", () => {
            const files = [...(input.files || [])];
            input.value = "";
            for (const file of files) {
                const kind = kindOf(file);
                if (!kind) { toast("«" + file.name + "»: такой тип файла не поддерживается."); continue; }
                if (kind === "image") {
                    if (!server.vision) { toast("Картинки пока не поддерживаются на сервере."); continue; }
                    if (attachments.filter((a) => a.kind === "image").length >= 3) { toast("Можно не больше 3 картинок."); continue; }
                    if (file.size > 15 * 1024 * 1024) { toast("Картинка слишком большая (до 15 МБ)."); continue; }
                } else if (kind === "pdf" && file.size > 15 * 1024 * 1024) {
                    toast("PDF слишком большой (до 15 МБ)."); continue;
                } else if (kind === "text" && file.size > 2 * 1024 * 1024) {
                    toast("Файл слишком большой (до 2 МБ)."); continue;
                }
                const item = { file, kind };
                if (kind === "image") item.preview = URL.createObjectURL(file);
                attachments.push(item);
            }
            attachedFile = attachments[0]?.file || null;
            renderChip();
            if (attachments.length) toast(attachments.length === 1 ? "Файл прикреплён." : "Файлы прикреплены: " + attachments.length);
        });

        const removeBtn = $("#attachedFile button");
        if (removeBtn) removeBtn.innerHTML = icon("x");
    }

    const baseRemove = window.removeAttachedFile;
    window.removeAttachedFile = function () {
        attachments = [];
        try { baseRemove(); } catch { /* элемент мог смениться */ }
        attachedFile = null;
        renderChip();
    };

    function readText(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(String(r.result || ""));
            r.onerror = () => reject(new Error("Не удалось прочитать " + file.name));
            r.readAsText(file);
        });
    }

    async function readPdf(file) {
        await loadScript(PDFJS);
        const lib = window.pdfjsLib;
        lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
        const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
        let out = "";
        const pages = Math.min(pdf.numPages, 60);
        for (let p = 1; p <= pages && out.length < MAX_TEXT_CHARS; p++) {
            const page = await pdf.getPage(p);
            const content = await page.getTextContent();
            out += content.items.map((i) => i.str).join(" ").replace(/\s+/g, " ") + "\n\n";
        }
        if (!out.trim()) throw new Error("В «" + file.name + "» нет текста (похоже на скан). Пришли его как картинку.");
        return out;
    }

    async function imageToDataUrl(file) {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/jpeg", 0.85);
    }

    async function prepareAttachments(files) {
        let extra = "";
        const images = [];
        for (const a of files) {
            if (a.kind === "image") { images.push(await imageToDataUrl(a.file)); continue; }
            let text = a.kind === "pdf" ? await readPdf(a.file) : await readText(a.file);
            if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n…[файл обрезан]";
            extra += "\n\nВложенный файл «" + a.file.name + "»:\n```\n" + text + "\n```";
        }
        return { extra, images };
    }

    /* ---------------------------------------------------------
       Модель
    --------------------------------------------------------- */
    function currentModel() {
        const saved = store.get("fox_model", "");
        return server.models.find((m) => m.id === saved) ? saved : (server.models[0]?.id || "");
    }
    function modelLabel() { return server.models.find((m) => m.id === currentModel())?.label || "Модель"; }
    const modelIcon = (label) => (/Быстр/.test(label) ? "lightning" : "brain");

    function setModel(id) {
        store.set("fox_model", id);
        renderModelUI();
        toast("Модель: " + modelLabel());
    }

    function renderModelUI() {
        const chip = $("#foxModelChip");
        if (chip) {
            chip.hidden = server.models.length < 2;
            chip.innerHTML = icon(modelIcon(modelLabel())) + "<span>" + esc(modelLabel()) + "</span>";
        }
        const seg = $("#foxModelSeg");
        if (seg) {
            seg.innerHTML = server.models.map((m) =>
                '<button type="button" data-model="' + esc(m.id) + '" class="' + (m.id === currentModel() ? "active" : "") + '">' +
                icon(modelIcon(m.label)) + esc(m.label) + "</button>").join("");
        }
    }

    /* ---------------------------------------------------------
       Настройки: модель и память
    --------------------------------------------------------- */
    function renderMemoryUI() {
        const box = $("#foxMemoryList");
        if (!box) return;
        const items = memory.list();
        box.innerHTML = items.length
            ? items.map((m, i) => '<div class="fox-mem-item"><span>' + esc(m) + '</span><button type="button" data-del="' + i + '" title="Забыть">' + icon("x") + "</button></div>").join("")
            : '<div class="fox-mem-empty">Пока ничего. Расскажи Фоксу о себе — он запомнит важное.</div>';
        const sw = $("#foxMemorySwitch");
        if (sw) sw.classList.toggle("on", memory.enabled());
    }

    function setupSettings() {
        const body = $("#settingsModal .modal-body");
        if (!body || $("#foxModelSeg")) return;
        const wrap = document.createElement("div");
        wrap.innerHTML =
            '<div class="input-label">Модель ИИ</div>' +
            '<div class="setting-row fox-model-row"><div class="setting-copy">' +
            '<div class="setting-title">Как думать</div>' +
            '<div class="setting-description">«Умная» лучше рассуждает, «Быстрая» отвечает почти мгновенно.</div>' +
            '</div><div class="fox-seg" id="foxModelSeg"></div></div>' +
            '<div class="input-label">Память</div>' +
            '<div class="setting-row"><div class="setting-copy">' +
            '<div class="setting-title">Запоминать факты обо мне</div>' +
            '<div class="setting-description">Фокс запоминает важное (как тебя зовут, чем занимаешься) и учитывает в ответах. Хранится только у тебя.</div>' +
            '</div><button type="button" class="fox-switch" id="foxMemorySwitch" aria-label="Память"></button></div>' +
            '<div class="fox-mem-list" id="foxMemoryList"></div>';
        body.prepend(...wrap.childNodes);
        body.addEventListener("click", (e) => {
            const b = e.target.closest("#foxModelSeg button");
            if (b) return setModel(b.dataset.model);
            const del = e.target.closest("[data-del]");
            if (del) return memory.remove(+del.dataset.del);
            if (e.target.closest("#foxMemorySwitch")) {
                store.set("fox_memory_on", memory.enabled() ? "0" : "1");
                renderMemoryUI();
            }
        });
        renderModelUI();
        renderMemoryUI();
    }

    /* ---------------------------------------------------------
       Генерация картинок
    --------------------------------------------------------- */
    let drawMode = false;
    const DRAW_RE = /^\s*(\/img\b|\/draw\b|нарисуй|нарисовать|сгенерируй\s+(картинку|изображение|фото|арт)|создай\s+(картинку|изображение)|draw\b|generate an image)/i;

    function setDrawMode(on) {
        drawMode = on;
        $(".fox-draw")?.classList.toggle("active", on);
        const input = $("#messageInput");
        if (input) input.placeholder = on ? "Опиши картинку — Фокс нарисует…" : (input.dataset.ph || input.placeholder);
    }

    /* ---------------------------------------------------------
       Отправка: поток, «Стоп», память, картинки
    --------------------------------------------------------- */
    let controller = null;

    function nearBottom() {
        const box = $("#messages");
        return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    }
    function stickBottom() {
        const box = $("#messages");
        if (box) box.scrollTop = box.scrollHeight;
    }

    function setSendState(sending) {
        const btn = $("#sendBtn");
        if (!btn) return;
        btn.disabled = false;
        btn.classList.toggle("fox-stop", sending);
        btn.title = sending ? "Остановить" : "Отправить";
        btn.innerHTML = sending ? icon("stop") : icon("paper-plane-tilt");
    }

    function finishUI() {
        const current = getCurrentChat();
        $("#pageTitle").textContent = current?.title || "Чат";
        const count = $("#panelMessagesCount");
        if (count) count.textContent = current?.messages?.length || 0;
        const web = $("#panelWebStatus");
        if (web) web.textContent = currentMode === "web" ? "Использован" : "Готов";
    }

    function touchChat() {
        const chat = getCurrentChat();
        if (chat) chat.updatedAt = Date.now();
    }

    async function generateImage(prompt, typing) {
        const res = await fetch("/api/image/prompt", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Не получилось нарисовать.");
        typing.remove();
        const alt = (data.prompt || prompt).replace(/[\]\n]/g, " ").slice(0, 300);
        const content = "Готово! Вот что получилось:\n\n![" + alt + "](" + data.url + ")";
        const el = addMessageToDOM("assistant", content);
        decorateMessages(el.parentElement || document);
        saveCurrentMessage("assistant", content);
        touchChat();
        saveChats();
        finishUI();
        scrollToBottom();
    }

    window.sendMessage = async function () {
        if (isSending) return; // остановка — только кнопкой «Стоп»

        const input = $("#messageInput");
        const message = input.value.trim();
        if (!message && !attachments.length) return;

        if (rec) rec.stop();
        stopSpeaking();

        if (!getCurrentChat()) {
            const created = createChatObject();
            chats.unshift(created);
            currentChatId = created.id;
        }
        $("#welcomeScreen")?.remove();

        const files = attachments.slice();
        const fileNames = files.map((a) => a.file.name).join(", ") || null;
        const wantsImage = server.images && !files.length && (drawMode || DRAW_RE.test(message));
        const displayed = message || (files.some((a) => a.kind === "image") ? "Что на картинке?" : "Проанализируй прикреплённый файл.");

        const userEl = addMessageToDOM("user", displayed, { file: fileNames });
        const thumbs = files.filter((a) => a.kind === "image" && a.preview);
        if (thumbs.length && userEl) {
            const row = document.createElement("div");
            row.className = "fox-thumbs";
            thumbs.forEach((a) => { const img = new Image(); img.src = a.preview; row.appendChild(img); });
            userEl.querySelector(".bubble")?.after(row);
        }
        saveCurrentMessage("user", displayed, { file: fileNames });
        touchChat();

        input.value = "";
        autoResize();

        const typing = addTyping();
        isSending = true;
        controller = new AbortController();
        setSendState(true);
        scrollToBottom();

        let msgEl = null;
        let bubble = null;
        let acc = "";
        let sources = null;
        let frame = 0;
        let aborted = false;

        const paint = () => {
            frame = 0;
            if (!bubble) return;
            const stick = nearBottom();
            bubble.innerHTML = renderMarkdown(acc) + '<span class="fox-caret"></span>';
            if (stick) stickBottom();
        };

        try {
            if (wantsImage) {
                setDrawMode(false);
                await generateImage(message.replace(DRAW_RE, "").trim() || message, typing);
                return;
            }

            const history = (getCurrentChat()?.messages || []).slice(0, -1).slice(-20)
                .map((m) => ({ role: m.role, content: visibleText(m.content) }));
            const { extra, images } = files.length ? await prepareAttachments(files) : { extra: "", images: [] };

            const res = await fetch(server.v2 ? "/api/v2/stream" : "/api/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    message: displayed + extra,
                    mode: currentMode,
                    web: currentMode === "web",
                    history,
                    model: currentModel(),
                    images,
                    memory: memory.enabled() ? memory.list() : [],
                    profile: { name: profile?.name || "", about: profile?.about || "" },
                }),
            });

            if (!res.ok || !res.body) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || "Ошибка сервера (" + res.status + ").");
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            let streamError = null;

            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let nl;
                    while ((nl = buffer.indexOf("\n")) >= 0) {
                        const line = buffer.slice(0, nl).trim();
                        buffer = buffer.slice(nl + 1);
                        if (!line) continue;
                        let ev;
                        try { ev = JSON.parse(line); } catch { continue; }
                        if (ev.sources) sources = ev.sources;
                        if (ev.error) streamError = ev.error;
                        if (ev.d) {
                            acc += ev.d;
                            if (!msgEl) {
                                typing.remove();
                                msgEl = addMessageToDOM("assistant", "");
                                msgEl.classList.add("is-streaming");
                                bubble = msgEl.querySelector(".bubble");
                                bubble.classList.add("streaming");
                            }
                            if (!frame) frame = requestAnimationFrame(paint);
                        }
                    }
                }
            } catch (e) {
                if (e.name === "AbortError") aborted = true; else throw e;
            }

            if (streamError && !acc) throw new Error(streamError);
            if (streamError) acc += "\n\n*Ответ прервался: " + streamError + "*";

            // память: забираем факты и убираем теги из ответа
            const facts = [];
            acc = acc.replace(REMEMBER_RE, (m, fact) => { facts.push(fact); return ""; }).trimEnd();
            acc = visibleText(acc);
            if (aborted) acc = (acc || "") + (acc ? "\n\n" : "") + "*Остановлено.*";

            typing.remove();
            if (!msgEl) {
                msgEl = addMessageToDOM("assistant", acc || "Не удалось получить ответ.");
                bubble = msgEl.querySelector(".bubble");
            }
            if (frame) cancelAnimationFrame(frame);
            bubble.classList.remove("streaming");
            msgEl.classList.remove("is-streaming");
            bubble.innerHTML = renderMarkdown(acc || "Не удалось получить ответ.");
            if (sources?.length) msgEl.querySelector(".message-body")?.insertAdjacentHTML("beforeend", renderSources(sources));
            highlightIn(msgEl);
            decorateMessages(msgEl.parentElement || document);

            saveCurrentMessage("assistant", acc || "Не удалось получить ответ.", { sources: sources || null });
            touchChat();
            saveChats();

            if (memory.enabled()) {
                const added = facts.filter((f) => memory.add(f));
                if (added.length) toast("Фокс запомнил: " + added[0]);
            }
            finishUI();
            if (nearBottom()) scrollToBottom();
        } catch (error) {
            typing.remove();
            if (error.name === "AbortError") {
                if (msgEl) msgEl.remove();
                toast("Остановлено.");
            } else {
                if (msgEl) msgEl.remove();
                addMessageToDOM("assistant", "Не получилось получить ответ.\n\n" + error.message);
                toast(error.message || "Произошла ошибка.");
            }
        } finally {
            isSending = false;
            controller = null;
            setSendState(false);
            removeAttachedFile();
        }
    };

    /* ---------------------------------------------------------
       Поле ввода: микрофон, рисование, модель
    --------------------------------------------------------- */
    function setupComposer() {
        const tools = $(".composer-tools");
        if (!tools || $(".fox-mic")) return;

        const mic = document.createElement("button");
        mic.type = "button";
        mic.className = "composer-tool fox-mic";
        mic.title = "Голосовой ввод";
        mic.innerHTML = icon("microphone");
        mic.addEventListener("click", () => toggleMic(mic));

        const draw = document.createElement("button");
        draw.type = "button";
        draw.className = "composer-tool fox-draw";
        draw.title = "Нарисовать картинку";
        draw.innerHTML = icon("paint-brush");
        draw.hidden = true;
        draw.addEventListener("click", () => { setDrawMode(!drawMode); $("#messageInput").focus(); });

        const chip = document.createElement("button");
        chip.type = "button";
        chip.id = "foxModelChip";
        chip.className = "fox-model-chip";
        chip.title = "Сменить модель";
        chip.hidden = true;
        chip.addEventListener("click", () => {
            const ids = server.models.map((m) => m.id);
            if (ids.length < 2) return;
            setModel(ids[(ids.indexOf(currentModel()) + 1) % ids.length]);
        });

        tools.append(mic, draw, chip);
        const input = $("#messageInput");
        if (input) input.dataset.ph = input.placeholder;
    }

    /* ---------------------------------------------------------
       Поиск по чатам и экспорт
    --------------------------------------------------------- */
    let query = "";
    const baseRenderHistory = window.renderHistory;

    window.renderHistory = function () {
        if (!query) return baseRenderHistory();
        const box = $("#chatHistory");
        const q = query.toLowerCase();
        const found = chats.filter((c) =>
            (c.title || "").toLowerCase().includes(q) ||
            (c.messages || []).some((m) => String(m.content).toLowerCase().includes(q)));
        box.innerHTML = found.length ? "" : '<div class="chat-item-empty">Ничего не нашлось.</div>';
        found.slice(0, 50).forEach((chat) => {
            const item = document.createElement("button");
            item.className = "chat-item" + (chat.id === currentChatId ? " active" : "");
            item.innerHTML = icon("chat-circle-text") + '<span class="chat-item-title">' + esc(chat.title) + "</span>";
            item.onclick = () => switchChat(chat.id);
            box.appendChild(item);
        });
    };

    function exportChat() {
        const chat = getCurrentChat();
        if (!chat?.messages?.length) return toast("В этом чате пока пусто.");
        const lines = ["# " + (chat.title || "Чат Fox AI"), ""];
        chat.messages.forEach((m) => {
            lines.push(m.role === "user" ? "## " + (profile?.name || "Я") : "## Fox AI");
            lines.push("", visibleText(m.content).replace(/\(\/api\/image\/render\?/g, "(" + location.origin + "/api/image/render?"), "");
        });
        const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = (chat.title || "fox-ai-chat").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 60) + ".md";
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast("Чат сохранён в файл.");
    }

    function setupSidebar() {
        const history = $("#chatHistory");
        if (!history || $("#foxSearch")) return;
        const wrap = document.createElement("label");
        wrap.className = "fox-search";
        wrap.innerHTML = icon("magnifying-glass") + '<input id="foxSearch" type="search" placeholder="Поиск по чатам" autocomplete="off">';
        history.before(wrap);
        let t = 0;
        wrap.querySelector("input").addEventListener("input", (e) => {
            clearTimeout(t);
            t = setTimeout(() => { query = e.target.value.trim(); renderHistory(); }, 120);
        });

        const title = history.parentElement?.querySelector(".sidebar-title");
        const trash = title?.querySelector(".sidebar-menu-btn");
        if (trash) {
            const exp = document.createElement("button");
            exp.className = "sidebar-menu-btn fox-export";
            exp.title = "Скачать текущий чат";
            exp.innerHTML = icon("download-simple");
            exp.addEventListener("click", exportChat);
            trash.before(exp);
        }
    }

    /* ---------------------------------------------------------
       Синхронизация между устройствами
    --------------------------------------------------------- */
    const sync = {
        code() { return store.get("fox_sync_code", ""); },
        timer: 0,
        busy: false,
        tombstones() { return store.json("fox_deleted", []); },
        addTombstones(ids) {
            const all = new Set([...sync.tombstones(), ...ids]);
            store.setJson("fox_deleted", [...all].slice(-500));
        },
        snapshot() {
            return {
                v: 1,
                chats: chats.map((c) => ({ ...c, messages: (c.messages || []).slice(-200) })),
                deleted: sync.tombstones(),
                memory: memory.list(),
                profile: { name: profile?.name || "", about: profile?.about || "" },
            };
        },
        merge(remote) {
            if (!remote || typeof remote !== "object") return false;
            const dead = new Set([...(remote.deleted || []), ...sync.tombstones()]);
            store.setJson("fox_deleted", [...dead].slice(-500));
            const byId = new Map();
            const stamp = (c) => c.updatedAt || c.createdAt || 0;
            [...(remote.chats || []), ...chats].forEach((c) => {
                if (!c?.id || dead.has(c.id)) return;
                const prev = byId.get(c.id);
                if (!prev || stamp(c) > stamp(prev) || (stamp(c) === stamp(prev) && (c.messages?.length || 0) > (prev.messages?.length || 0))) {
                    byId.set(c.id, c);
                }
            });
            const merged = [...byId.values()].sort((a, b) => stamp(b) - stamp(a));
            const changed = JSON.stringify(merged.map((c) => [c.id, stamp(c), c.messages?.length])) !==
                JSON.stringify(chats.map((c) => [c.id, stamp(c), c.messages?.length]));
            chats = merged;
            const mem = memory.list();
            (remote.memory || []).forEach((m) => { if (!mem.includes(m)) mem.push(m); });
            store.setJson("fox_memory", mem.slice(-30));
            if (!chats.find((c) => c.id === currentChatId)) currentChatId = chats[0]?.id || null;
            return changed;
        },
        async api(path, body) {
            const res = await fetch("/api/sync/" + path, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body || {}),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "Ошибка синхронизации");
            return data;
        },
        async run(silent = true) {
            const code = sync.code();
            if (!code || !server.sync || sync.busy) return;
            sync.busy = true;
            sync.status("Синхронизация…");
            try {
                const { data } = await sync.api("pull", { code });
                const changed = sync.merge(data);
                saveJSON(STORAGE.chats, chats);
                if (changed) { renderHistory(); renderCurrentChat(); renderMemoryUI(); }
                await sync.api("push", { code, data: sync.snapshot() });
                sync.status("Синхронизировано · " + new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }));
            } catch (e) {
                sync.status(e.message);
                if (!silent) toast(e.message);
            } finally {
                sync.busy = false;
            }
        },
        schedule() {
            if (!sync.code() || !server.sync) return;
            clearTimeout(sync.timer);
            sync.timer = setTimeout(() => sync.run(true), 2500);
        },
        status(text) { const s = $("#foxSyncStatus"); if (s) s.textContent = text; },
        render() {
            const box = $("#foxSyncBox");
            if (!box) return;
            box.hidden = !server.sync;
            const code = sync.code();
            box.innerHTML =
                '<div class="fox-sync-head">' + icon("arrows-clockwise") + "<b>Синхронизация</b></div>" +
                (code
                    ? '<div class="fox-sync-desc">Введи этот код на другом устройстве — чаты и память будут общими. Никому его не показывай.</div>' +
                      '<div class="fox-sync-code"><code>' + esc(code) + '</code><button type="button" data-sync="copy" title="Скопировать">' + icon("copy") + "</button></div>" +
                      '<div class="fox-sync-row"><button type="button" class="fox-btn" data-sync="now">' + icon("arrows-clockwise") + "Синхронизировать</button>" +
                      '<button type="button" class="fox-btn ghost" data-sync="off">Отключить здесь</button></div>' +
                      '<div class="fox-sync-status" id="foxSyncStatus"></div>'
                    : '<div class="fox-sync-desc">Чтобы чаты были одинаковыми на телефоне и компьютере, включи синхронизацию здесь, а на втором устройстве введи код.</div>' +
                      '<div class="fox-sync-row"><button type="button" class="fox-btn" data-sync="new">' + icon("plus-circle") + "Включить</button>" +
                      '<button type="button" class="fox-btn ghost" data-sync="enter">У меня есть код</button></div>' +
                      '<div class="fox-sync-enter" hidden><input type="text" placeholder="FOX-XXXX-XXXX-XXXX-XXXX" autocomplete="off">' +
                      '<button type="button" class="fox-btn" data-sync="join">Подключить</button></div>');
        },
        setup() {
            const body = $("#profileModal .modal-body");
            if (!body || $("#foxSyncBox")) return;
            const box = document.createElement("div");
            box.id = "foxSyncBox";
            box.className = "fox-sync";
            box.hidden = true;
            body.appendChild(box);
            box.addEventListener("click", async (e) => {
                const b = e.target.closest("[data-sync]");
                if (!b) return;
                const act = b.dataset.sync;
                try {
                    if (act === "new") {
                        const { code } = await sync.api("create");
                        store.set("fox_sync_code", code);
                        sync.render();
                        await sync.run(false);
                        toast("Синхронизация включена.");
                    } else if (act === "enter") {
                        box.querySelector(".fox-sync-enter").hidden = false;
                        box.querySelector(".fox-sync-enter input").focus();
                    } else if (act === "join") {
                        const code = box.querySelector(".fox-sync-enter input").value.trim().toUpperCase();
                        await sync.api("pull", { code });
                        store.set("fox_sync_code", code);
                        sync.render();
                        await sync.run(false);
                        toast("Устройство подключено.");
                    } else if (act === "copy") {
                        await navigator.clipboard.writeText(sync.code());
                        toast("Код скопирован.");
                    } else if (act === "now") {
                        await sync.run(false);
                    } else if (act === "off") {
                        store.set("fox_sync_code", "");
                        sync.render();
                        toast("На этом устройстве синхронизация выключена.");
                    }
                } catch (err) {
                    toast(err.message);
                }
            });
        },
    };

    // отмечаем изменения и удаления, чтобы синхронизация их учитывала
    const baseSaveChats = window.saveChats;
    window.saveChats = function () {
        baseSaveChats();
        sync.schedule();
    };
    const baseDeleteChat = window.deleteChat;
    window.deleteChat = function (id, event) {
        sync.addTombstones([id]);
        return baseDeleteChat(id, event);
    };
    const baseClear = window.clearChatHistory;
    window.clearChatHistory = function () {
        const ids = chats.map((c) => c.id);
        const before = chats.length;
        baseClear();
        if (chats.length < before) sync.addTombstones(ids);
    };

    /* ---------------------------------------------------------
       Мобильные панели
    --------------------------------------------------------- */
    function setupMobilePanels() {
        const backdrop = document.createElement("div");
        backdrop.className = "fox-backdrop";
        backdrop.addEventListener("click", () => document.body.classList.remove("fox-left-open", "fox-right-open"));
        // внутрь .app — там же, где панели (у .app свой слой z-index)
        ($(".app") || document.body).prepend(backdrop);

        const actions = $(".top-actions");
        if (actions && !$("#foxPanelBtn")) {
            const btn = document.createElement("button");
            btn.id = "foxPanelBtn";
            btn.className = "icon-btn fox-panel-btn";
            btn.title = "Панель";
            btn.innerHTML = icon("squares-four");
            btn.addEventListener("click", () => toggleFoxRightDrawer());
            const cmd = actions.querySelector('[onclick*="openCommandCenter"]');
            actions.insertBefore(btn, cmd || actions.firstChild);
        }

        // на телефоне закрываем панель после выбора пункта
        document.addEventListener("click", (e) => {
            if (window.innerWidth > 900) return;
            if (e.target.closest(".sidebar .nav-btn, .sidebar .chat-item, .sidebar .new-chat, .right-panel .command-item, .right-panel .mode-btn")) {
                setTimeout(() => document.body.classList.remove("fox-left-open", "fox-right-open"), 120);
            }
        });
    }

    /* ---------------------------------------------------------
       Запуск
    --------------------------------------------------------- */
    function init() {
        setupFileInput();
        setupComposer();
        setupSettings();
        setupSidebar();
        setupMobilePanels();
        sync.setup();

        const sendBtn = $("#sendBtn");
        if (sendBtn) {
            setSendState(false);
            // во время ответа кнопка работает как «Стоп»
            sendBtn.addEventListener("click", (e) => {
                if (isSending && controller) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                    controller.abort();
                }
            }, true);
        }

        try {
            if (getCurrentChat()?.messages?.length) renderCurrentChat();
        } catch { /* не критично */ }

        const inner = $("#messagesInner");
        if (inner) {
            let t = 0;
            new MutationObserver(() => {
                clearTimeout(t);
                t = setTimeout(() => { highlightIn(inner); decorateMessages(inner); }, 100);
            }).observe(inner, { childList: true, subtree: true });
            decorateMessages(inner);
        }

        loadScript(HLJS).then(() => highlightIn($("#messagesInner"))).catch(() => {});

        fetch("/api/health").then((r) => r.json()).then((j) => {
            server = { ...server, ...j, models: j.models || [] };
            renderModelUI();
            const draw = $(".fox-draw");
            if (draw) draw.hidden = !server.images;
            sync.render();
            sync.run(true);
        }).catch(() => {});

        window.addEventListener("focus", () => sync.schedule());
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
