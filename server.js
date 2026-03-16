require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: 1e6,
});

// Prevent crash on unhandled errors
process.on("uncaughtException", (err) => console.error("Uncaught:", err.message));
process.on("unhandledRejection", (err) => console.error("Unhandled:", err));

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- State ---
let questions = [];
const players = {}; // socketId -> { name, score, currentQ, finished }
let quizOpen = false;

// --- Helpers ---
function getLeaderboard() {
  return Object.values(players)
    .sort((a, b) => b.score - a.score)
    .map(({ name, score, currentQ, finished }) => ({
      name,
      score,
      finished,
      progress: Math.min(currentQ, questions.length),
      total: questions.length,
    }));
}

function stripAnswer(q) {
  return { question: q.question, options: q.options, time: q.time || 15 };
}

// --- Throttled leaderboard (batches updates every 500ms) ---
let lbDirty = false;
let lbTimer = null;
function broadcastLeaderboard() {
  lbDirty = true;
  if (!lbTimer) {
    lbTimer = setTimeout(() => {
      lbTimer = null;
      if (lbDirty) {
        lbDirty = false;
        io.emit("leaderboard", getLeaderboard());
      }
    }, 500);
  }
}

// --- Admin Auth ---
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Workshop";

function adminAuth(req, res, next) {
  const pw = req.headers["x-admin-password"];
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
  next();
}

app.post("/api/admin/login", async (req, res) => {
  const password = req.body?.password;
  console.log("Login attempt:", JSON.stringify(password), "expected:", JSON.stringify(ADMIN_PASSWORD), "match:", password === ADMIN_PASSWORD);
  if (password && password === ADMIN_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ error: "Wrong password" });
});

// --- Admin REST API ---
app.get("/api/questions", adminAuth, (req, res) => {
  res.json({ questions, quizOpen });
});

app.post("/api/questions", adminAuth, (req, res) => {
  const q = req.body;
  if (!q.question || !q.options || q.options.length < 2 || q.answer == null) {
    return res.status(400).json({ error: "Invalid question" });
  }
  questions.push({ question: q.question, options: q.options, answer: q.answer, time: q.time || 15 });
  res.json({ ok: true, count: questions.length });
});

app.put("/api/questions/:index", adminAuth, (req, res) => {
  const i = parseInt(req.params.index);
  if (i < 0 || i >= questions.length) return res.status(404).json({ error: "Not found" });
  const q = req.body;
  questions[i] = { question: q.question, options: q.options, answer: q.answer, time: q.time || 15 };
  res.json({ ok: true });
});

app.delete("/api/questions/:index", adminAuth, (req, res) => {
  const i = parseInt(req.params.index);
  if (i < 0 || i >= questions.length) return res.status(404).json({ error: "Not found" });
  questions.splice(i, 1);
  res.json({ ok: true, count: questions.length });
});

app.post("/api/quiz/start", adminAuth, (req, res) => {
  if (questions.length === 0) return res.status(400).json({ error: "Add questions first" });
  quizOpen = true;
  Object.keys(players).forEach((k) => delete players[k]);
  io.emit("quiz-started");
  broadcastLeaderboard();
  res.json({ ok: true });
});

app.post("/api/quiz/stop", adminAuth, (req, res) => {
  quizOpen = false;
  io.emit("quiz-stopped");
  res.json({ ok: true });
});

app.post("/api/quiz/reset", adminAuth, (req, res) => {
  quizOpen = false;
  Object.keys(players).forEach((k) => delete players[k]);
  io.emit("quiz-reset");
  io.emit("leaderboard", []);
  res.json({ ok: true });
});

app.post("/api/generate", adminAuth, async (req, res) => {
  const { topic, count } = req.body;
  const n = Math.min(count || 5, 20);
  if (!topic || !topic.trim()) return res.status(400).json({ error: "Provide a topic" });

  const keys = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_FALLBACK].filter(Boolean);
  if (keys.length === 0) return res.status(500).json({ error: "Set OPENROUTER_API_KEY env variable" });

  let lastErr;
  for (const key of keys) {
    try {
      const generated = await generateWithAI(topic.trim(), n, key);
      questions.push(...generated);
      return res.json({ ok: true, generated, count: questions.length });
    } catch (err) {
      console.error(`AI generation error (key ...${key.slice(-4)}):`, err.message);
      lastErr = err;
    }
  }
  res.status(500).json({ error: "Failed to generate questions: " + lastErr.message });
});

async function generateWithAI(topic, count, apiKey) {
  const prompt = `Generate exactly ${count} multiple-choice quiz questions about "${topic}".

Return ONLY a valid JSON array, no markdown, no explanation. Each element must have:
- "question": string
- "options": array of exactly 4 strings
- "answer": index (0-3) of the correct option
- "time": 15

Example format:
[{"question":"What is 2+2?","options":["3","4","5","6"],"answer":1,"time":15}]`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "nvidia/nemotron-3-super-120b-a12b:free",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  const content = data.choices[0].message.content.trim();

  const jsonMatch = content.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error("AI did not return valid JSON");

  const parsed = JSON.parse(jsonMatch[0]);

  return parsed.slice(0, count).map((q) => ({
    question: String(q.question),
    options: q.options.slice(0, 4).map(String),
    answer: Math.min(Math.max(0, parseInt(q.answer) || 0), 3),
    time: 15,
  }));
}

// --- Socket.IO ---
io.on("connection", (socket) => {
  socket.emit("quiz-state", { open: quizOpen, questionCount: questions.length });
  socket.emit("leaderboard", getLeaderboard());

  socket.on("join", (name) => {
    if (!quizOpen) return socket.emit("error-msg", "Quiz hasn't started yet!");
    if (questions.length === 0) return socket.emit("error-msg", "No questions available!");
    if (typeof name !== "string") return;
    const trimmed = name.trim().slice(0, 30);
    if (!trimmed) return;
    // Prevent duplicate joins on same socket
    if (players[socket.id]) return;
    players[socket.id] = { name: trimmed, score: 0, currentQ: 0, finished: false };
    socket.emit("question", { index: 0, total: questions.length, ...stripAnswer(questions[0]) });
    broadcastLeaderboard();
  });

  socket.on("answer", (data) => {
    if (!data || typeof data !== "object") return;
    const { index, selected, timeTaken } = data;
    const p = players[socket.id];
    if (!p || p.finished || index !== p.currentQ) return;

    const q = questions[index];
    if (!q) return;
    const correct = selected === q.answer;
    if (correct) {
      const timeLimit = q.time || 15;
      const speedBonus = Math.round(Math.max(0, (1 - timeTaken / timeLimit)) * 100);
      p.score += 100 + speedBonus;
    }

    p.currentQ++;

    const isFinished = p.currentQ >= questions.length;
    if (isFinished) p.finished = true;

    socket.emit("result", {
      correct,
      correctAnswer: q.answer,
      score: p.score,
      finished: isFinished,
      total: questions.length,
    });

    broadcastLeaderboard();
  });

  socket.on("next", () => {
    const p = players[socket.id];
    if (!p || p.finished) return;
    if (p.currentQ >= questions.length) {
      p.finished = true;
      socket.emit("finished", { score: p.score, total: questions.length });
    } else {
      socket.emit("question", {
        index: p.currentQ,
        total: questions.length,
        ...stripAnswer(questions[p.currentQ]),
      });
    }
  });

  socket.on("disconnect", () => {
    delete players[socket.id];
    broadcastLeaderboard();
  });
});

// --- Start ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`Quiz server running at http://0.0.0.0:${PORT}`);
  console.log(`Admin panel:   http://0.0.0.0:${PORT}/admin.html`);
  console.log(`Student quiz:  http://0.0.0.0:${PORT}`);
  console.log(`Leaderboard:   http://0.0.0.0:${PORT}/leaderboard.html`);
});
