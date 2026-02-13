const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Отдаём статический HTML
app.use(express.static('public'));

// Генерация случайного цвета в HEX
function getRandomColor() {
  return '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

// Обработка подключения клиента
io.on('connection', (socket) => {
  const color = getRandomColor();
  console.log('Новый пользователь подключился:', socket.id);

  // При подключении отправляем его цвет клиенту
  socket.emit('assignColor', color);

  // Получаем сообщение от клиента
  socket.on('chatMessage', (msg) => {
    // Пересылаем всем остальным: текст + цвет отправителя
    io.emit('newMessage', {
      text: msg,
      color: color
    });
  });

  socket.on('disconnect', () => {
    console.log('Пользователь отключился:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
