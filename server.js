const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const multer = require('multer');
const Database = require('better-sqlite3');

// ── База данных ─────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, 'chats.db'));

db.exec(`
    CREATE TABLE IF NOT EXISTS chats (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL DEFAULT 'Новый чат',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
`);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
});

const app = express();
app.use(express.json());

// ── CORS ────────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

// ── Конфигурация ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://10.165.0.45:11434';

const MODEL = process.env.OLLAMA_MODEL || 'qwen3:14b';

// ── Статические файлы ───────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'dist')));

// ════════════════════════════════════════════════════════════════════
//  API: Чаты (SQLite)
// ════════════════════════════════════════════════════════════════════

// Список всех чатов
app.get('/api/chats', (req, res) => {
    const chats = db.prepare(
        'SELECT id, name, created_at FROM chats ORDER BY created_at DESC'
    ).all();
    res.json(chats);
});

// Создать чат
app.post('/api/chats', (req, res) => {
    const name = (req.body && req.body.name) || 'Новый чат';
    const result = db.prepare('INSERT INTO chats (name) VALUES (?)').run(name);
    const chat = db.prepare('SELECT id, name, created_at FROM chats WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(chat);
});

// Переименовать чат
app.put('/api/chats/:id', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name обязателен' });
    db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    res.json({ ok: true });
});

// Удалить все чаты
app.delete('/api/chats', (req, res) => {
    db.prepare('DELETE FROM chats').run();
    res.json({ ok: true });
});

// Удалить чат
app.delete('/api/chats/:id', (req, res) => {
    db.prepare('DELETE FROM chats WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
});

// Обновить содержимое сообщения (для continueMessage)
app.put('/api/messages/:id', (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: 'content обязателен' });
    db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, req.params.id);
    res.json({ ok: true });
});

// Сообщения чата
app.get('/api/chats/:id/messages', (req, res) => {
    const messages = db.prepare(
        'SELECT id, role, content, created_at FROM messages WHERE chat_id = ? ORDER BY created_at ASC'
    ).all(req.params.id);
    res.json(messages);
});

// Сохранить сообщение + автоимя чата
app.post('/api/chats/:id/messages', (req, res) => {
    const { role, content } = req.body;
    if (!role || !content) return res.status(400).json({ error: 'role и content обязательны' });
    const result = db.prepare(
        'INSERT INTO messages (chat_id, role, content) VALUES (?, ?, ?)'
    ).run(req.params.id, role, content);

    if (role === 'user') {
        const chat = db.prepare('SELECT name FROM chats WHERE id = ?').get(req.params.id);
        if (chat && chat.name === 'Новый чат') {
            const autoName = content.slice(0, 55).replace(/\n/g, ' ').trim();
            db.prepare('UPDATE chats SET name = ? WHERE id = ?').run(autoName, req.params.id);
        }
    }
    res.status(201).json({ id: result.lastInsertRowid });
});

// ── API: стриминг через SSE ─────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Поле messages обязательно' });
    }

    // Заголовки для Server-Sent Events
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); //
    if (res.socket) res.socket.setNoDelay(true);
    res.flushHeaders();

    const systemMessages = [
        {
            role: 'system',
            content: '/no_think\nТы — профессиональный помощник. Форматируй ответы с заголовками (#, ##), списками (1., -), разделителями (---) и выделением (**жирный**, *курсив*). Отвечай на русском языке. Не используй теги <think>.'
        },
        ...messages
    ];

    let ollamaRes;

    try {
        ollamaRes = await fetch(`${OLLAMA_URL}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: MODEL,
                messages: systemMessages,
                stream: true,
                think: false,
                options: {
                    num_gpu: 999
                }
            })
        });
    } catch (err) {
        console.error('[server] Не удалось подключиться к Ollama:', err.message);
        res.write(`data: ${JSON.stringify({ error: 'Ollama недоступна. Проверь, запущен ли контейнер.' })}\n\n`);
        return res.end();
    }

    if (!ollamaRes.ok) {
        const text = await ollamaRes.text();
        console.error('[server] Ollama вернула ошибку:', text);
        res.write(`data: ${JSON.stringify({ error: `Ollama error ${ollamaRes.status}: ${text}` })}\n\n`);
        return res.end();
    }

    const decoder = new TextDecoder();
    let buffer = '';

    ollamaRes.body.on('data', (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const data = JSON.parse(line);
                const token = data.message?.content;
                if (token) {
                    res.write(`data: ${JSON.stringify({ content: token })}\n\n`);
                }
                if (data.done) {
                    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
                }
            } catch {
                // пропускаем невалидный JSON
            }
        }
    });

    ollamaRes.body.on('end', () => {
        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
    });

    ollamaRes.body.on('error', (err) => {
        console.error('[server] Ошибка стрима от Ollama:', err.message);
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
    });

    // Если клиент отключился — прерываем запрос к Ollama
    req.on('close', () => {
        ollamaRes.body.destroy();
    });
});

// ── API: Парсинг загружаемых файлов ────────────────────────────────
app.post('/api/parse-file', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не найден' });

    const { originalname, buffer } = req.file;
    const ext = path.extname(originalname).toLowerCase();

    try {
        let text = '';

        if (ext === '.docx') {
            const mammoth = require('mammoth');
            const result = await mammoth.extractRawText({ buffer });
            text = result.value;
        } else if (ext === '.xlsx' || ext === '.xls') {
            const XLSX = require('xlsx');
            const workbook = XLSX.read(buffer, { type: 'buffer' });
            text = workbook.SheetNames.map(name => {
                const ws = workbook.Sheets[name];
                return `=== Лист: ${name} ===\n${XLSX.utils.sheet_to_csv(ws)}`;
            }).join('\n\n');
        } else if (ext === '.pdf') {
            const pdfParse = require('pdf-parse');
            const data = await pdfParse(buffer);
            text = data.text;
        } else if (ext === '.pptx') {
            text = `[Файл презентации ${originalname}. Прямой парсинг PPTX пока не поддерживается. Попробуй сохранить как PDF и загрузить снова.]`;
        } else {
            text = buffer.toString('utf-8');
        }

        res.json({ text: text.trim(), filename: originalname });
    } catch (err) {
        console.error('[server] Ошибка парсинга файла:', err.message);
        res.status(500).json({ error: `Не удалось прочитать файл: ${err.message}` });
    }
});

// ── Fallback: SPA-роут ──────────────────────────────────────────────
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    if (require('fs').existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(200).send('Server is running. Run "npm run build" to serve the frontend, or use "npm run dev" (port 8080) for development.');
    }
});

app.listen(PORT, () => {
    console.log(`✓ Сервер запущен: http://localhost:${PORT}`);
    console.log(`✓ Ollama: ${OLLAMA_URL}`);
    console.log(`✓ Модель: ${MODEL}`);
});
