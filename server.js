const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Папки
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
const DATA_FILE = path.join(__dirname, 'data.json');

// Убедимся, что папки существуют
(async () => {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
})();

// Загрузка данных при старте
let appData = { users: {}, chats: {} };
loadData();

async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    appData = JSON.parse(data);
  } catch (e) {
    console.log('Нет сохранённых данных — создаём новые');
  }
}

// Сохранение каждые 10 секунд
setInterval(async () => {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(appData, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения:', e);
  }
}, 10000);

// CORS + статические файлы
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

// Обработка загрузки аватарок и фото
app.post('/upload', express.raw({ type: '*/*', limit: '5MB' }), async (req, res) => {
  try {
    const ext = req.get('Content-Type').split('/')[1] || 'jpg';
    const filename = `${uuidv4()}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);
    await fs.writeFile(filepath, req.body);
    res.json({ url: `/uploads/${filename}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// WebSocket логика
const clients = new Map(); // socket → userId

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'register':
          const { nickname } = msg;
          if (!nickname || nickname.length < 3 || nickname.length > 20) {
            ws.send(JSON.stringify({ type: 'error', message: 'Ник должен быть 3–20 символов' }));
            return;
          }
          if (appData.users[nickname]) {
            ws.send(JSON.stringify({ type: 'error', message: 'Этот ник уже занят!' }));
            return;
          }
          appData.users[nickname] = { avatar: null };
          clients.set(ws, nickname);
          ws.send(JSON.stringify({ type: 'registered', nickname }));
          broadcast({ type: 'userList', users: Object.keys(appData.users) });
          break;

        case 'sendMessage':
          const { to, text, image } = msg;
          const from = clients.get(ws);
          if (!from || !to) return;

          const chatId = [from, to].sort().join('_');
          if (!appData.chats[chatId]) appData.chats[chatId] = [];

          const message = {
            id: uuidv4(),
            from,
            to,
            text,
            image,
            timestamp: Date.now()
          };

          // Ограничиваем 20 сообщениями
          appData.chats[chatId].push(message);
          if (appData.chats[chatId].length > 20) {
            appData.chats[chatId] = appData.chats[chatId].slice(-20);
          }

          // Отправляем получателю и отправителю
          sendToUser(to, { type: 'newMessage', message });
          sendToUser(from, { type: 'newMessage', message });
          break;

        case 'getChatHistory':
          const { with: user } = msg;
          const requester = clients.get(ws);
          if (!requester) return;
          const histId = [requester, user].sort().join('_');
          const history = appData.chats[histId] || [];
          ws.send(JSON.stringify({ type: 'chatHistory', messages: history, with: user }));
          break;

        case 'setAvatar':
          const { avatarUrl } = msg;
          const uid = clients.get(ws);
          if (uid && avatarUrl) {
            appData.users[uid].avatar = avatarUrl;
            broadcast({ type: 'userList', users: Object.keys(appData.users) });
          }
          break;

        case 'getUserList':
          ws.send(JSON.stringify({ type: 'userList', users: Object.keys(appData.users) }));
          break;
      }
    } catch (e) {
      console.error(e);
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});

function sendToUser(userId, payload) {
  for (const [client, nick] of clients.entries()) {
    if (nick === userId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

function broadcast(payload) {
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  });
}

// Запуск
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Rose Messenger запущен на порту ${PORT}`);
});
