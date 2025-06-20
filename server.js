const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const path = require('path');

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// MongoDB connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ MongoDB connection error:', err));

// Mongoose Schema
const Message = mongoose.model('Message', {
  name: String,
  month: String,
  content: String,
  timestamp: { type: Date, default: Date.now }
});

// Routes
app.post('/api/message', async (req, res) => {
  const { name, month, content } = req.body;
  if (!name || !month || !content) {
    return res.status(400).send('Missing required fields');
  }
  const msg = new Message({ name, month, content });
  await msg.save();
  res.status(201).send('Message saved');
});

app.get('/api/messages', async (req, res) => {
  const messages = await Message.find().sort({ timestamp: -1 });
  res.json(messages);
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
