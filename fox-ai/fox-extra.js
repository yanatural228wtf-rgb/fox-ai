/* =========================================================
   Fox AI — расширения интерфейса
   • ответ печатается по мере генерации (стриминг)
   • вложения: текст, код, PDF, картинки (до 3)
   • голосовой ввод и озвучка ответов
   • блоки кода с подсветкой и кнопкой «Копировать»
   • выбор модели (Умная / Быстрая)
   Подключается после основного скрипта и переопределяет sendMessage.
========================================================== */
(() => {
    "use strict";

    const $ = (sel, root = document) => root.querySelector(sel);
    const store = {
        get(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
        set(key, value) { try { localStorage.setItem(key, value); } catch { /* приватный режим */ } },
    };
    const toast = (msg) => (typeof showToast === "function" ? showToast(msg) : console.log(msg));
    const esc = (s) => (typeof escapeHtml === "function" ? escapeHtml(s) : String(s));

    let server = { models: [], vision: false };

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
       Блоки кода: язык, кнопка «Копировать», подсветка
    --------------------------------------------------------- */
    const baseRender = window.renderMarkdown;

    window.renderMarkdown = function (text) {
        let src = String(text ?? "");
        // во время печати закрываем незаконченный блок кода, чтобы он сразу выглядел как код
        if ((src.match(/```/g) || []).length % 2 === 1) src += "\n```";

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
                    '<span class="code-lang"><i class="ph-fill ph-code"></i>' + (lang || "код") + "</span>" +
                    '<button type="button" class="fox-copy-code"><i class="ph-fill ph-copy"></i><span>Копировать</span></button>' +
                    "</div><pre><code" + (lang ? ' data-lang="' + lang + '"' : "") + ">";
            })
            .replace(/<\/code><\/pre><button class="copy-code">Копировать<\/button><\/div>/g, "</code></pre></div>");
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

    document.addEventListener("click", async (e) => {
        const btn = e.target.closest(".fox-copy-code");
        if (!btn) return;
        const code = btn.closest(".fox-code")?.querySelector("pre code")?.innerText || "";
        try {
            await navigator.clipboard.writeText(code);
            btn.classList.add("done");
            btn.innerHTML = '<i class="ph-fill ph-check"></i><span>Скопировано</span>';
            setTimeout(() => {
                btn.classList.remove("done");
                btn.innerHTML = '<i class="ph-fill ph-copy"></i><span>Копировать</span>';
            }, 1600);
        } catch {
            toast("Не удалось скопировать код.");
        }
    });

    /* ---------------------------------------------------------
       Озвучка ответов
    --------------------------------------------------------- */
    let speakingBtn = null;

    function stopSpeaking() {
        try { speechSynthesis.cancel(); } catch { /* нет поддержки */ }
        if (speakingBtn) speakingBtn.innerHTML = '<i class="ph-fill ph-speaker-high"></i>';
        speakingBtn?.classList.remove("active");
        speakingBtn = null;
    }

    function pickVoice(lang) {
        const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith(lang));
        return voices.find((v) => /google|microsoft|natural|online/i.test(v.name)) || voices[0] || null;
    }

    function speak(btn) {
        if (!("speechSynthesis" in window)) return toast("Озвучка не поддерживается этим браузером.");
        if (speakingBtn === btn) return stopSpeaking();
        stopSpeaking();

        const bubble = btn.closest(".message")?.querySelector(".bubble");
        if (!bubble) return;
        const clone = bubble.cloneNode(true);
        clone.querySelectorAll(".fox-code, .code-wrap").forEach((n) => n.replaceWith(" (пример кода) "));
        const text = clone.innerText.replace(/\s+/g, " ").trim();
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
        btn.innerHTML = '<i class="ph-fill ph-stop-circle"></i>';
        chunks.forEach((chunk, i) => {
            const u = new SpeechSynthesisUtterance(chunk);
            u.lang = lang === "ru" ? "ru-RU" : "en-US";
            if (voice) u.voice = voice;
            u.rate = 1.03;
            if (i === chunks.length - 1) u.onend = () => { if (speakingBtn === btn) stopSpeaking(); };
            speechSynthesis.speak(u);
        });
    }

    function addSpeakButtons(root) {
        root.querySelectorAll(".message.assistant .message-actions").forEach((actions) => {
            if (actions.querySelector(".fox-speak")) return;
            const b = document.createElement("button");
            b.className = "fox-speak";
            b.title = "Озвучить";
            b.innerHTML = '<i class="ph-fill ph-speaker-high"></i>';
            b.addEventListener("click", () => speak(b));
            actions.appendChild(b);
        });
    }
    if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();

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
            if (typeof autoResize === "function") autoResize();
        };
        rec.onerror = (e) => {
            if (e.error === "not-allowed") toast("Разреши доступ к микрофону в настройках браузера.");
            else if (e.error !== "aborted" && e.error !== "no-speech") toast("Микрофон: " + e.error);
        };
        rec.onend = () => {
            rec = null;
            btn.classList.remove("recording");
            btn.innerHTML = '<i class="ph-fill ph-microphone"></i>';
            input.focus();
        };
        try {
            rec.start();
            btn.classList.add("recording");
            btn.innerHTML = '<i class="ph-fill ph-stop-circle"></i>';
        } catch {
            rec = null;
        }
    }

    /* ---------------------------------------------------------
       Вложения: текст, PDF, картинки
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
        const icons = { image: "ph-image", pdf: "ph-file-pdf", text: "ph-file-text" };
        name.innerHTML = attachments.map((a) =>
            '<span class="fox-att">' +
            (a.kind === "image" && a.preview ? '<img src="' + a.preview + '" alt="">' : '<i class="ph-fill ' + icons[a.kind] + '"></i>') +
            "<span>" + esc(a.file.name) + "</span></span>").join("");
        chip.classList.add("visible");
    }

    function setupFileInput() {
        const old = $("#fileInput");
        if (!old) return;
        const input = old.cloneNode(false); // без старых обработчиков
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
        if (removeBtn) removeBtn.innerHTML = '<i class="ph-fill ph-x"></i>';
    }

    const baseRemove = window.removeAttachedFile;
    window.removeAttachedFile = function () {
        attachments.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
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

    async function prepareAttachments() {
        let extra = "";
        const images = [];
        for (const a of attachments) {
            if (a.kind === "image") {
                images.push(await imageToDataUrl(a.file));
                continue;
            }
            let text = a.kind === "pdf" ? await readPdf(a.file) : await readText(a.file);
            if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n…[файл обрезан]";
            extra += "\n\nВложенный файл «" + a.file.name + "»:\n```\n" + text + "\n```";
        }
        return { extra, images };
    }

    /* ---------------------------------------------------------
       Выбор модели
    --------------------------------------------------------- */
    function currentModel() {
        const saved = store.get("fox_model", "");
        return server.models.find((m) => m.id === saved) ? saved : (server.models[0]?.id || "");
    }

    function modelLabel() {
        return server.models.find((m) => m.id === currentModel())?.label || "Модель";
    }

    function setModel(id) {
        store.set("fox_model", id);
        renderModelUI();
        toast("Модель: " + modelLabel());
    }

    function renderModelUI() {
        const chip = $("#foxModelChip");
        if (chip) {
            chip.hidden = server.models.length < 2;
            chip.innerHTML = '<i class="ph-fill ' + (/Быстр/.test(modelLabel()) ? "ph-lightning" : "ph-brain") + '"></i><span>' + esc(modelLabel()) + "</span>";
        }
        const seg = $("#foxModelSeg");
        if (seg) {
            seg.innerHTML = server.models.map((m) =>
                '<button type="button" data-model="' + esc(m.id) + '" class="' + (m.id === currentModel() ? "active" : "") + '">' +
                '<i class="ph-fill ' + (/Быстр/.test(m.label) ? "ph-lightning" : "ph-brain") + '"></i>' + esc(m.label) + "</button>").join("");
        }
    }

    function setupModelUI() {
        // переключатель в поле ввода
        const tools = $(".composer-tools");
        if (tools && !$("#foxModelChip")) {
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
            tools.appendChild(chip);
        }
        // раздел в настройках
        const body = $("#settingsModal .modal-body");
        if (body && !$("#foxModelSeg")) {
            const wrap = document.createElement("div");
            wrap.innerHTML =
                '<div class="input-label">Модель ИИ</div>' +
                '<div class="setting-row fox-model-row"><div class="setting-copy">' +
                '<div class="setting-title">Как думать</div>' +
                '<div class="setting-description">«Умная» лучше рассуждает, «Быстрая» отвечает почти мгновенно.</div>' +
                '</div><div class="fox-seg" id="foxModelSeg"></div></div>';
            body.prepend(...wrap.childNodes);
            body.addEventListener("click", (e) => {
                const b = e.target.closest("#foxModelSeg button");
                if (b) setModel(b.dataset.model);
            });
        }
        renderModelUI();
    }

    /* ---------------------------------------------------------
       Отправка со стримингом
    --------------------------------------------------------- */
    function nearBottom() {
        const box = $("#messages");
        return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    }
    function stickBottom() {
        const box = $("#messages");
        if (box) box.scrollTop = box.scrollHeight;
    }

    window.sendMessage = async function () {
        if (isSending) return;

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

        input.value = "";
        autoResize();

        const typing = addTyping();
        isSending = true;
        $("#sendBtn").disabled = true;
        scrollToBottom();

        let msgEl = null;
        let bubble = null;
        let acc = "";
        let sources = null;
        let frame = 0;

        const paint = () => {
            frame = 0;
            if (!bubble) return;
            const stick = nearBottom();
            bubble.innerHTML = renderMarkdown(acc) + '<span class="fox-caret"></span>';
            if (stick) stickBottom();
        };

        try {
            const history = (getCurrentChat()?.messages || []).slice(0, -1).slice(-20)
                .map((m) => ({ role: m.role, content: m.content }));

            const { extra, images } = files.length ? await prepareAttachments() : { extra: "", images: [] };

            const res = await fetch("/api/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: displayed + extra,
                    mode: currentMode,
                    web: currentMode === "web",
                    history,
                    model: currentModel(),
                    images,
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

            if (streamError && !acc) throw new Error(streamError);
            if (streamError) acc += "\n\n*Ответ прервался: " + streamError + "*";

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
            addSpeakButtons(msgEl.parentElement || document);

            saveCurrentMessage("assistant", acc || "Не удалось получить ответ.", { sources: sources || null });

            const current = getCurrentChat();
            $("#pageTitle").textContent = current?.title || "Чат";
            const count = $("#panelMessagesCount");
            if (count) count.textContent = current?.messages?.length || 0;
            const web = $("#panelWebStatus");
            if (web) web.textContent = currentMode === "web" ? "Использован" : "Готов";
            if (nearBottom()) scrollToBottom();
        } catch (error) {
            typing.remove();
            if (msgEl) msgEl.remove();
            addMessageToDOM("assistant", "Не получилось получить ответ.\n\n" + error.message);
            toast(error.message || "Произошла ошибка.");
        } finally {
            isSending = false;
            $("#sendBtn").disabled = false;
            removeAttachedFile();
        }
    };

    /* ---------------------------------------------------------
       Кнопки в поле ввода
    --------------------------------------------------------- */
    function setupComposer() {
        const tools = $(".composer-tools");
        if (!tools || $(".fox-mic")) return;
        const mic = document.createElement("button");
        mic.type = "button";
        mic.className = "composer-tool fox-mic";
        mic.title = "Голосовой ввод";
        mic.innerHTML = '<i class="ph-fill ph-microphone"></i>';
        mic.addEventListener("click", () => toggleMic(mic));
        tools.appendChild(mic);
    }

    /* ---------------------------------------------------------
       Запуск
    --------------------------------------------------------- */
    function init() {
        setupFileInput();
        setupComposer();
        setupModelUI();

        // история уже отрисована старым рендером — перерисуем с новыми блоками кода
        try {
            if (getCurrentChat()?.messages?.length && typeof renderCurrentChat === "function") renderCurrentChat();
        } catch { /* не критично */ }

        const inner = $("#messagesInner");
        if (inner) {
            let t = 0;
            new MutationObserver(() => {
                clearTimeout(t);
                t = setTimeout(() => { highlightIn(inner); addSpeakButtons(inner); }, 120);
            }).observe(inner, { childList: true, subtree: true });
            addSpeakButtons(inner);
        }

        loadScript(HLJS).then(() => highlightIn($("#messagesInner"))).catch(() => {});

        fetch("/api/health").then((r) => r.json()).then((j) => {
            server = { ...server, ...j, models: j.models || [] };
            renderModelUI();
        }).catch(() => {});
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
