// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const Groq = require('groq-sdk');

const app = express();
const PORT = process.env.PORT || 3000;

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(cors());
app.use(express.json());

// memory storage — files never touch disk, just held as buffers in RAM
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

// ---------- health check ----------
app.get('/', (req, res) => {
  res.json({ status: 'PrepMate backend is running' });
});

// ---------- 1. GENERATE QUIZ QUESTION ----------
app.post('/api/generate-question', async (req, res) => {
  try {
    const { subject, topic } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const prompt = `Generate one multiple-choice exam-style practice question for the subject "${subject}"${topic ? `, focused on the topic "${topic}"` : ''}.
Return ONLY valid JSON, no markdown, no extra text, in this exact shape:
{
  "question": "the question text",
  "options": ["option A", "option B", "option C", "option D"],
  "correctIndex": 0,
  "explanation": "a short, clear explanation of why the correct answer is right"
}`;

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    });

    const raw = completion.choices[0].message.content.trim();
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const questionData = JSON.parse(cleaned);

    res.json(questionData);
  } catch (err) {
    console.error('generate-question error:', err.message);
    res.status(500).json({ error: 'Failed to generate question' });
  }
});

// ---------- 2. IMAGE HELP (upload a photo, AI explains/answers it) ----------
app.post('/api/image-help', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'image file is required' });
    const userQuestion = req.body.question || 'Look at this image and help me understand and solve it. Explain step by step.';

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const completion = await groq.chat.completions.create({
      model: 'meta-llama/llama-4-maverick-17b-128e-instruct',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userQuestion },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }
      ],
      temperature: 0.4
    });

    res.json({ answer: completion.choices[0].message.content });
  } catch (err) {
    console.error('image-help error:', err.message);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

// ---------- 3. LIVE TEXT CHAT WITH AI TUTOR ----------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const messages = [
      {
        role: 'system',
        content: 'You are PrepMate, a friendly, encouraging AI study tutor. Explain concepts in simple, clear language. Keep answers focused and not too long unless the student asks for depth.'
      },
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: message }
    ];

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages,
      temperature: 0.6
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error('chat error:', err.message);
    res.status(500).json({ error: 'Failed to get AI reply' });
  }
});

// ---------- 4. VOICE CHAT (speak to AI, AI replies with voice) ----------
app.post('/api/voice-chat', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'audio file is required' });

    // Step 1: transcribe the student's voice
    const transcription = await groq.audio.transcriptions.create({
      file: new File([req.file.buffer], req.file.originalname || 'audio.webm', { type: req.file.mimetype }),
      model: 'whisper-large-v3-turbo',
      response_format: 'json'
    });
    const transcript = transcription.text;

    // Step 2: get the AI tutor's text reply
    const history = req.body.history ? JSON.parse(req.body.history) : [];
    const chatCompletion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: 'You are PrepMate, a friendly AI study tutor speaking out loud to a student. Keep replies conversational and reasonably short since they will be spoken aloud.'
        },
        ...history,
        { role: 'user', content: transcript }
      ],
      temperature: 0.6
    });
    const replyText = chatCompletion.choices[0].message.content;

    // Step 3: turn the reply into speech
    const speechResponse = await groq.audio.speech.create({
      model: 'playai-tts',
      voice: 'Fritz-PlayAI',
      input: replyText,
      response_format: 'wav'
    });
    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    const audioBase64 = audioBuffer.toString('base64');

    res.json({ transcript, replyText, audioBase64 });
  } catch (err) {
    console.error('voice-chat error:', err.message);
    res.status(500).json({ error: 'Failed to process voice chat' });
  }
});

// ---------- 5. TEXT-TO-SPEECH (read any AI reply aloud) ----------
app.post('/api/tts', async (req, res) => {
  try {
    const { text, voice } = req.body;
    if (!text) return res.status(400).json({ error: 'text is required' });

    const speechResponse = await groq.audio.speech.create({
      model: 'playai-tts',
      voice: voice || 'Fritz-PlayAI',
      input: text,
      response_format: 'wav'
    });
    const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
    const audioBase64 = audioBuffer.toString('base64');

    res.json({ audioBase64 });
  } catch (err) {
    console.error('tts error:', err.message);
    res.status(500).json({ error: 'Failed to generate speech' });
  }
});

app.listen(PORT, () => {
  console.log(`PrepMate server running on port ${PORT}`);
});
