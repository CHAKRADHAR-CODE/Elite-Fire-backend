
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection
const MONGODB_URI = process.env.MONGODB_URI;
mongoose.connect(MONGODB_URI)
  .then(() => console.log('GRID SYNC: MongoDB connected successfully.'))
  .catch(err => console.error('GRID ERROR: Connection failed', err));

// Schemas
const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  pin: { type: String, required: true },
  role: { type: String, default: 'PLAYER' },
  balance: { type: Number, default: 0 },
  isBlocked: { type: Boolean, default: false },
  isDeleted: { type: Boolean, default: false },
  canCreateMatch: { type: Boolean, default: false },
  totalMatchesPaid: { type: Number, default: 0 },
  createdAt: { type: Number, default: Date.now }
});

const MatchSchema = new mongoose.Schema({
  name: String,
  teamA: [{ userId: String, username: String, betAmount: Number, paid: Boolean }],
  teamB: [{ userId: String, username: String, betAmount: Number, paid: Boolean }],
  winningTeam: String,
  status: { type: String, default: 'UNDECIDED' },
  createdAt: { type: Number, default: Date.now }
});

const TransactionSchema = new mongoose.Schema({
  userId: String,
  amount: Number,
  type: String,
  description: String,
  timestamp: { type: Number, default: Date.now }
});

const NotificationSchema = new mongoose.Schema({
  userId: String,
  message: String,
  timestamp: { type: Number, default: Date.now },
  isRead: { type: Boolean, default: false }
});

const User = mongoose.model('User', UserSchema);
const Match = mongoose.model('Match', MatchSchema);
const Transaction = mongoose.model('Transaction', TransactionSchema);
const Notification = mongoose.model('Notification', NotificationSchema);

// API Routes
app.post('/api/login', async (req, res) => {
  const { email, pin } = req.body;
  const user = await User.findOne({ email: email.toLowerCase(), pin, isDeleted: false });
  if (!user) return res.status(401).json({ message: 'Signal Mismatch: Invalid Credentials.' });
  if (user.isBlocked) return res.status(403).json({ message: 'Operative blocked by High Command.' });
  res.json(user);
});

app.post('/api/users', async (req, res) => {
  try {
    const user = new User(req.body);
    await user.save();
    res.json(user);
  } catch (err) {
    res.status(400).json({ message: 'Identity Conflict: Codename or Email already deployed.' });
  }
});

app.get('/api/users', async (req, res) => {
  const users = await User.find({ isDeleted: false });
  res.json(users);
});

app.patch('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(user);
  } catch (err) {
    res.status(400).json({ message: 'Update failed' });
  }
});

app.post('/api/users/:userId/adjust', async (req, res) => {
  try {
    const { userId } = req.params;
    const { amount, description } = req.body;
    const user = await User.findByIdAndUpdate(userId, { $inc: { balance: amount } }, { new: true });
    if (user) {
      await new Transaction({ userId, amount, type: 'ADMIN_ADJUST', description }).save();
      await new Notification({ userId, message: `System Adjustment: ${amount >= 0 ? '+' : ''}${amount} credits (${description})` }).save();
      res.json(user);
    } else {
      res.status(404).json({ message: 'User not found' });
    }
  } catch (err) {
    res.status(400).json({ message: 'Adjustment failed' });
  }
});

app.get('/api/matches', async (req, res) => {
  const matches = await Match.find().sort({ createdAt: -1 });
  res.json(matches);
});

app.post('/api/matches', async (req, res) => {
  const match = new Match(req.body);
  await match.save();
  res.json(match);
});

app.patch('/api/matches/:id/settle', async (req, res) => {
  const { id } = req.params;
  const { winningTeam } = req.body;
  const match = await Match.findById(id);
  if (!match || match.status === 'SETTLED') return res.status(400).send();

  match.status = 'SETTLED';
  match.winningTeam = winningTeam;
  await match.save();

  // Process Balances
  const winners = winningTeam === 'A' ? match.teamA : match.teamB;
  const losers = winningTeam === 'A' ? match.teamB : match.teamA;

  for (const p of winners) {
    await User.findByIdAndUpdate(p.userId, { $inc: { balance: p.betAmount } });
    await new Transaction({ userId: p.userId, amount: p.betAmount, type: 'WIN', description: `Victory: ${match.name}` }).save();
  }
  for (const p of losers) {
    await User.findByIdAndUpdate(p.userId, { $inc: { balance: -p.betAmount } });
    await new Transaction({ userId: p.userId, amount: -p.betAmount, type: 'LOSS', description: `Defeat: ${match.name}` }).save();
  }

  res.json(match);
});

app.post('/api/matches/:id/pay/:userId', async (req, res) => {
  try {
    const { id, userId } = req.params;
    const match = await Match.findById(id);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    
    // Find player in teams
    let found = false;
    [match.teamA, match.teamB].forEach(team => {
      const p = team.find(player => player.userId === userId);
      if (p) {
        p.paid = true;
        found = true;
      }
    });

    if (found) {
      await match.save();
      await User.findByIdAndUpdate(userId, { $inc: { totalMatchesPaid: 1 } });
      res.json(match);
    } else {
      res.status(404).json({ message: 'Player not found in match' });
    }
  } catch (err) {
    res.status(400).json({ message: 'Payment failed' });
  }
});

app.get('/api/transactions', async (req, res) => {
  const txs = await Transaction.find().sort({ timestamp: -1 });
  res.json(txs);
});

app.get('/api/transactions/:userId', async (req, res) => {
  const txs = await Transaction.find({ userId: req.params.userId }).sort({ timestamp: -1 });
  res.json(txs);
});

app.get('/api/notifications/:userId', async (req, res) => {
  const notifs = await Notification.find({ userId: req.params.userId }).sort({ timestamp: -1 });
  res.json(notifs);
});

app.post('/api/notifications/:userId/read', async (req, res) => {
  await Notification.updateMany({ userId: req.params.userId, isRead: false }, { isRead: true });
  res.json({ success: true });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`BATTLESTATION ONLINE ON PORT ${PORT}`));
