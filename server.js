const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

// Создаём папку uploads
(async () => {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
})();

// Загружаем данные при старте
let appData = { users: {}, chats: {} };
loadData();

async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    appData = JSON.parse(data);
  } catch (e) {
    console.log('Создаём новую базу данных');
  }
}

// Сохраняем каждые 5 секунд
setInterval(async () => {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(appData, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения:', e);
  }
}, 5000);

// Статика
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Загрузка файлов
app.use(express.raw({ type: '*/*', limit: '5MB' }));
app.post('/upload', express.raw({ type: '*/*', limit: '5MB' }), async (req, res) => {
  try {
    const contentType = req.get('Content-Type') || 'image/jpeg';
    const ext = contentType.split('/')[1] || 'jpg';
    const filename = `${uuidv4()}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);
    await fs.writeFile(filepath, req.body);
    res.json({ url: `/uploads/${filename}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Клиенты: socket → userId
const clients = new Map();

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        // === РЕГИСТРАЦИЯ ===
        case 'register':
          const { nickname, password } = msg;
          if (!nickname || nickname.length < 3 || nickname.length > 20 || !password) {
            ws.send(JSON.stringify({ type: 'error', message: 'Ник (3–20) и пароль обязательны!' }));
            return;
          }
          if (appData.users[nickname]) {
            ws.send(JSON.stringify({ type: 'error', message: 'Этот ник уже занят!' }));
            return;
          }
          appData.users[nickname] = { password, avatar: null };
          ws.send(JSON.stringify({ type: 'registered', nickname }));

          // Оповестить всех онлайн о новом пользователе
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              const clientId = clients.get(client);
              if (clientId && clientId !== nickname) {
                client.send(JSON.stringify({ type: 'newUser', user: nickname }));
              }
            }
          });
          break;

        // === ВХОД ===
        case 'login':
          const { nickname: loginNick, password: loginPass } = msg;
          const user = appData.users[loginNick];
          if (!user) {
            ws.send(JSON.stringify({ type: 'error', message: 'Пользователь не найден' }));
            return;
          }
          if (user.password !== loginPass) {
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' }));
            return;
          }

          clients.set(ws, loginNick);
          ws.send(JSON.stringify({
            type: 'loggedIn',
            nickname: loginNick,
            avatar: user.avatar
          }));

          // Отправить список всех пользователей (кроме себя)
          const allUsers = Object.keys(appData.users).filter(u => u !== loginNick);
          ws.send(JSON.stringify({ type: 'userList', users: allUsers }));
          break;

        // === ОТПРАВКА СООБЩЕНИЯ ===
        case 'sendMessage':
          const { to, text, image } = msg;
          const from = clients.get(ws);
          if (!from || !to) return;
          if (!appData.users[to]) {
            ws.send(JSON.stringify({ type: 'error', message: 'Получатель не найден' }));
            return;
          }

          const message = {
            id: uuidv4(),
            from,
            to,
            text: text || null,
            image: image || null,
            timestamp: Date.now()
          };

          // Инициализация чатов
          if (!appData.chats[from]) appData.chats[from] = {};
          if (!appData.chats[to]) appData.chats[to] = {};
          if (!appData.chats[from][to]) appData.chats[from][to] = [];
          if (!appData.chats[to][from]) appData.chats[to][from] = [];

          // Добавление сообщения (макс 20)
          appData.chats[from][to].push(message);
          appData.chats[to][from].push(message);
          if (appData.chats[from][to].length > 20) {
            appData.chats[from][to] = appData.chats[from][to].slice(-20);
            appData.chats[to][from] = appData.chats[to][from].slice(-20);
          }

          // Отправка сообщения
          sendToUser(from, { type: 'newMessage', message });
          sendToUser(to, { type: 'newMessage', message });
          break;

        // === ИСТОРИЯ ЧАТА ===
        case 'getChatHistory':
          const { with: peer } = msg;
          const requester = clients.get(ws);
          if (!requester || !appData.chats[requester]?.[peer]) {
            ws.send(JSON.stringify({ type: 'chatHistory', messages: [], with: peer }));
            return;
          }
          ws.send(JSON.stringify({
            type: 'chatHistory',
            messages: appData.chats[requester][peer],
            with: peer
          }));
          break;

        // === СМЕНА АВАТАРКИ ===
        case 'setAvatar':
          const { avatarUrl } = msg;
          const uid = clients.get(ws);
          if (uid && avatarUrl) {
            appData.users[uid].avatar = avatarUrl;
            sendToUser(uid, { type: 'avatarUpdated', avatar: avatarUrl });
          }
          break;
      }
    } catch (e) {
      console.error('Ошибка обработки сообщения:', e);
      ws.send(JSON.stringify({ type: 'error', message: 'Серверная ошибка' }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

// Вспомогательные функции
function sendToUser(userId, payload) {
  for (const [client, nick] of clients.entries()) {
    if (nick === userId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

// Запуск
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Rose Messenger запущен на порту ${PORT}`);
});
