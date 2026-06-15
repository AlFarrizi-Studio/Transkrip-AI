const sourceMode = document.getElementById('sourceMode');
const language = document.getElementById('language');
const chunkMsSelect = document.getElementById('chunkMs');
const timestampMode = document.getElementById('timestampMode');

const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const explainBtn = document.getElementById('explainBtn');
const copyBtn = document.getElementById('copyBtn');
const copyExplainBtn = document.getElementById('copyExplainBtn');
const downloadBtn = document.getElementById('downloadBtn');
const clearBtn = document.getElementById('clearBtn');

const statusEl = document.getElementById('status');
const output = document.getElementById('output');
const finalExplanation = document.getElementById('finalExplanation');
const agentDetails = document.getElementById('agentDetails');
const preview = document.getElementById('preview');
const connectionBadge = document.getElementById('connectionBadge');
const chunkInfo = document.getElementById('chunkInfo');
const progressBar = document.getElementById('progressBar');
const modelStrip = document.getElementById('modelStrip');

const sentCountEl = document.getElementById('sentCount');
const doneCountEl = document.getElementById('doneCount');
const lineCountEl = document.getElementById('lineCount');
const langText = document.getElementById('langText');

let ws = null;
let mediaStream = null;
let recorder = null;
let running = false;
let recordingLoopTimer = null;
let progressTimer = null;
let chunkStartedAt = 0;

let sentCount = 0;
let doneCount = 0;
let lineCount = 0;
let finalText = '';
let lastAiResultText = '';
const recentTexts = [];

function setStatus(message) {
  statusEl.innerHTML = message;
}

function setOnline(isOnline) {
  connectionBadge.textContent = isOnline ? 'ONLINE' : 'OFFLINE';
  connectionBadge.classList.toggle('live', isOnline);
}

function updateStats() {
  sentCountEl.textContent = String(sentCount);
  doneCountEl.textContent = String(doneCount);
  lineCountEl.textContent = String(lineCount);
  langText.textContent = language.value;
}

function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}

function normalize(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isDuplicate(text) {
  const now = normalize(text);
  if (!now) return true;

  for (const old of recentTexts) {
    const oldNorm = normalize(old);
    if (now === oldNorm) return true;
    if (now.length > 14 && oldNorm.includes(now)) return true;
    if (oldNorm.length > 14 && now.includes(oldNorm)) return true;
  }

  return false;
}

function remember(text) {
  recentTexts.push(text);
  while (recentTexts.length > 25) recentTexts.shift();
}

function getTime() {
  return new Date().toLocaleTimeString('id-ID', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function appendTranscript(text) {
  const clean = cleanText(text);
  if (!clean || isDuplicate(clean)) return;

  remember(clean);

  const line = timestampMode.value === 'on'
    ? `[${getTime()}] ${clean}`
    : clean;

  finalText += line + '\n';
  output.value = finalText;
  output.scrollTop = output.scrollHeight;

  lineCount++;
  updateStats();
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];

  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

function renderModelStrip(cfg) {
  const items = [];

  for (const agent of cfg.aiAgents || []) {
    items.push(agent);
  }

  if (cfg.finalAgent) items.push(cfg.finalAgent);

  modelStrip.innerHTML = items.map((item, index) => `
    <div class="model-card">
      <b>AI ${index + 1}</b>
      <span class="role">${escapeHtml(item.role || '-')}</span>
      <span>${escapeHtml(item.name || '-')}</span>
      <span>${escapeHtml(item.model || '-')}</span>
    </div>
  `).join('');
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();

    if (cfg.defaultLanguage) language.value = cfg.defaultLanguage;
    if (cfg.transcribeChunkMs) chunkMsSelect.value = String(cfg.transcribeChunkMs);

    renderModelStrip(cfg);

    if (!cfg.hasApiKey) {
      setStatus('<b>OPENROUTER_API_KEY belum diisi.</b> Edit file .env dulu, lalu restart server.');
    } else {
      setStatus(`Status: siap. STT: <b>${escapeHtml(cfg.sttModel)}</b> | Fallback: <b>${escapeHtml(cfg.fallbackModel)}</b>`);
    }

    updateStats();
  } catch (err) {
    setStatus('Gagal membaca config server. Pastikan npm start sudah jalan.');
  }
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      setOnline(true);
      ws.send(JSON.stringify({ type: 'config', language: language.value }));
      resolve();
    };

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      if (data.type === 'ready') return;

      if (data.type === 'chunk-received') {
        chunkInfo.textContent = `Chunk #${data.chunkId} diterima server (${Math.round(data.size / 1024)} KB).`;
        return;
      }

      if (data.type === 'transcribing') {
        chunkInfo.textContent = `Chunk #${data.chunkId} sedang ditranskrip OpenRouter...`;
        return;
      }

      if (data.type === 'transcript') {
        doneCount++;
        updateStats();

        if (data.text) {
          appendTranscript(data.text);
          chunkInfo.textContent = `Chunk #${data.chunkId} selesai.`;
        } else {
          chunkInfo.textContent = `Chunk #${data.chunkId} kosong / tidak terdengar.`;
        }
        return;
      }

      if (data.type === 'error') {
        doneCount++;
        updateStats();
        chunkInfo.textContent = `Chunk #${data.chunkId || '?'} error.`;
        setStatus(`<b>Error STT:</b> ${escapeHtml(data.error || 'Transkripsi gagal')}`);
      }
    };

    ws.onerror = () => reject(new Error('WebSocket error'));

    ws.onclose = () => {
      setOnline(false);
      if (running) {
        setStatus('WebSocket putus. Stop lalu mulai lagi.');
        stopAll(false);
      }
    };
  });
}

function startProgressLoop() {
  clearInterval(progressTimer);
  progressTimer = setInterval(() => {
    if (!running) return;
    const chunkMs = Number(chunkMsSelect.value || 8000);
    const elapsed = Date.now() - chunkStartedAt;
    const pct = Math.min(100, Math.round((elapsed / chunkMs) * 100));
    progressBar.style.width = pct + '%';
  }, 100);
}

function startRecorderLoop() {
  if (!running || !mediaStream) return;

  const mimeType = pickMimeType();
  const options = mimeType ? { mimeType } : undefined;
  const chunkMs = Number(chunkMsSelect.value || 8000);

  try {
    recorder = new MediaRecorder(mediaStream, options);
  } catch (err) {
    setStatus('MediaRecorder gagal dibuat. Browser tidak mendukung format audio yang cocok.');
    stopAll(false);
    return;
  }

  const chunks = [];
  chunkStartedAt = Date.now();
  progressBar.style.width = '0%';

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onerror = (event) => {
    console.error(event);
    setStatus('Recorder error. Coba restart browser / pilih sumber audio lain.');
    stopAll(false);
  };

  recorder.onstop = async () => {
    if (chunks.length && ws && ws.readyState === WebSocket.OPEN) {
      const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      ws.send(arrayBuffer);
      sentCount++;
      updateStats();
      chunkInfo.textContent = `Chunk #${sentCount} dikirim (${Math.round(arrayBuffer.byteLength / 1024)} KB).`;
    }

    if (running) recordingLoopTimer = setTimeout(startRecorderLoop, 90);
  };

  recorder.start();

  recordingLoopTimer = setTimeout(() => {
    if (recorder && recorder.state === 'recording') {
      recorder.stop();
    }
  }, chunkMs);
}

async function startAll() {
  if (running) return;

  try {
    running = true;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    sentCount = 0;
    doneCount = 0;
    updateStats();

    await connectWs();

    if (sourceMode.value === 'screen') {
      mediaStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });

      const audioTracks = mediaStream.getAudioTracks();
      if (!audioTracks.length) throw new Error('Share Screen aktif, tapi audio tidak ikut. Centang Share tab audio.');

      preview.hidden = false;
      preview.srcObject = mediaStream;
    } else {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
    }

    mediaStream.getTracks().forEach((track) => {
      track.onended = () => stopAll();
    });

    setStatus('Status: merekam chunk audio dan mengirim ke backend OpenRouter...');
    startProgressLoop();
    startRecorderLoop();
  } catch (err) {
    setStatus(`<b>Gagal mulai:</b> ${escapeHtml(err.message || String(err))}`);
    stopAll(false);
  }
}

function stopAll(showMessage = true) {
  running = false;
  clearTimeout(recordingLoopTimer);
  clearInterval(progressTimer);
  progressBar.style.width = '0%';

  if (recorder && recorder.state === 'recording') {
    try { recorder.stop(); } catch {}
  }
  recorder = null;

  if (mediaStream) mediaStream.getTracks().forEach((track) => track.stop());
  mediaStream = null;

  if (ws) {
    try { ws.close(); } catch {}
  }
  ws = null;

  preview.srcObject = null;
  preview.hidden = true;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  setOnline(false);
  chunkInfo.textContent = 'Berhenti.';

  if (showMessage) setStatus('Status: berhenti.');
}

function renderAgentDetails(agents, finalAgent) {
  const all = [...(agents || [])];
  if (finalAgent) all.push(finalAgent);

  if (!all.length) {
    agentDetails.textContent = 'Tidak ada detail agent.';
    return;
  }

  agentDetails.innerHTML = all.map((agent, index) => {
    const modelLine = agent.fallback
      ? `${agent.model} → fallback ${agent.fallbackModel}`
      : agent.model;

    return `
      <div class="agent-output ${agent.ok ? '' : 'error'}">
        <h4>AI ${index + 1}: ${escapeHtml(agent.name || '-')}</h4>
        <div class="meta">
          Fungsi: ${escapeHtml(agent.role || '-')}<br />
          Model: ${escapeHtml(modelLine || '-')}
        </div>
        ${escapeHtml(agent.ok ? (agent.output || '-') : (agent.error || 'Error'))}
      </div>
    `;
  }).join('');
}

async function explainTranscript() {
  const transcript = output.value.trim();
  if (!transcript) {
    finalExplanation.textContent = 'Belum ada transkrip yang bisa dijelaskan.';
    return;
  }

  explainBtn.disabled = true;
  finalExplanation.textContent = 'Sedang menjalankan 5 AI OpenRouter...';
  agentDetails.textContent = 'AI 1-4 sedang menganalisis, AI 5 akan menggabungkan hasil final...';
  setStatus('Status: menjalankan 5 AI untuk menjelaskan makna poin-poin transkrip.');

  try {
    const res = await fetch('/api/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, language: language.value })
    });

    const payload = await res.json();
    if (!res.ok) throw new Error(payload.error || 'Gagal menjelaskan transkrip');

    finalExplanation.textContent = payload.final || 'Tidak ada hasil final.';
    renderAgentDetails(payload.agents || [], payload.finalAgent || null);
    lastAiResultText = buildPlainAiResult(payload);
    setStatus('Status: analisis 5 AI selesai.');
  } catch (err) {
    finalExplanation.textContent = 'Error: ' + (err.message || String(err));
    agentDetails.textContent = 'Gagal mengambil detail agent.';
    setStatus(`<b>Error 5 AI:</b> ${escapeHtml(err.message || String(err))}`);
  } finally {
    explainBtn.disabled = false;
  }
}

function buildPlainAiResult(payload) {
  const lines = [];
  lines.push('HASIL FINAL 5 AI');
  lines.push('=================');
  lines.push(payload.final || '');
  lines.push('');
  lines.push('DETAIL TIAP AI');
  lines.push('=============');

  for (const [index, agent] of [...(payload.agents || []), payload.finalAgent].filter(Boolean).entries()) {
    lines.push(`AI ${index + 1}: ${agent.name}`);
    lines.push(`Fungsi: ${agent.role}`);
    lines.push(`Model: ${agent.fallback ? `${agent.model} -> fallback ${agent.fallbackModel}` : agent.model}`);
    lines.push(agent.ok ? agent.output : `ERROR: ${agent.error}`);
    lines.push('');
  }

  return lines.join('\n');
}

async function copyTranscript() {
  const text = output.value.trim();
  if (!text) {
    setStatus('Tidak ada transkrip untuk dicopy.');
    return;
  }
  await navigator.clipboard.writeText(text);
  setStatus('Transkrip berhasil dicopy.');
}

async function copyAiResult() {
  const text = lastAiResultText || finalExplanation.textContent.trim();
  if (!text || text.includes('Klik “Analisis 5 AI”')) {
    setStatus('Belum ada hasil AI untuk dicopy.');
    return;
  }
  await navigator.clipboard.writeText(text);
  setStatus('Hasil AI berhasil dicopy.');
}

function downloadTranscript() {
  const transcript = output.value.trim();
  const aiResult = lastAiResultText.trim();

  if (!transcript && !aiResult) {
    setStatus('Tidak ada teks untuk didownload.');
    return;
  }

  const text = [
    'TRANSKRIP',
    '=========',
    transcript || '-',
    '',
    aiResult || 'Belum ada hasil analisis AI.'
  ].join('\n');

  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'transkrip-5ai-openrouter.txt';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clearAll() {
  finalText = '';
  lastAiResultText = '';
  output.value = '';
  finalExplanation.textContent = 'Klik “Analisis 5 AI” setelah transkrip muncul.';
  agentDetails.textContent = 'Belum ada analisis.';
  recentTexts.length = 0;
  sentCount = 0;
  doneCount = 0;
  lineCount = 0;
  updateStats();
  setStatus('Teks dibersihkan.');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

startBtn.addEventListener('click', startAll);
stopBtn.addEventListener('click', () => stopAll());
explainBtn.addEventListener('click', explainTranscript);
copyBtn.addEventListener('click', copyTranscript);
copyExplainBtn.addEventListener('click', copyAiResult);
downloadBtn.addEventListener('click', downloadTranscript);
clearBtn.addEventListener('click', clearAll);
language.addEventListener('change', () => {
  updateStats();
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'config', language: language.value }));
  }
});

loadConfig();
updateStats();
setOnline(false);
