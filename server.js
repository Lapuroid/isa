const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve login.html at root instead of index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

function getISTTimeDetails() {
  const date = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(date.getTime() + istOffset);
  return {
    date: ist.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
    time: ist.toLocaleTimeString('en-IN'),
    month: ist.toLocaleString('en-IN', { month: 'long' }),
    year: ist.getFullYear()
  };
}

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: 'chat_uploads',
    resource_type: file.mimetype.startsWith('image/') ? 'image' : 'raw'
  }),
});

const parser = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'), false);
  }
});

// MongoDB Schemas
const Message = mongoose.model('Message', {
  name: String,
  content: String,
  date: String,
  time: String,
  month: String,
  year: Number,
  timestamp: { type: Date, default: Date.now }
});

const UserToken = mongoose.model('UserToken', {
  username: String,
  tokens: Number,
  lastReset: Date,
});

const User = mongoose.model('User', {
  username: { type: String, unique: true },
  passwordHash: String,
  securityAnswers: [String],
});

const TWO_WEEKS_MS = 30 * 24 * 60 * 60 * 1000;

async function checkAndResetTokens(username) {
  let userToken = await UserToken.findOne({ username });
  const now = new Date();
  if (!userToken) {
    userToken = new UserToken({ username, tokens: 1, lastReset: now });
    await userToken.save();
    return userToken;
  }
  if (now - userToken.lastReset >= TWO_WEEKS_MS) {
    userToken.tokens += 1;
    userToken.lastReset = now;
    await userToken.save();
  }
  return userToken;
}

// JWT authentication middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Expect: "Bearer TOKEN"

  if (!token) return res.status(401).send('Access token missing');

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(401).send('Invalid or expired token');
    req.user = user; // Attach decoded token (username etc) to request
    next();
  });
}

// Upload
app.post('/upload', parser.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
  res.json({ url: req.file.path });
});

// Message send (protected)
app.post('/api/message', authenticateToken, async (req, res) => {
  const { content } = req.body;
  const name = req.user.username;

  if (!content) return res.status(400).send("Missing content");
  if (content.length > 5000000) return res.status(413).send("Message too long");
  if (content.length < 1) return res.status(400).send("Empty message");

  const userToken = await checkAndResetTokens(name);
  if (userToken.tokens <= 0) return res.status(403).send("No tokens left. Wait for reset");

  userToken.tokens -= 1;
  await userToken.save();

  const msg = new Message({ name, content, ...getISTTimeDetails() });
  await msg.save();
  res.status(201).send("Message saved");
});

// Fetch messages (protected)
app.get('/api/messages', authenticateToken, async (req, res) => {
  const messages = await Message.find().sort({ timestamp: 1 });
  res.json(messages);
});

// Token info (protected)
app.get('/api/tokens', authenticateToken, async (req, res) => {
  const { username } = req.user;
  const userToken = await checkAndResetTokens(username);
  const nextReset = new Date(userToken.lastReset.getTime() + TWO_WEEKS_MS);
  res.json({ tokens: userToken.tokens, nextReset });
});

// Login (open)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  try {
    const user = await User.findOne({ username });
    if (!user) return res.status(404).send("bro wrong username- skill issue *sigh*");

    if (password !== process.env.SHARED_PASSWORD) {
      return res.status(401).send("Invalid password");
    }

    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Server error");
  }
});

// Recovery (open)
app.post('/api/recover', async (req, res) => {
  const { username, answers } = req.body;

  const user = await User.findOne({ username });
  if (!user) return res.status(404).send("User not found");

  if (!Array.isArray(answers) || answers.length !== 5) {
    return res.status(400).send("Must provide 5 answers");
  }

  const storedHashes = [
    process.env.SECURITY_ANSWER_1,
    process.env.SECURITY_ANSWER_2,
    process.env.SECURITY_ANSWER_3,
    process.env.SECURITY_ANSWER_4,
    process.env.SECURITY_ANSWER_5
  ];

  let correct = 0;
  for (let i = 0; i < 5; i++) {
    const ans = answers[i].toLowerCase().trim();
    const hash = storedHashes[i];

    if (ans === "" || !hash) {
      // Skip empty answer or missing hash
      continue;
    }

    if (await bcrypt.compare(ans, hash)) {
      correct++;
    }
  }

  if (correct >= 3) {
    res.json({ codeword: process.env.SHARED_PASSWORD || "💡 DefaultCodeword" });
  } else {
    res.status(403).send("Not enough correct answers");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));