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

(async () => {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
})();

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

setInterval(async () => {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(appData, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения:', e);
  }
}, 5000);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));

app.use(express.raw({ type: '*/*', limit: '10MB' }));
app.post('/upload', express.raw({ type: '*/*', limit: '10MB' }), async (req, res) => {
  try {
    const contentType = req.get('Content-Type') || 'application/octet-stream';
    let ext = 'bin';
    if (contentType.startsWith('image/')) {
      ext = contentType.split('/')[1] || 'jpg';
    } else if (contentType.startsWith('audio/')) {
      ext = contentType.split('/')[1] || 'webm';
    }
    const filename = `${uuidv4()}.${ext}`;
    const filepath = path.join(UPLOAD_DIR, filename);
    await fs.writeFile(filepath, req.body);
    res.json({ url: `/uploads/${filename}` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Upload failed' });
  }
});

const clients = new Map();

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
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

          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              const clientId = clients.get(client);
              if (clientId && clientId !== nickname) {
                client.send(JSON.stringify({ type: 'newUser', user: nickname }));
              }
            }
          });
          break;

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

          const allUsers = Object.keys(appData.users).filter(u => u !== loginNick);
          ws.send(JSON.stringify({ type: 'userList', users: allUsers }));
          break;

        case 'sendMessage':
          const { to, text, image, audio } = msg;
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
            audio: audio || null,
            timestamp: Date.now()
          };

          if (!appData.chats[from]) appData.chats[from] = {};
          if (!appData.chats[to]) appData.chats[to] = {};
          if (!appData.chats[from][to]) appData.chats[from][to] = [];
          if (!appData.chats[to][from]) appData.chats[to][from] = [];

          appData.chats[from][to].push(message);
          appData.chats[to][from].push(message);
          if (appData.chats[from][to].length > 20) {
            appData.chats[from][to] = appData.chats[from][to].slice(-20);
            appData.chats[to][from] = appData.chats[to][from].slice(-20);
          }

          sendToUser(from, { type: 'newMessage', message });
          sendToUser(to, { type: 'newMessage', message });
          break;

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

function sendToUser(userId, payload) {
  for (const [client, nick] of clients.entries()) {
    if (nick === userId && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Rose Messenger запущен на порту ${PORT}`);
});
