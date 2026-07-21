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
    const { subject, topic, profile } = req.body;
    if (!subject) return res.status(400).json({ error: 'subject is required' });

    const curriculumContext = buildCurriculumContext(profile);

    const prompt = `Generate one multiple-choice exam-style practice question for the subject "${subject}"${topic ? `, focused on the topic "${topic}"` : ''}.${curriculumContext}
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
      temperature: 0.7,
      reasoning_format: 'parsed'
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

// ---------- shared helper: turn a student profile into a curriculum instruction ----------
function buildCurriculumContext(profile) {
  if (!profile) return '';
  if (profile.country === 'Nigeria' && profile.ngClass) {
    return ` The student is in ${profile.ngClass} in Nigeria, following the Nigerian curriculum (WAEC/NECO/JAMB syllabus).${profile.department ? ` Their department is ${profile.department}.` : ''} Match difficulty, topic scope, and examples to that class level and syllabus.`;
  }
  if (profile.country) {
    return ` The student is at level "${profile.otherClass || 'unspecified'}" in ${profile.country}. Match difficulty and examples to that level.`;
  }
  return '';
}

// ---------- 2. IMAGE HELP (upload a photo, AI explains/answers it) ----------
app.post('/api/image-help', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'image file is required' });
    if (!['image/jpeg', 'image/jpg', 'image/png'].includes(req.file.mimetype)) {
      return res.status(400).json({ error: 'Only JPG and PNG images are supported.' });
    }
    let profile = null;
    try { profile = req.body.profile ? JSON.parse(req.body.profile) : null; } catch (e) {}
    const userQuestion = (req.body.question || 'Look at this image and help me understand and solve it. Explain step by step.') + buildCurriculumContext(profile);

    const base64Image = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype;

    const completion = await groq.chat.completions.create({
      model: 'qwen/qwen3.6-27b',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: userQuestion },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
          ]
        }
      ],
      temperature: 0.4,
      reasoning_format: 'parsed'
    });

    res.json({ answer: completion.choices[0].message.content, reasoning: completion.choices[0].message.reasoning || null });
  } catch (err) {
    console.error('image-help error:', err.message);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

// ---------- 2b. IMAGE UPLOAD (stores image on ImgBB, returns only a clean URL — key never reaches the frontend) ----------
app.post('/api/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'image file is required' });

    const base64Image = req.file.buffer.toString('base64');
    const params = new URLSearchParams();
    params.append('key', process.env.IMGBB_API_KEY);
    params.append('image', base64Image);

    const imgbbRes = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: params
    });
    const imgbbData = await imgbbRes.json();

    if (!imgbbData.success) {
      console.error('imgbb upload failed:', imgbbData);
      return res.status(500).json({ error: 'Failed to store image' });
    }

    res.json({ url: imgbbData.data.url });
  } catch (err) {
    console.error('upload-image error:', err.message);
    res.status(500).json({ error: 'Failed to store image' });
  }
});

// ---------- 3. LIVE TEXT CHAT WITH AI TUTOR ----------
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history, profile } = req.body;
    if (!message) return res.status(400).json({ error: 'message is required' });

    const messages = [
      {
        role: 'system',
        content: 'You are PrepMate, a friendly, encouraging AI study tutor. Explain concepts in simple, clear language. Keep answers focused and not too long unless the student asks for depth. Never use markdown symbols like **, ##, or # in your replies — write in plain sentences and paragraphs only. You can occasionally use a relevant emoji here and there, but do not overuse them.' + buildCurriculumContext(profile)
      },
      ...(Array.isArray(history) ? history : []),
      { role: 'user', content: message }
    ];

    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages,
      temperature: 0.6,
      reasoning_format: 'parsed'
    });

    res.json({ reply: completion.choices[0].message.content, reasoning: completion.choices[0].message.reasoning || null });
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
    const selectedVoice = req.body.voice === 'hannah' ? 'hannah' : 'austin';
    let voiceProfile = null;
    try { voiceProfile = req.body.profile ? JSON.parse(req.body.profile) : null; } catch (e) {}
    const chatCompletion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [
        {
          role: 'system',
          content: 'You are PrepMate, a friendly AI study tutor speaking out loud to a student. Keep replies conversational and under 200 characters since they will be spoken aloud. Never use markdown symbols like **, ##, or # — plain spoken sentences only. You can occasionally use a relevant emoji, but do not overuse them.' + buildCurriculumContext(voiceProfile)
        },
        ...history,
        { role: 'user', content: transcript }
      ],
      temperature: 0.6,
      reasoning_format: 'parsed'
    });
    const replyText = chatCompletion.choices[0].message.content;

    // Step 3: turn the reply into speech (Orpheus caps input at 200 characters)
    const speechResponse = await groq.audio.speech.create({
      model: 'canopylabs/orpheus-v1-english',
      voice: selectedVoice,
      input: replyText.slice(0, 200),
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
      model: 'canopylabs/orpheus-v1-english',
      voice: voice === 'hannah' ? 'hannah' : 'austin',
      input: text.slice(0, 200), // Orpheus caps input at 200 characters
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

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`PrepMate server running on port ${PORT}`);
  });
}

module.exports = app;
