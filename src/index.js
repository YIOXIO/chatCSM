import './index.css';

// Функция для добавления сообщения в чат
function addMessageToChat(message, isUser = false) {
    const messagesContainer = document.querySelector('.ai__chat-messages');
    const messageElement = document.createElement('article');
    messageElement.classList.add('ai__chat-message');
    messageElement.classList.add(isUser ? 'ai__chat-message_user' : 'ai__chat-message_ai');
    const textElement = document.createElement('p');
    textElement.textContent = message;
    messageElement.appendChild(textElement);
    messagesContainer.appendChild(messageElement);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}


function toggleTypingLoader(show = true) {
    const loader = document.querySelector('.ai__typing-loader');
    if (show) {
        loader.style.display = 'flex';
    } else {
        loader.style.display = 'none';
    }
}

// Функция отправки запроса к API Open WebUI
async function sendMessage() {
    const input = document.querySelector('.ai__chat-input');
    const message = input.value.trim();
    if (!message) return;

    addMessageToChat(message, true);
    input.value = '';

    toggleTypingLoader(true);

    const apiKey = 'API_KEY';
    const url = 'http://localhost:3000/api/chat/completions';
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
    };
    const body = JSON.stringify({
        model: currentContour === 'closed' ? 'deepseek' : 'chatgpt', 
        messages: [{ role: 'user', content: message }]
    });

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: headers,
            body: body
        });

        if (!response.ok) throw new Error('Ошибка API');

        const data = await response.json();
        const aiResponse = data.choices[0].message.content;
        toggleTypingLoader(false); 
        addMessageToChat(aiResponse);
    } catch (error) {
        console.error('Ошибка:', error);
        toggleTypingLoader(false); 
        addMessageToChat('Произошла ошибка при обращении к ИИ');
    }
}


document.querySelector('.ai__chat-button').addEventListener('click', sendMessage);

document.querySelector('.ai__chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
});

// Переключение контуров
let currentContour = 'closed';

document.querySelectorAll('.ai__button').forEach(button => {
    button.addEventListener('click', () => {
        if (button.textContent.includes('открытый')) {
            currentContour = 'open';
            console.log('Переключено на Открытый контур');
        } else {
            currentContour = 'closed';
            console.log('Переключено на Закрытый контур');
        }
    });
});