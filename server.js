import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL || `http://localhost:${PORT}`;
const OPENROUTER_APP_NAME = process.env.OPENROUTER_APP_NAME || 'OpenRouter 5AI Transcriber Explainer';

const OPENROUTER_STT_MODEL = process.env.OPENROUTER_STT_MODEL || 'openai/whisper-large-v3-turbo';
const DEFAULT_LANGUAGE = process.env.DEFAULT_LANGUAGE || 'id';
const TRANSCRIBE_CHUNK_MS = Number(process.env.TRANSCRIBE_CHUNK_MS || 8000);

const FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || 'openrouter/free';
const AGENT_MAX_TOKENS = Number(process.env.AGENT_MAX_TOKENS || 1100);
const FINAL_MAX_TOKENS = Number(process.env.FINAL_MAX_TOKENS || 1800);

const AI_AGENTS = [
  {
    id: 'ai1-extractor',
    name: 'AI 1 - Qwen Extractor',
    roleLabel: 'Ambil poin penting',
    model: process.env.AI1_EXTRACTOR_MODEL || 'qwen/qwen3-next-80b-a3b-instruct:free',
    system: `Kamu adalah AI extractor transkrip. Tugasmu hanya mengambil isi penting dari transkrip. Jangan menambah fakta di luar transkrip. Jangan mengarang. Jawab dalam Bahasa Indonesia yang jelas.`,
    buildUser: (transcript) => `Ambil poin penting dari transkrip berikut.

Format wajib:
1. Topik utama
2. Daftar poin penting berurutan
3. Istilah/kata kunci penting
4. Bagian transkrip yang terdengar ambigu / kurang jelas

Transkrip:
${transcript}`
  },
  {
    id: 'ai2-meaning',
    name: 'AI 2 - GPT-OSS Meaning',
    roleLabel: 'Jelaskan makna dan maksud',
    model: process.env.AI2_MEANING_MODEL || 'openai/gpt-oss-120b:free',
    system: `Kamu adalah AI penafsir makna. Tugasmu menjelaskan maksud pembicara berdasarkan transkrip. Jangan membuat fakta baru. Jika ada kemungkinan maksud, beri label "kemungkinan". Jawab dalam Bahasa Indonesia.`,
    buildUser: (transcript) => `Jelaskan makna dari poin-poin dalam transkrip berikut.

Format wajib:
1. Maksud pembicara secara sederhana
2. Makna tiap poin penting
3. Kenapa poin itu penting
4. Hal yang tersirat tetapi masih didukung transkrip
5. Kesimpulan sementara

Transkrip:
${transcript}`
  },
  {
    id: 'ai3-context',
    name: 'AI 3 - Gemma Context',
    roleLabel: 'Konteks, istilah, dan ambiguitas',
    model: process.env.AI3_CONTEXT_MODEL || 'google/gemma-4-31b-it:free',
    system: `Kamu adalah AI pemeriksa konteks transkrip. Fokus pada konteks pembahasan, istilah, kemungkinan salah dengar, dan bagian yang perlu klarifikasi. Jangan mengarang. Jawab dalam Bahasa Indonesia.`,
    buildUser: (transcript) => `Analisis konteks dari transkrip berikut.

Format wajib:
1. Konteks pembicaraan
2. Istilah atau kalimat yang perlu dijelaskan
3. Bagian yang kemungkinan salah transkrip / salah dengar
4. Pertanyaan klarifikasi yang perlu ditanyakan
5. Risiko salah paham dari transkrip ini

Transkrip:
${transcript}`
  },
  {
    id: 'ai4-summary',
    name: 'AI 4 - Llama Summary',
    roleLabel: 'Ringkasan bahasa natural',
    model: process.env.AI4_SUMMARY_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    system: `Kamu adalah AI peringkas. Buat ringkasan mudah dipahami, natural, dan rapi. Jangan menambah informasi di luar transkrip. Jawab dalam Bahasa Indonesia.`,
    buildUser: (transcript) => `Ringkas transkrip berikut menjadi bahasa yang mudah dipahami.

Format wajib:
1. Ringkasan sangat singkat
2. Ringkasan detail
3. Poin yang harus diingat
4. Jika ada instruksi/aksi, tuliskan daftar aksi

Transkrip:
${transcript}`
  }
];

const FINAL_AGENT = {
  id: 'ai5-final',
  name: 'AI 5 - Nemotron Final Merger',
  roleLabel: 'Gabungkan final dan validasi',
  model: process.env.AI5_FINAL_MODEL || 'nvidia/nemotron-3-ultra-550b-a55b:free',
  system: `Kamu adalah AI final merger dan validator. Gabungkan hasil beberapa AI menjadi jawaban akhir yang rapi. Jangan menambah fakta baru di luar transkrip dan hasil analisis. Jika agent lain error, tetap jawab dari data yang tersedia. Bahasa wajib: Indonesia.`
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function openRouterHeaders(extra = {}) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY belum diisi di file .env');
  }

  return {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'HTTP-Referer': OPENROUTER_SITE_URL,
    'X-OpenRouter-Title': OPENROUTER_APP_NAME,
    ...extra
  };
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function pickErrorMessage(payload) {
  return payload?.error?.message || payload?.message || payload?.raw || 'OpenRouter request gagal';
}

function trimTranscript(transcript, maxChars = 26000) {
  const text = String(transcript || '').trim();
  if (text.length <= maxChars) return text;
  return text.slice(-maxChars);
}

function normalizeLanguage(language) {
  const lang = String(language || DEFAULT_LANGUAGE).trim();
  return lang || DEFAULT_LANGUAGE;
}

async function callOpenRouterChat({ model, messages, temperature = 0.2, max_tokens = 1000 }) {
  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: openRouterHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens
    })
  });

  const payload = await readJsonResponse(res);
  if (!res.ok) throw new Error(pickErrorMessage(payload));

  const content = String(payload?.choices?.[0]?.message?.content || '').trim();
  return content || 'Model tidak mengembalikan output.';
}

async function callAgent(agent, transcript, language) {
  const safeTranscript = trimTranscript(transcript);
  const messages = [
    { role: 'system', content: `${agent.system}\nBahasa output: ${language === 'en' ? 'English' : 'Indonesia'}.` },
    { role: 'user', content: agent.buildUser(safeTranscript) }
  ];

  try {
    const output = await callOpenRouterChat({
      model: agent.model,
      messages,
      temperature: 0.15,
      max_tokens: AGENT_MAX_TOKENS
    });

    return {
      id: agent.id,
      name: agent.name,
      role: agent.roleLabel,
      model: agent.model,
      ok: true,
      output
    };
  } catch (firstErr) {
    if (!FALLBACK_MODEL || FALLBACK_MODEL === agent.model) {
      return {
        id: agent.id,
        name: agent.name,
        role: agent.roleLabel,
        model: agent.model,
        ok: false,
        error: firstErr.message || String(firstErr),
        output: ''
      };
    }

    try {
      const output = await callOpenRouterChat({
        model: FALLBACK_MODEL,
        messages,
        temperature: 0.15,
        max_tokens: AGENT_MAX_TOKENS
      });

      return {
        id: agent.id,
        name: agent.name,
        role: agent.roleLabel,
        model: agent.model,
        fallbackModel: FALLBACK_MODEL,
        ok: true,
        fallback: true,
        output
      };
    } catch (fallbackErr) {
      return {
        id: agent.id,
        name: agent.name,
        role: agent.roleLabel,
        model: agent.model,
        fallbackModel: FALLBACK_MODEL,
        ok: false,
        error: `${firstErr.message || String(firstErr)} | Fallback error: ${fallbackErr.message || String(fallbackErr)}`,
        output: ''
      };
    }
  }
}

async function callFinalAgent(transcript, agentResults, language) {
  const safeTranscript = trimTranscript(transcript, 18000);

  const agentBlock = agentResults.map((item, index) => {
    const header = `## Agent ${index + 1}: ${item.name}\nRole: ${item.role}\nModel: ${item.fallback ? `${item.model} -> fallback ${item.fallbackModel}` : item.model}\nStatus: ${item.ok ? 'OK' : 'ERROR'}`;
    const body = item.ok ? item.output : `ERROR: ${item.error}`;
    return `${header}\n${body}`;
  }).join('\n\n---\n\n');

  const userPrompt = `Gabungkan hasil 4 AI agent dan transkrip asli menjadi jawaban final.

ATURAN:
- Jangan menambah fakta di luar transkrip.
- Kalau ada hal yang tidak jelas, tulis sebagai "bagian ambigu".
- Jangan terlalu panjang, tapi tetap lengkap.
- Fokus pada makna poin-poin dan maksud dari poin itu.

FORMAT WAJIB:
1. Ringkasan utama
2. Poin-poin penting
3. Maksud dari tiap poin
4. Makna tersirat yang masih masuk akal dari transkrip
5. Bagian ambigu / perlu klarifikasi
6. Kesimpulan akhir
7. Aksi yang bisa dilakukan setelah memahami transkrip

TRANSKRIP ASLI:
${safeTranscript}

HASIL 4 AI AGENT:
${agentBlock}`;

  const messages = [
    { role: 'system', content: `${FINAL_AGENT.system}\nBahasa output: ${language === 'en' ? 'English' : 'Indonesia'}.` },
    { role: 'user', content: userPrompt }
  ];

  try {
    const output = await callOpenRouterChat({
      model: FINAL_AGENT.model,
      messages,
      temperature: 0.12,
      max_tokens: FINAL_MAX_TOKENS
    });

    return {
      id: FINAL_AGENT.id,
      name: FINAL_AGENT.name,
      role: FINAL_AGENT.roleLabel,
      model: FINAL_AGENT.model,
      ok: true,
      output
    };
  } catch (firstErr) {
    if (!FALLBACK_MODEL || FALLBACK_MODEL === FINAL_AGENT.model) {
      return {
        id: FINAL_AGENT.id,
        name: FINAL_AGENT.name,
        role: FINAL_AGENT.roleLabel,
        model: FINAL_AGENT.model,
        ok: false,
        error: firstErr.message || String(firstErr),
        output: ''
      };
    }

    try {
      const output = await callOpenRouterChat({
        model: FALLBACK_MODEL,
        messages,
        temperature: 0.12,
        max_tokens: FINAL_MAX_TOKENS
      });

      return {
        id: FINAL_AGENT.id,
        name: FINAL_AGENT.name,
        role: FINAL_AGENT.roleLabel,
        model: FINAL_AGENT.model,
        fallbackModel: FALLBACK_MODEL,
        ok: true,
        fallback: true,
        output
      };
    } catch (fallbackErr) {
      return {
        id: FINAL_AGENT.id,
        name: FINAL_AGENT.name,
        role: FINAL_AGENT.roleLabel,
        model: FINAL_AGENT.model,
        fallbackModel: FALLBACK_MODEL,
        ok: false,
        error: `${firstErr.message || String(firstErr)} | Fallback error: ${fallbackErr.message || String(fallbackErr)}`,
        output: ''
      };
    }
  }
}

async function explainTranscriptWith5AI(transcript, language = 'id') {
  const safeTranscript = trimTranscript(transcript);
  if (!safeTranscript) {
    return {
      final: 'Belum ada transkrip yang bisa dijelaskan.',
      agents: [],
      finalAgent: null
    };
  }

  const agentResults = await Promise.all(
    AI_AGENTS.map((agent) => callAgent(agent, safeTranscript, language))
  );

  const finalAgent = await callFinalAgent(safeTranscript, agentResults, language);

  return {
    final: finalAgent.ok ? finalAgent.output : `Final AI gagal: ${finalAgent.error || 'Unknown error'}`,
    agents: agentResults,
    finalAgent,
    models: {
      agents: AI_AGENTS.map((a) => ({ id: a.id, name: a.name, role: a.roleLabel, model: a.model })),
      final: { id: FINAL_AGENT.id, name: FINAL_AGENT.name, role: FINAL_AGENT.roleLabel, model: FINAL_AGENT.model },
      fallback: FALLBACK_MODEL
    }
  };
}

async function transcribeAudioWebm(buffer, language) {
  const base64Audio = Buffer.from(buffer).toString('base64');

  const body = {
    model: OPENROUTER_STT_MODEL,
    input_audio: {
      data: base64Audio,
      format: 'webm'
    },
    temperature: 0
  };

  const lang = normalizeLanguage(language);
  if (lang && lang !== 'auto') body.language = lang;

  const res = await fetch(`${OPENROUTER_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: openRouterHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body)
  });

  const payload = await readJsonResponse(res);
  if (!res.ok) throw new Error(pickErrorMessage(payload));

  return {
    text: String(payload.text || '').trim(),
    usage: payload.usage || null
  };
}

app.get('/api/config', (_req, res) => {
  res.json({
    defaultLanguage: DEFAULT_LANGUAGE,
    transcribeChunkMs: TRANSCRIBE_CHUNK_MS,
    sttModel: OPENROUTER_STT_MODEL,
    hasApiKey: Boolean(OPENROUTER_API_KEY),
    fallbackModel: FALLBACK_MODEL,
    aiAgents: AI_AGENTS.map((a) => ({ id: a.id, name: a.name, role: a.roleLabel, model: a.model })),
    finalAgent: { id: FINAL_AGENT.id, name: FINAL_AGENT.name, role: FINAL_AGENT.roleLabel, model: FINAL_AGENT.model }
  });
});

app.post('/api/explain', async (req, res) => {
  try {
    const { transcript, language } = req.body || {};
    const result = await explainTranscriptWith5AI(transcript, normalizeLanguage(language));
    res.json(result);
  } catch (err) {
    console.error('[5AI EXPLAIN ERROR]', err);
    res.status(500).json({ error: err.message || 'Gagal menjelaskan transkrip dengan 5 AI' });
  }
});

wss.on('connection', (ws) => {
  let language = DEFAULT_LANGUAGE;
  let chunkId = 0;
  let queue = Promise.resolve();

  function send(payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
  }

  send({
    type: 'ready',
    sttModel: OPENROUTER_STT_MODEL,
    defaultLanguage: DEFAULT_LANGUAGE,
    transcribeChunkMs: TRANSCRIBE_CHUNK_MS,
    hasApiKey: Boolean(OPENROUTER_API_KEY)
  });

  ws.on('message', (message, isBinary) => {
    if (!isBinary) {
      try {
        const data = JSON.parse(message.toString('utf8'));
        if (data.type === 'config') {
          language = data.language || DEFAULT_LANGUAGE;
          send({ type: 'config-ok', language });
        }
      } catch {}
      return;
    }

    const audioBuffer = Buffer.from(message);
    const thisChunk = ++chunkId;
    send({ type: 'chunk-received', chunkId: thisChunk, size: audioBuffer.length });

    queue = queue
      .then(async () => {
        if (audioBuffer.length < 2000) {
          send({ type: 'transcript', chunkId: thisChunk, text: '', skipped: true });
          return;
        }

        send({ type: 'transcribing', chunkId: thisChunk });
        const result = await transcribeAudioWebm(audioBuffer, language);

        send({
          type: 'transcript',
          chunkId: thisChunk,
          text: result.text,
          usage: result.usage
        });
      })
      .catch((err) => {
        console.error('[STT ERROR]', err);
        send({ type: 'error', chunkId: thisChunk, error: err.message || 'Transcription error' });
      });
  });
});

server.listen(PORT, () => {
  console.log(`OpenRouter 5AI Transcriber running at http://localhost:${PORT}`);
  console.log(`STT model: ${OPENROUTER_STT_MODEL}`);
  console.log('5 AI agents:');
  for (const agent of AI_AGENTS) console.log(`- ${agent.name}: ${agent.model}`);
  console.log(`- ${FINAL_AGENT.name}: ${FINAL_AGENT.model}`);
});
