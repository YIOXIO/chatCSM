import './index.css';
import { marked } from 'marked';

marked.use({ breaks: true, gfm: true });

// ─── Конфигурация ────────────────────────────────────────────────────
const SERVER = window.location.port === '8080' ? 'http://localhost:3000' : '';
const API_URL = `${SERVER}/api/chat`;
const FILE_API_URL = `${SERVER}/api/parse-file`;

// История сообщений для контекста модели (по контейнеру)
const chatHistories = new Map();
// Активные запросы (AbortController) — для остановки генерации
const activeRequests = new Map();
// ID чата в SQLite для каждого контейнера (null = новый чат не создан)
const activeChatIds = new Map();
// ID последнего сохранённого сообщения ИИ (для обновления при continueMessage)
const lastAssistantMsgIds = new Map();

function getHistory(container) {
    if (!chatHistories.has(container)) {
        chatHistories.set(container, []);
    }
    return chatHistories.get(container);
}

// ─── Очистка ответа (<think> теги) ───────────────────────────────────
function cleanAIResponse(rawText) {
    if (!rawText) return '';
    return String(rawText)
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
}

// ─── Форматирование Markdown → HTML (marked) ────────────────────────
function formatMessage(rawText) {
    if (!rawText || !rawText.trim()) return '<div class="ai__chat-message-content"></div>';
    return `<div class="ai__chat-message-content">${marked.parse(rawText.trim())}</div>`;
}

// ─── Мигающий курсор внутрь последнего блочного тега ─────────────────
function withStreamCursor(innerHTML) {
    const cursor = '<span class="ai__stream-cursor"></span>';
    const tags = ['</p>', '</li>', '</h1>', '</h2>', '</h3>', '</h4>', '</h5>', '</h6>'];
    const idx = Math.max(...tags.map(t => innerHTML.lastIndexOf(t)));
    if (idx === -1) return innerHTML + cursor;
    return innerHTML.slice(0, idx) + cursor + innerHTML.slice(idx);
}

// ─── UI helpers ───────────────────────────────────────────────────────

function addTypingLoader(messagesContainer) {
    messagesContainer.querySelectorAll('.ai__typing-loader').forEach(el => el.remove());
    const loader = document.createElement('div');
    loader.classList.add('ai__typing-loader');
    loader.innerHTML = '<span class="ai__typing-label">Анализирую</span><span class="ai__typing-dots"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>';
    messagesContainer.appendChild(loader);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function removeTypingLoader(container) {
    container.querySelectorAll('.ai__typing-loader').forEach(el => el.remove());
}

function setGeneratingState(containerEl, isGenerating) {
    const sendBtn = containerEl.querySelector('.ai__chat-button_send');
    const stopBtn = containerEl.querySelector('.ai__chat-button_stop');
    const input = containerEl.querySelector('.ai__chat-input');
    if (sendBtn) sendBtn.style.display = isGenerating ? 'none' : '';
    if (stopBtn) stopBtn.style.display = isGenerating ? '' : 'none';
    if (input) input.disabled = isGenerating;
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
        reader.readAsText(file, 'UTF-8');
    });
}

// ─── История запросов: загрузка из SQLite и рендер в сайдбаре ────────

async function _restoreChatHistory(chatId, contour) {
    const chatCons = [...document.querySelectorAll('.ai__container')]
        .filter(c => c.querySelector('.ai__chat-input'));
    const targetContainer = (contour === 'open' && chatCons[1]) ? chatCons[1] : chatCons[0];
    if (!targetContainer) return;
    // Сбрасываем прикреплённый файл при смене чата
    const fileInputEl = targetContainer.querySelector('.ai__file-input');
    const filePrev = targetContainer.querySelector('.ai__file-preview');
    if (fileInputEl) {
        fileInputEl.value = '';
        try { fileInputEl.files = new DataTransfer().files; } catch { /* Safari */ }
    }
    if (filePrev) { filePrev.style.display = 'none'; filePrev.innerHTML = ''; }
    try {
        const res = await fetch(`${SERVER}/api/chats/${chatId}/messages`);
        if (!res.ok) return;
        const messages = await res.json();
        const messagesEl = targetContainer.querySelector('.ai__chat-messages');
        if (!messagesEl) return;
        messagesEl.innerHTML = '';
        chatHistories.set(targetContainer, []);
        messages.forEach(msg => {
            const el = document.createElement('article');
            if (msg.role === 'user') {
                el.classList.add('ai__chat-message', 'ai__chat-message_user');
                el.innerHTML = formatMessage(msg.content);
            } else {
                el.classList.add('ai__chat-message', 'ai__chat-message_ai');
                const contentEl = document.createElement('div');
                contentEl.classList.add('ai__chat-message-content');
                contentEl.innerHTML = formatMessage(msg.content)
                    .replace(/^<div class="ai__chat-message-content">|<\/div>$/g, '');
                el.appendChild(contentEl);
            }
            messagesEl.appendChild(el);
            getHistory(targetContainer).push({ role: msg.role, content: msg.content });
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
        activeChatIds.set(targetContainer, parseInt(chatId));
        const histSidebarEl = document.getElementById('histSidebar');
        if (histSidebarEl) histSidebarEl.classList.remove('open');
    } catch (e) {
        console.warn('Не удалось загрузить чат:', e);
    }
}

function _attachHistItemHandlers(item, histList) {
    const delBtn = item.querySelector('.hist-sidebar__item-del');
    if (delBtn) {
        delBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = item.dataset.chatId;
            if (id) {
                await fetch(`${SERVER}/api/chats/${id}`, { method: 'DELETE' }).catch(() => { });
            }
            item.remove();
            if (!histList.querySelector('.hist-sidebar__item')) {
                histList.innerHTML = '<p class="hist-sidebar__empty">Ваши запросы появятся здесь</p>';
            }
        });
    }
    item.addEventListener('click', (e) => {
        if (e.target.classList.contains('hist-sidebar__item-del')) return;
        const chatId = item.dataset.chatId;
        if (chatId) _restoreChatHistory(chatId, item.dataset.contour || 'closed');
    });
}

async function loadHistoryFromDB() {
    const histList = document.getElementById('histList');
    if (!histList) return;
    try {
        const res = await fetch(`${SERVER}/api/chats`);
        if (!res.ok) return;
        const chats = await res.json();
        if (!chats.length) return;
        const empty = histList.querySelector('.hist-sidebar__empty');
        if (empty) empty.remove();
        chats.forEach(chat => {
            const date = new Date(chat.created_at * 1000);
            const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
            const shortName = chat.name.length > 68 ? chat.name.slice(0, 68) + '\u2026' : chat.name;
            const item = document.createElement('div');
            item.className = 'hist-sidebar__item';
            item.dataset.chatId = chat.id;
            item.dataset.contour = 'closed';
            item.innerHTML = `
                <div class="hist-sidebar__item-meta">
                    <span class="hist-sidebar__item-time">${time}</span>
                    <button class="hist-sidebar__item-del" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c">&times;</button>
                </div>
                <div class="hist-sidebar__item-text">${shortName}</div>
            `;
            _attachHistItemHandlers(item, histList);
            histList.appendChild(item);
        });
    } catch (e) {
        console.warn('Не удалось загрузить историю из БД:', e);
    }
}

function addHistoryEntry(contourLabel, text, chatId) {
    const histList = document.getElementById('histList');
    if (!histList) return;
    const empty = histList.querySelector('.hist-sidebar__empty');
    if (empty) empty.remove();
    const now = new Date();
    const time = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const isClosed = contourLabel.includes('Закрытый');
    const badgeMod = isClosed ? 'hist-sidebar__item-badge_closed' : 'hist-sidebar__item-badge_open';
    const badgeText = isClosed ? 'Закрытый' : 'Открытый';
    const cleanText = text.replace(/\n+/g, ' ').trim();
    const shortText = cleanText.length > 68 ? cleanText.slice(0, 68) + '\u2026' : cleanText;
    const item = document.createElement('div');
    item.className = 'hist-sidebar__item';
    item.dataset.contour = isClosed ? 'closed' : 'open';
    item.innerHTML = `
        <div class="hist-sidebar__item-meta">
            <span class="hist-sidebar__item-badge ${badgeMod}">${badgeText}</span>
            <span class="hist-sidebar__item-time">${time}</span>
            <button class="hist-sidebar__item-del" title="\u0423\u0434\u0430\u043b\u0438\u0442\u044c">&times;</button>
        </div>
        <div class="hist-sidebar__item-text">${shortText}</div>
    `;
    if (chatId != null) item.dataset.chatId = chatId;
    _attachHistItemHandlers(item, histList);
    histList.prepend(item);
}

// ─── Stopped UI: метка + кнопка «Продолжить» ─────────────────────────
function addStoppedUI(aiEl, contentEl, containerEl, capturedContent) {
    aiEl.querySelectorAll('.ai__continue-btn').forEach(el => el.remove());
    contentEl.querySelectorAll('.ai__stopped').forEach(el => el.remove());

    const sp = document.createElement('span');
    sp.className = 'ai__stopped';
    sp.textContent = ' [остановлено]';
    contentEl.appendChild(sp);

    const btn = document.createElement('button');
    btn.className = 'ai__continue-btn';
    btn.textContent = '↩ Продолжить';
    btn.addEventListener('click', () => continueMessage(containerEl, aiEl, contentEl, capturedContent));
    contentEl.appendChild(btn);
}

// ─── Продолжение генерации ────────────────────────────────────────────
async function continueMessage(containerEl, aiEl, contentEl, initialContent) {
    if (activeRequests.has(containerEl)) return;

    aiEl.querySelectorAll('.ai__continue-btn').forEach(el => el.remove());
    contentEl.querySelectorAll('.ai__stopped').forEach(el => el.remove());

    const history = getHistory(containerEl);
    history.push({ role: 'user', content: 'Продолжи.' });

    const ac = new AbortController();
    activeRequests.set(containerEl, ac);
    setGeneratingState(containerEl, true);

    let ollamaResponse;
    try {
        ollamaResponse = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: history }),
            signal: ac.signal
        });
    } catch (err) {
        history.pop();
        activeRequests.delete(containerEl);
        setGeneratingState(containerEl, false);
        if (err.name !== 'AbortError') console.error('Ошибка соединения:', err);
        addStoppedUI(aiEl, contentEl, containerEl, initialContent);
        return;
    }

    if (!ollamaResponse.ok) {
        history.pop();
        activeRequests.delete(containerEl);
        setGeneratingState(containerEl, false);
        addStoppedUI(aiEl, contentEl, containerEl, initialContent);
        return;
    }

    const reader = ollamaResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let newTokens = '';
    let wasAborted = false;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.content) {
                        newTokens += data.content;
                        const _inner = formatMessage(cleanAIResponse(initialContent + newTokens))
                            .replace(/^<div class="ai__chat-message-content">|<\/div>$/g, '');
                        contentEl.innerHTML = withStreamCursor(_inner);
                        const msgs = containerEl.querySelector('.ai__chat-messages');
                        if (msgs) msgs.scrollTop = msgs.scrollHeight;
                    }
                } catch { /* ignore */ }
            }
        }
    } catch (err) {
        if (err.name === 'AbortError') wasAborted = true;
        else console.error('Ошибка стрима:', err);
    } finally {
        const combined = initialContent + newTokens;
        history.pop();   // 'Продолжи.'
        history.pop();   // старый partial assistant
        if (combined) history.push({ role: 'assistant', content: combined });

        const inner = formatMessage(cleanAIResponse(combined))
            .replace(/^<div class="ai__chat-message-content">|<\/div>$/g, '');
        contentEl.innerHTML = inner;
        if (wasAborted) addStoppedUI(aiEl, contentEl, containerEl, combined);
        activeRequests.delete(containerEl);
        setGeneratingState(containerEl, false);
        // Сохраняем продолжение в БД: обновляем существующую запись
        const _chatId = activeChatIds.get(containerEl);
        if (_chatId && combined) {
            const msgId = lastAssistantMsgIds.get(containerEl);
            if (msgId) {
                fetch(`${SERVER}/api/messages/${msgId}`, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: combined })
                }).catch(() => { });
            } else {
                fetch(`${SERVER}/api/chats/${_chatId}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: 'assistant', content: combined })
                }).then(r => r.json())
                    .then(data => { if (data.id) lastAssistantMsgIds.set(containerEl, data.id); })
                    .catch(() => { });
            }
        }
    }
}

// ─── Отправка сообщения ───────────────────────────────────────────────
async function sendMessage(containerEl) {
    if (activeRequests.has(containerEl)) return;

    const input = containerEl.querySelector('.ai__chat-input');
    const messagesEl = containerEl.querySelector('.ai__chat-messages');
    const fileInputEl = containerEl.querySelector('.ai__file-input');
    const filePrev = containerEl.querySelector('.ai__file-preview');

    let message = input.value.trim();
    let displayMessage = message;
    let apiMessage = message;

    // ── Файл ──────────────────────────────────────────────────────────
    if (fileInputEl && fileInputEl.files.length > 0) {
        const file = fileInputEl.files[0];
        const ext = '.' + file.name.split('.').pop().toLowerCase();
        const binaryExts = ['.docx', '.xlsx', '.xls', '.pdf', '.pptx'];
        try {
            let fileContent;
            if (binaryExts.includes(ext)) {
                const formData = new FormData();
                formData.append('file', file);
                const parseRes = await fetch(FILE_API_URL, { method: 'POST', body: formData });
                const parseData = await parseRes.json();
                if (parseData.error) throw new Error(parseData.error);
                fileContent = parseData.text;
            } else {
                fileContent = await readFileAsText(file);
            }
            displayMessage = `📄 ${file.name}${message ? '\n' + message : ''}`;
            apiMessage = `Файл "${file.name}":\n\`\`\`\n${fileContent.slice(0, 12000)}\n\`\`\`\n\n${message || 'Проанализируй содержимое этого файла и дай краткое резюме.'}`;
        } catch (e) {
            displayMessage = `📄 ${file.name} [ошибка: ${e.message}]`;
            apiMessage = message || `Не удалось прочитать файл ${file.name}: ${e.message}`;
        }
        fileInputEl.value = '';
        if (filePrev) { filePrev.style.display = 'none'; filePrev.innerHTML = ''; }
    }

    if (!displayMessage) return;

    input.value = '';

    // ── Сообщение пользователя ────────────────────────────────────────
    const userEl = document.createElement('article');
    userEl.classList.add('ai__chat-message', 'ai__chat-message_user');
    userEl.innerHTML = formatMessage(displayMessage);
    messagesEl.appendChild(userEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    // ── История запросов (сайдбар) + SQLite ─────────────────────────
    const contourLabel = containerEl.querySelector('.ai__badge')?.textContent || '';
    let chatId = activeChatIds.get(containerEl) || null;
    if (!chatId) {
        try {
            const chatRes = await fetch(`${SERVER}/api/chats`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: displayMessage.replace(/\n+/g, ' ').trim().slice(0, 100) })
            });
            if (chatRes.ok) {
                const chatData = await chatRes.json();
                chatId = chatData.id;
                activeChatIds.set(containerEl, chatId);
                addHistoryEntry(contourLabel, displayMessage, chatId);
            }
        } catch { /* не удалось создать запись — продолжаем без сохранения */ }
    }
    // Сохраняем сообщение пользователя в БД (отображаем displayMessage, а не сырой контент файла)
    if (chatId) {
        fetch(`${SERVER}/api/chats/${chatId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'user', content: displayMessage })
        }).catch(() => { });
    }

    // ── История ───────────────────────────────────────────────────────
    const history = getHistory(containerEl);
    history.push({ role: 'user', content: apiMessage });

    // ── Loader ────────────────────────────────────────────────────────
    addTypingLoader(messagesEl);

    const ac = new AbortController();
    activeRequests.set(containerEl, ac);
    setGeneratingState(containerEl, true);

    let ollamaResponse;
    try {
        ollamaResponse = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: history }),
            signal: ac.signal
        });
    } catch (err) {
        removeTypingLoader(containerEl);
        activeRequests.delete(containerEl);
        setGeneratingState(containerEl, false);
        if (err.name === 'AbortError') return;
        const errEl = document.createElement('article');
        errEl.classList.add('ai__chat-message', 'ai__chat-message_ai');
        errEl.innerHTML = '<p style="color:#c05050">Не удалось подключиться к серверу.</p>';
        messagesEl.appendChild(errEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return;
    }

    if (!ollamaResponse.ok) {
        removeTypingLoader(containerEl);
        activeRequests.delete(containerEl);
        setGeneratingState(containerEl, false);
        const errEl = document.createElement('article');
        errEl.classList.add('ai__chat-message', 'ai__chat-message_ai');
        errEl.innerHTML = `<p style="color:#c05050">Ошибка сервера: ${ollamaResponse.status}</p>`;
        messagesEl.appendChild(errEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return;
    }

    // ── Элемент ответа ИИ (добавляется в DOM при первом токене) ──────────
    const aiEl = document.createElement('article');
    aiEl.classList.add('ai__chat-message', 'ai__chat-message_ai');
    const contentEl = document.createElement('div');
    contentEl.classList.add('ai__chat-message-content');
    aiEl.appendChild(contentEl);

    const reader = ollamaResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';
    let wasAborted = false;
    let firstToken = true;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                    const data = JSON.parse(line.slice(6));
                    if (data.error) { contentEl.textContent = `Ошибка: ${data.error}`; break; }
                    if (data.content) {
                        if (firstToken) {
                            removeTypingLoader(containerEl);
                            messagesEl.appendChild(aiEl);
                            firstToken = false;
                        }
                        fullContent += data.content;
                        const _inner = formatMessage(cleanAIResponse(fullContent))
                            .replace(/^<div class="ai__chat-message-content">|<\/div>$/g, '');
                        contentEl.innerHTML = withStreamCursor(_inner);
                        messagesEl.scrollTop = messagesEl.scrollHeight;
                    }
                } catch { /* ignore */ }
            }
        }
    } catch (err) {
        if (err.name === 'AbortError') wasAborted = true;
        else console.error('Ошибка стрима:', err);
    } finally {
        removeTypingLoader(containerEl); // безопасно: убрать, если токены так и не пришли
        const cleaned = cleanAIResponse(fullContent);
        if (cleaned) {
            if (!messagesEl.contains(aiEl)) messagesEl.appendChild(aiEl);
            contentEl.innerHTML = formatMessage(cleaned)
                .replace(/^<div class="ai__chat-message-content">|<\/div>$/g, '');
            if (wasAborted) {
                addStoppedUI(aiEl, contentEl, containerEl, fullContent);
            }
        }
        if (fullContent) {
            history.push({ role: 'assistant', content: fullContent });
            // Сохраняем ответ ИИ в БД и запоминаем ID для возможного обновления
            const _chatId = activeChatIds.get(containerEl);
            if (_chatId) {
                fetch(`${SERVER}/api/chats/${_chatId}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: 'assistant', content: fullContent })
                }).then(r => r.json())
                    .then(data => { if (data.id) lastAssistantMsgIds.set(containerEl, data.id); })
                    .catch(() => { });
            }
        }
        activeRequests.delete(containerEl);
        setGeneratingState(containerEl, false);
    }
}

// ═══════════════════════════════════════════════════════════════════
//  Инициализация контейнеров
// ═══════════════════════════════════════════════════════════════════

// Сохраняем начальное состояние сообщений для «Нового чата»
const initialMessages = new Map();
document.querySelectorAll('.ai__container').forEach(container => {
    const messagesEl = container.querySelector('.ai__chat-messages');
    if (messagesEl) initialMessages.set(container, messagesEl.innerHTML);
});

function newChat() {
    activeRequests.forEach(ac => ac.abort());
    activeRequests.clear();
    activeChatIds.clear();
    document.querySelectorAll('.ai__container').forEach(container => {
        chatHistories.set(container, []);
        const messagesEl = container.querySelector('.ai__chat-messages');
        const initial = initialMessages.get(container);
        if (messagesEl && initial !== undefined) messagesEl.innerHTML = initial;
        setGeneratingState(container, false);
        // Сбрасываем прикреплённый файл
        const fileInputEl = container.querySelector('.ai__file-input');
        const filePrev = container.querySelector('.ai__file-preview');
        if (fileInputEl) {
            fileInputEl.value = '';
            try { fileInputEl.files = new DataTransfer().files; } catch { /* Safari */ }
        }
        if (filePrev) { filePrev.style.display = 'none'; filePrev.innerHTML = ''; }
    });
}

document.querySelectorAll('.ai__container').forEach(container => {
    const input = container.querySelector('.ai__chat-input');
    const sendBtn = container.querySelector('.ai__chat-button_send');
    const stopBtn = container.querySelector('.ai__chat-button_stop');
    const fileInputEl = container.querySelector('.ai__file-input');
    const filePrev = container.querySelector('.ai__file-preview');

    if (!input || !sendBtn) return;  // средний контейнер с кнопками передачи

    // Отправка по кнопке
    sendBtn.addEventListener('click', () => sendMessage(container));

    // Отправка по Enter (Shift+Enter — новая строка)
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage(container);
        }
    });

    // Кнопка Стоп
    if (stopBtn) {
        stopBtn.addEventListener('click', () => {
            const ac = activeRequests.get(container);
            if (ac) ac.abort();
        });
    }

    // ── Превью прикреплённого файла ──────────────────────────────────
    if (fileInputEl && filePrev) {
        fileInputEl.addEventListener('change', () => {
            const file = fileInputEl.files[0];
            if (!file) { filePrev.style.display = 'none'; return; }

            filePrev.innerHTML = `
                <span class="ai__file-preview__name">📄 ${file.name}</span>
                <span class="ai__file-preview__remove" title="Убрать файл">✕</span>
            `;
            filePrev.style.display = 'flex';

            filePrev.querySelector('.ai__file-preview__remove').addEventListener('click', () => {
                fileInputEl.value = '';
                filePrev.style.display = 'none';
                filePrev.innerHTML = '';
            });
        });
    }

    // ── Drag & drop ─────────────────────────────────────────────────────
    const inputWrapper = container.querySelector('.ai__chat-input-wrapper');
    if (inputWrapper && fileInputEl) {
        const showFile = (file) => {
            if (!file || !filePrev) return;
            const dt = new DataTransfer();
            dt.items.add(file);
            fileInputEl.files = dt.files;
            fileInputEl.dispatchEvent(new Event('change'));
        };
        inputWrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            inputWrapper.classList.add('drag-over');
        });
        inputWrapper.addEventListener('dragleave', (e) => {
            if (!inputWrapper.contains(e.relatedTarget)) {
                inputWrapper.classList.remove('drag-over');
            }
        });
        inputWrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            inputWrapper.classList.remove('drag-over');
            showFile(e.dataTransfer.files[0]);
        });
    }
});

// ─── Кнопки «Передать запрос» ────────────────────────────────────────
const chatContainers = [...document.querySelectorAll('.ai__container')]
    .filter(c => c.querySelector('.ai__chat-input'));

const transferBtns = document.querySelectorAll('.ai__button');

if (transferBtns.length >= 2 && chatContainers.length >= 2) {
    // «Передать в открытый контур» — копируем последний запрос пользователя
    transferBtns[0].addEventListener('click', () => {
        const srcHistory = getHistory(chatContainers[0]);
        const lastUser = [...srcHistory].reverse().find(m => m.role === 'user');
        if (!lastUser) return;
        const dstInput = chatContainers[1].querySelector('.ai__chat-input');
        if (dstInput) {
            dstInput.value = lastUser.content;
            sendMessage(chatContainers[1]);
        }
    });

    // «Передать в закрытый контур» — копируем последний запрос пользователя
    transferBtns[1].addEventListener('click', () => {
        const srcHistory = getHistory(chatContainers[1]);
        const lastUser = [...srcHistory].reverse().find(m => m.role === 'user');
        if (!lastUser) return;
        const dstInput = chatContainers[0].querySelector('.ai__chat-input');
        if (dstInput) {
            dstInput.value = lastUser.content;
            sendMessage(chatContainers[0]);
        }
    });
}

// ═══════════════════════════════════════════════════════════════════
//  Сайдбар истории
// ═══════════════════════════════════════════════════════════════════
const histSidebar = document.getElementById('histSidebar');
const histTab = document.getElementById('histTab');
const histClear = document.getElementById('histClear');
const histNewChat = document.getElementById('histNewChat');

if (histTab) {
    histTab.addEventListener('click', (e) => {
        e.stopPropagation();
        histSidebar.classList.toggle('open');
    });
}

if (histClear) {
    histClear.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`${SERVER}/api/chats`, { method: 'DELETE' }).catch(() => { });
        const histList = document.getElementById('histList');
        histList.innerHTML = '<p class="hist-sidebar__empty">\u0412\u0430\u0448\u0438 \u0437\u0430\u043f\u0440\u043e\u0441\u044b \u043f\u043e\u044f\u0432\u044f\u0442\u0441\u044f \u0437\u0434\u0435\u0441\u044c</p>';
    });
}

if (histNewChat) {
    histNewChat.addEventListener('click', (e) => {
        e.stopPropagation();
        newChat();
        histSidebar.classList.remove('open');
    });
}

document.addEventListener('click', (e) => {
    if (histSidebar && !histSidebar.contains(e.target)) {
        histSidebar.classList.remove('open');
    }
});

loadHistoryFromDB();
