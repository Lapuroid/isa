const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
dotenv.config();
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));  // or more if you want
app.use(express.static(path.join(__dirname, 'public')));

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("✅ MongoDB connected"))
  .catch(err => console.error("❌ MongoDB error:", err));

// IST Timestamp Function
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
  params: async (req, file) => {
    const isImage = file.mimetype.startsWith('image/');
    return {
      folder: 'chat_uploads',
      resource_type: isImage ? 'image' : 'raw',  // force raw for PDFs, docs etc.
    };
  }
});

const parser = multer({
  storage,
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    ];

    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true); // Accept file
    } else {
      cb(new Error('Only image, audio, or video files are allowed'), false); // Reject file
    }
  }
});

// Schema
const Message = mongoose.model('Message', {
  name: String,
  content: String,
  date: String,
  time: String,
  month: String,
  year: Number,
  timestamp: { type: Date, default: Date.now }
});


// Post route 
const UserToken = mongoose.model('UserToken', {
  username: String,
  tokens: Number,
  lastReset: Date,
});

const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

async function checkAndResetTokens(username) {
  let userToken = await UserToken.findOne({ username });
  const now = new Date();

  if (!userToken) {
    userToken = new UserToken({
      username,
      tokens: 1,
      lastReset: now
    });
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

app.post('/upload', parser.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    // req.file.path contains Cloudinary URL with correct resource_type path
    res.json({ url: req.file.path });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ message: 'Server error during upload' });
  }
});

app.post('/api/message', async (req, res) => {
  const { name, content } = req.body;
  if (!name || !content) return res.status(400).send("Missing name or content");

  // Validate message length
  if (content.length > 5000000) {
    return res.status(413).send("Message too long. Max 5000000 characters allowed.");
  }
  if (content.length < 1) {
    return res.status(400).send("Message cannot be empty.");
  }
  // Token check and update
  const userToken = await checkAndResetTokens(name);
  if (userToken.tokens <= 0) {
    return res.status(403).send("No tokens left. Wait for 2-week reset.");
  }

  userToken.tokens -= 1;
  await userToken.save();

  const timeInfo = getISTTimeDetails();

  const msg = new Message({
    name,
    content,
    ...timeInfo
  });

  await msg.save();
  res.status(201).send("Message saved");
});


// Get route
app.get('/api/messages', async (req, res) => {
  const messages = await Message.find().sort({ timestamp: 1 });
  res.json(messages);
});

app.get('/api/tokens', async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'Missing username' });

  const userToken = await checkAndResetTokens(username);
  const nextReset = new Date(userToken.lastReset.getTime() + TWO_WEEKS_MS);

  res.json({
    tokens: userToken.tokens,
    nextReset
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
