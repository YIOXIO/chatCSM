// Инициализация подключения SignalR
const connectionMainHub = new signalR.HubConnectionBuilder()
    .withUrl("/aiHub")
    .configureLogging(signalR.LogLevel.Information)
    .build();

// Запуск подключения
connectionMainHub.start()
    .catch(err => console.error('Ошибка подключения:', err.toString()));

let currentMessageElement = null;

function addMessageToChat(message, isUser = false) {
    const messagesContainer = document.querySelector('.ai__chat-messages');
    const messageElement = document.createElement('article');
    messageElement.classList.add('ai__chat-message');
    messageElement.classList.add(isUser ? 'ai__chat-message_user' : 'ai__chat-message_ai');

    if (isUser) {
        const formattedMessage = formatMessage(message);
        messageElement.innerHTML = formattedMessage;
        messagesContainer.appendChild(messageElement);
    } else {
        messageElement.innerHTML = '<div class="ai__chat-message-content"></div>';
        messagesContainer.appendChild(messageElement);
        currentMessageElement = messageElement.querySelector('.ai__chat-message-content');
    }

    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return messageElement;
}

async function streamMessage(fullMessage) {
    if (!currentMessageElement) return;

    const chunks = fullMessage.split(/(\s+)/);
    let currentText = '';

    for (const chunk of chunks) {
        currentText += chunk;
        const formattedChunk = formatMessage(currentText);
        currentMessageElement.innerHTML = formattedChunk.replace(/^<div class="ai__chat-message-content">|<\/div>$/g, '');
        const messagesContainer = document.querySelector('.ai__chat-messages');
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

function cleanAIResponse(rawText) {
    if (!rawText) return "";

    return String(rawText)
        .replace(/<think>.*?<\/think>/gs, '')
        .replace(/[\u4E00-\u9FFF]+/g, '')
        .replace(/[a-zA-Z]+/g, '')
        .replace(/\([^)]*\)|\{[^}]*\}|\[[^\]]*\]/g, '')
        .replace(/\n+/g, '\n')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

function formatMessage(rawText) {
    let text = rawText.trim();
    if (!text) return '<div class="ai__chat-message-content"></div>';

    let result = '';
    let lines = text.split('\n');
    let inList = false;
    let listType = null;
    let listContent = '';

    for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        // Заголовки
        if (line.startsWith('# ')) {
            if (inList) {
                result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                inList = false;
                listContent = '';
            }
            result += `<h2 class="ai__chat-message-h2">${line.slice(2).trim()}</h2>`;
        } else if (line.startsWith('## ')) {
            if (inList) {
                result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                inList = false;
                listContent = '';
            }
            result += `<h3 class="ai__chat-message-h3">${line.slice(3).trim()}</h3>`;
        } else if (line.startsWith('### ')) {
            if (inList) {
                result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                inList = false;
                listContent = '';
            }
            result += `<h4 class="ai__chat-message-h4">${line.slice(4).trim()}</h4>`;
        } else if (line.startsWith('#### ')) {
            if (inList) {
                result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                inList = false;
                listContent = '';
            }
            result += `<h5 class="ai__chat-message-h5">${line.slice(5).trim()}</h5>`;
        } else if (line.startsWith('##### ')) {
            if (inList) {
                result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                inList = false;
                listContent = '';
            }
            result += `<h5 class="ai__chat-message-h5">${line.slice(6).trim()}</h5>`;
        }
        // Разделитель
        else if (line === '---') {
            if (inList) {
                result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                inList = false;
                listContent = '';
            }
            result += '<hr class="ai__chat-message-hr">';
        }
        // Нумерованный список
        else if (line.match(/^\d+\.\s/)) {
            if (!inList || listType !== 'ol') {
                if (inList) {
                    result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                }
                inList = true;
                listType = 'ol';
                listContent = '';
            }
            listContent += line.replace(/^\d+\.\s(.+)$/gm, '<li class="ai__chat-message-li">$1</li>');
        }
        // Маркированный список
        else if (line.match(/^[\s•\-]+\s/)) {
            if (!inList || listType !== 'ul') {
                if (inList) {
                    result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                }
                inList = true;
                listType = 'ul';
                listContent = '';
            }
            listContent += line.replace(/^[\s•\-]+\s(.+)$/gm, '<li class="ai__chat-message-li">$1</li>');
        }
        // Обычный текст
        else {
            if (inList) {
                result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
                inList = false;
                listContent = '';
            }
            result += `<p>${line}</p>`;
        }
    }

    // Закрываем последний список, если он открыт
    if (inList) {
        result += listType === 'ol' ? `<ol class="ai__chat-message-ol">${listContent}</ol>` : `<ul class="ai__chat-message-ul">${listContent}</ul>`;
    }

    // Применяем выделение текста
    result = result
        .replace(/\*\*([^*]+)\*\*/g, '<span class="ai__chat-message-highlight">$1</span>')
        .replace(/\*([^*]+)\*/g, '<i class="ai__chat-message-italic">$1</i>')
        .replace(/<b>(.*?)<\/b>/gi, '<span class="ai__chat-message-highlight">$1</span>')
        .replace(/<strong>(.*?)<\/strong>/gi, '<span class="ai__chat-message-highlight">$1</span>')
        .replace(/<i>(.*?)<\/i>/gi, '<i class="ai__chat-message-italic">$1</i>')
        .replace(/<em>(.*?)<\/em>/gi, '<i class="ai__chat-message-italic">$1</i>');

    return `<div class="ai__chat-message-content">${result}</div>`;
}

// Функция для добавления loader'а в конец чата
function addTypingLoader() {
    const messagesContainer = document.querySelector('.ai__chat-messages');
    const loader = document.createElement('div');
    loader.classList.add('ai__typing-loader');
    loader.innerHTML = `
        <span class="ai__typing-text">Анализирует</span>
        <span class="dot"></span>
        <span class="dot"></span>
        <span class="dot"></span>
    `;
    messagesContainer.appendChild(loader);
    messagesContainer.scrollTop = messagesContainer.scrollHeight; // Прокрутка вниз
}

// Функция для удаления loader'а
function removeTypingLoader() {
    const loader = document.querySelector('.ai__typing-loader');
    if (loader) {
        loader.remove();
    }
}

connectionMainHub.on("ReceiveMessage", (data) => {
    removeTypingLoader();

    try {
        console.log("Raw server response:", data);

        let rawMessage;
        if (data === null || data === undefined) {
            rawMessage = "";
        } else if (typeof data === 'object' && data.answer) {
            rawMessage = data.answer;
        } else if (typeof data === 'string') {
            try {
                const parsed = JSON.parse(data);
                rawMessage = parsed.answer || parsed.message || data;
            } catch {
                rawMessage = data;
            }
        } else {
            rawMessage = String(data);
        }

        const cleanedMessage = cleanAIResponse(rawMessage);
        console.log("Cleaned message:", cleanedMessage);

        if (cleanedMessage && cleanedMessage.trim() !== "") {
            addMessageToChat("", false);
            streamMessage(cleanedMessage);
        }

    } catch (e) {
        console.error("Ошибка обработки ответа:", e);
        addMessageToChat("Ошибка обработки ответа. Подробности в консоли.");
    }
});

connectionMainHub.on("Error", (errorMessage) => {
    toggleTypingLoader(false);
    addMessageToChat(`Ошибка: ${errorMessage}`);
});

async function sendMessage() {
    const input = document.querySelector('.ai__chat-input');
    const message = input.value.trim();
    if (!message) return;

    addMessageToChat(message, true);
    input.value = '';
    addTypingLoader();

    const formattedPrompt = `${message}. Ты — профессиональный помощник. Форматируй ответы с заголовками (#, ##), списками (1., -), разделителями (---) и выделением (**жирный**, *курсив*). Отвечай на русском языке.`;
    const apiKey = 'API_KEY';
    const model = currentContour === 'closed' ? 'deepseek' : 'chatgpt';

    try {
        await connectionMainHub.invoke("SendMessage", {
            message: formattedPrompt,
            model: model,
            apiKey: apiKey
        });
    } catch (err) {
        console.error('Ошибка отправки:', err.toString());
        toggleTypingLoader(false);
        addMessageToChat('Ошибка соединения с сервером');
    }
}

document.querySelector('.ai__chat-button').addEventListener('click', sendMessage);

document.querySelector('.ai__chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

let currentContour = 'closed';

document.querySelectorAll('.ai__button').forEach(button => {
    button.addEventListener('click', () => {
        currentContour = button.textContent.includes('открытый') ? 'open' : 'closed';
        console.log(`Переключено на ${currentContour === 'open' ? 'Открытый' : 'Закрытый'} контур`);
    });
});