# OpenRouter 5AI Transcriber + Explainer

Project ini menangkap audio dari **Microphone** atau **Share Screen / Tab Audio**, memotong audio menjadi chunk WebM, mengirimnya ke backend lokal, lalu backend memanggil OpenRouter STT. Setelah transkrip muncul, klik **Analisis 5 AI** untuk meminta 5 model OpenRouter menjelaskan makna poin-poin dari transkrip.

## Cara Pakai

```bash
npm install
copy .env.example .env
npm start
```

Buka:

```text
http://localhost:3000
```

Isi `.env` minimal:

```env
OPENROUTER_API_KEY=sk-or-v1-isi_key_kamu_disini
PORT=3000
```

## 5 AI yang Dipakai

1. **Qwen3 Next 80B A3B Instruct**
   - Fungsi: mengambil topik utama, poin penting, istilah, dan bagian ambigu.
   - Env: `AI1_EXTRACTOR_MODEL=qwen/qwen3-next-80b-a3b-instruct:free`

2. **OpenAI gpt-oss-120b**
   - Fungsi: menjelaskan makna dan maksud dari tiap poin.
   - Env: `AI2_MEANING_MODEL=openai/gpt-oss-120b:free`

3. **Google Gemma 4 31B IT**
   - Fungsi: mengecek konteks, istilah, kalimat yang mungkin salah dengar, dan risiko salah paham.
   - Env: `AI3_CONTEXT_MODEL=google/gemma-4-31b-it:free`

4. **Meta Llama 3.3 70B Instruct**
   - Fungsi: membuat ringkasan natural dan mudah dipahami.
   - Env: `AI4_SUMMARY_MODEL=meta-llama/llama-3.3-70b-instruct:free`

5. **NVIDIA Nemotron 3 Ultra**
   - Fungsi: menggabungkan hasil 4 AI menjadi jawaban final, validasi, dan kesimpulan rapi.
   - Env: `AI5_FINAL_MODEL=nvidia/nemotron-3-ultra-550b-a55b:free`

## Cara Kerja Analisis 5 AI

```text
Transkrip asli
  ├─ AI 1 Qwen: ambil poin penting
  ├─ AI 2 GPT-OSS: jelaskan makna
  ├─ AI 3 Gemma: cek konteks & ambiguitas
  ├─ AI 4 Llama: ringkas natural
  └─ AI 5 Nemotron Ultra: final merger + validasi
```

Total saat klik **Analisis 5 AI**: **5 request OpenRouter**.

## Catatan STT / Transkripsi

- Fitur analisis 5 AI gratis memakai model `:free`.
- STT / transcription audio di OpenRouter tergantung model/provider yang tersedia di akun kamu.
- Kalau STT gagal, paste transkrip manual ke textarea lalu klik **Analisis 5 AI**.
- Untuk Share Screen, pilih tab/window yang ada suara dan centang **Share tab audio**.

## Tips Stabil untuk Ucapan Cepat

- Pakai chunk 8000 sampai 12000 ms.
- Untuk ucapan sangat cepat, pilih 12 detik atau 15 detik.
- Chunk terlalu pendek bisa membuat transkrip kepotong dan boros request.

## Struktur Project

```text
openrouter-5ai-transcriber-explainer/
├─ public/
│  ├─ index.html
│  ├─ style.css
│  └─ app.js
├─ server.js
├─ package.json
├─ .env.example
└─ README.md
```
