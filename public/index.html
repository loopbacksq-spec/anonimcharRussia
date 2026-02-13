// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" } // важно для Render
});

app.use(express.static('public'));

io.on('connection', (socket) => {
  console.log('Пользователь подключился:', socket.id);

  // Присоединение к комнате по ID
  socket.on('joinRoom', (userId) => {
    socket.join(userId);
    console.log(`Пользователь ${socket.id} вошёл в комнату ${userId}`);
  });

  // Отправка сообщения в конкретную комнату (чат с другим ID)
  socket.on('privateMessage', ({ fromId, toId, text }) => {
    const room = [fromId, toId].sort().join('-'); // уникальное имя комнаты
    socket.to(room).emit('receiveMessage', {
      fromId,
      text,
      timestamp: Date.now()
    });
    // Также отправляем себе (для отображения)
    socket.emit('receiveMessage', {
      fromId,
      text,
      timestamp: Date.now()
    });
    // Присоединяем обоих к комнате
    socket.join(room);
    // Найдём второй сокет и тоже добавим его (если онлайн)
    const recipientSockets = Array.from(io.sockets.sockets.values())
      .filter(s => s.rooms.has(toId));
    if (recipientSockets.length > 0) {
      recipientSockets[0].join(room);
    }
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
