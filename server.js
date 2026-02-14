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

// Загрузка данных
let appData = { users: {}, chats: {} }; // chats: { userId: { [peerId]: [msg] } }
loadData();

async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, 'utf8');
    appData = JSON.parse(data);
  } catch (e) {
    console.log('Нет сохранённых данных');
  }
}

setInterval(async () => {
  try {
    await fs.writeFile(DATA_FILE, JSON.stringify(appData, null, 2));
  } catch (e) {
    console.error('Ошибка сохранения:', e);
  }
}, 10000);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOAD_DIR));
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

const clients = new Map(); // socket → userId

wss.on('connection', (ws) => {
  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'register':
          const { nickname, password } = msg;
          if (!nickname || nickname.length < 3 || nickname.length > 20 || !password) {
            ws.send(JSON.stringify({ type: 'error', message: 'Неверные данные' }));
            return;
          }
          if (appData.users[nickname]) {
            ws.send(JSON.stringify({ type: 'error', message: 'Ник занят!' }));
            return;
          }
          appData.users[nickname] = { password, avatar: null };
          clients.set(ws, nickname);
          ws.send(JSON.stringify({ type: 'registered', nickname }));
          break;

        case 'login':
          const { nickname: loginNick, password: loginPass } = msg;
          const user = appData.users[loginNick];
          if (!user || user.password !== loginPass) {
            ws.send(JSON.stringify({ type: 'error', message: 'Неверный пароль' }));
            return;
          }
          clients.set(ws, loginNick);
          ws.send(JSON.stringify({ type: 'loggedIn', nickname: loginNick, avatar: user.avatar }));
          // Отправляем список чатов пользователя
          const userChats = appData.chats[loginNick] || {};
          const chatList = Object.keys(userChats).map(peer => ({
            peer,
            lastMessage: userChats[peer][userChats[peer].length - 1]
          }));
          ws.send(JSON.stringify({ type: 'chatList', chats: chatList }));
          break;

        case 'sendMessage':
          const { to, text, image } = msg;
          const from = clients.get(ws);
          if (!from || !to || !appData.users[to]) return;

          const message = {
            id: uuidv4(),
            from,
            to,
            text,
            image,
            timestamp: Date.now()
          };

          // Убедимся, что чат существует у обоих
          if (!appData.chats[from]) appData.chats[from] = {};
          if (!appData.chats[to]) appData.chats[to] = {};

          if (!appData.chats[from][to]) appData.chats[from][to] = [];
          if (!appData.chats[to][from]) appData.chats[to][from] = [];

          // Добавляем сообщение (макс 20)
          appData.chats[from][to].push(message);
          appData.chats[to][from].push(message);
          if (appData.chats[from][to].length > 20) {
            appData.chats[from][to] = appData.chats[from][to].slice(-20);
            appData.chats[to][from] = appData.chats[to][from].slice(-20);
          }

          // Отправляем обоим
          sendToUser(from, { type: 'newMessage', message });
          sendToUser(to, { type: 'newMessage', message });

          // Обновляем списки чатов
          sendToUser(from, {
            type: 'chatList',
            chats: Object.keys(appData.chats[from]).map(p => ({
              peer: p,
              lastMessage: appData.chats[from][p][appData.chats[from][p].length - 1]
            }))
          });
          sendToUser(to, {
            type: 'chatList',
            chats: Object.keys(appData.chats[to]).map(p => ({
              peer: p,
              lastMessage: appData.chats[to][p][appData.chats[to][p].length - 1]
            }))
          });
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Rose Messenger запущен на порту ${PORT}`);
});
