import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import { NextRequest, NextResponse } from 'next/server';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

interface HistoryItem {
  role: 'user' | 'agent';
  text: string;
}

interface SupportContext {
  userName?: string;
  phoneNumber?: string;
  userAccount?: string;
  balance?: number;
  recentTxSummary?: string;
}

interface TrainingPair {
  question?: string;
  answer?: string;
}

interface RequestBody {
  speakOnlyText?: string;
  audioBase64?: string;
  audioMimeType?: string;
  text?: string;
  history?: HistoryItem[];
  context?: SupportContext;
  agentName?: string;
  voiceName?: string;
  systemNotes?: string;
  customKnowledge?: string;
  trainingPairs?: TrainingPair[];
  mp3ContextSummary?: string;
}

const VALID_VOICES = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /503|500|429|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded|temporarily|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    msg
  );
}

async function synthesizeSpeechWav(
  ai: GoogleGenAI,
  text: string,
  voiceName: string
): Promise<string | null> {
  if (!text.trim()) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const ttsRes = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: text.trim(),
                speechMetadata: {
                  style:
                    'Warm, calm, professional Ethiopian bank customer support agent speaking clearly on a phone call',
                },
              },
            ],
          },
        ],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName },
            },
          },
        },
      });
      const data = ttsRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? null;
      if (data) return data;
    } catch (ttsErr) {
      if (attempt < 2 && isTransientGeminiError(ttsErr)) {
        await sleep(350 * (attempt + 1));
        continue;
      }
      console.warn('[Dialer AI Support TTS fallback]', ttsErr);
      return null;
    }
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        {
          ok: false,
          error:
            'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in AI Studio Settings > Secrets (create one at https://aistudio.google.com/apikey).',
        },
        { status: 500, headers: corsHeaders }
      );
    }

    const body = (await req.json()) as RequestBody;
    const voiceName = VALID_VOICES.has(String(body.voiceName || ''))
      ? String(body.voiceName)
      : 'Charon';

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const speakOnlyText =
      typeof body.speakOnlyText === 'string' ? body.speakOnlyText.trim() : '';
    if (speakOnlyText) {
      const audioBase64 = await synthesizeSpeechWav(ai, speakOnlyText, voiceName);
      return NextResponse.json(
        {
          ok: true,
          transcript: '',
          replyText: speakOnlyText,
          audioBase64,
          audioMimeType: audioBase64 ? 'audio/wav' : null,
        },
        { headers: corsHeaders }
      );
    }

    const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
    const rawMime = typeof body.audioMimeType === 'string' ? body.audioMimeType.trim() : '';
    const audioMimeType = rawMime.split(';')[0].trim() || 'audio/webm';
    const typedText = typeof body.text === 'string' ? body.text.trim() : '';

    if (!audioBase64 && !typedText) {
      return NextResponse.json(
        { ok: false, error: 'Either audioBase64, text, or speakOnlyText is required.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const ctx = body.context || {};
    const agentName = (body.agentName || 'እድሪስ').trim();

    const historyLines = Array.isArray(body.history)
      ? body.history
          .slice(-10)
          .map((h) => `${h.role === 'user' ? 'ደንበኛ' : 'ባለሙያ'}: ${String(h.text || '').trim()}`)
          .filter(Boolean)
          .join('\n')
      : '';

    const trainingLines = Array.isArray(body.trainingPairs)
      ? body.trainingPairs
          .map((p) => {
            const q = String(p?.question || '').trim();
            const a = String(p?.answer || '').trim();
            return q && a ? `- ደንበኛው "${q}" (ወይም ተመሳሳይ) ሲጠይቅ -> "${a}"` : '';
          })
          .filter(Boolean)
          .join('\n')
      : '';

    const systemInstruction = [
      `አንተ የኢትዮጵያ ንግድ ባንክ (CBE / CBEBirr 951) የስልክ ደንበኞች አገልግሎት ባለሙያ ነህ። ስምህ ${agentName} ነው።`,
      'በስልክ ጥሪ ላይ እንደምታወራ ሰው ተፈጥሯዊ፣ ትሁት፣ አጭር እና ግልፅ በሆነ አማርኛ (ወይም ደንበኛው በእንግሊዝኛ ካወራ በእንግሊዝኛ) መልስ ስጥ።',
      'መልስህ በአንድ ጊዜ ከ 1 እስከ 3 አጭር አረፍተ ነገር አይብለጥ (ለስልክ ንግግር ተስማሚ እንዲሆን)።',
      ctx.userName || ctx.phoneNumber || ctx.userAccount || typeof ctx.balance === 'number'
        ? `የደዋዩ የተመዘገበ መረጃ፦ ስም="${ctx.userName || 'ያልተጠቀሰ'}", ስልክ="${ctx.phoneNumber || 'ያልተጠቀሰ'}", አካውንት="${ctx.userAccount || 'ያልተጠቀሰ'}", ቀሪ ሂሳብ=${typeof ctx.balance === 'number' ? `${ctx.balance.toFixed(2)} ብር` : 'ያልታወቀ'}።`
        : '',
      ctx.recentTxSummary ? `የቅርብ ጊዜ ግብይት: ${ctx.recentTxSummary}` : '',
      body.mp3ContextSummary
        ? `ከዚህ ቀደም የተጫወቱት የMP3 ድምፆች: ${body.mp3ContextSummary}`
        : '',
      body.customKnowledge ? `የባንኩ እውቀትና መረጃ:\n${body.customKnowledge.trim()}` : '',
      trainingLines
        ? `የተማርካቸው የጥያቄና መልስ መመሪያዎች (በተቻለ መጠን እነዚህን ተከተል):\n${trainingLines}`
        : '',
      body.systemNotes ? `ተጨማሪ የስራ መመሪያ: ${body.systemNotes}` : '',
      'ደንበኛው ገንዘብ ልኬ አልደረሰም/SMS አልመጣም ካለ በባንኩ ሲስተም ፍተሻ መሠረት መረጋገጡን፣ አልፎ አልፎ በሲስተም መጨናነቅ ምክንያት ከሆነ በ24 ሰዓት ውስጥ ገቢ እንደሚሆን በትህትና አስረዳ፤ ወይም ስሙንና ዝርዝሩን ጠይቀህ አረጋግጥ።',
    ]
      .filter(Boolean)
      .join('\n');

    const promptText = [
      historyLines ? `የቀድሞ ንግግር:\n${historyLines}\n` : '',
      typedText
        ? `ደንበኛው አሁን ያለው: "${typedText}"`
        : 'ደንበኛው አሁን የተናገረውን ድምፅ (Amharic/English) በትክክል ወደ ጽሑፍ (transcript) ቀይርና ተስማሚ የስልክ መልስ (reply) ስጥ።',
    ]
      .filter(Boolean)
      .join('\n');

    const contents = audioBase64
      ? {
          parts: [
            {
              inlineData: {
                mimeType: audioMimeType,
                data: audioBase64,
              },
            },
            { text: promptText },
          ],
        }
      : promptText;

    const modelCandidates: Array<{ model: string; thinkingLevel: ThinkingLevel }> = [
      { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW },
      { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
    ];

    let llmRes: Awaited<ReturnType<typeof ai.models.generateContent>> | null = null;
    let lastLlmErr: unknown = null;

    for (const candidate of modelCandidates) {
      let succeeded = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          llmRes = await ai.models.generateContent({
            model: candidate.model,
            contents,
            config: {
              systemInstruction,
              thinkingConfig: { thinkingLevel: candidate.thinkingLevel },
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  transcript: {
                    type: Type.STRING,
                    description: 'Exact transcription of what the caller just said.',
                  },
                  reply: {
                    type: Type.STRING,
                    description: 'Short natural spoken support response for a phone call.',
                  },
                },
                required: ['transcript', 'reply'],
              },
            },
          });
          succeeded = true;
          break;
        } catch (err) {
          lastLlmErr = err;
          if (!isTransientGeminiError(err)) {
            throw err;
          }
          if (attempt === 0) {
            await sleep(450);
          }
        }
      }
      if (succeeded) break;
    }

    if (!llmRes) {
      throw lastLlmErr ?? new Error('Gemini model temporarily unavailable');
    }

    let transcript = typedText;
    let replyText = '';
    try {
      const parsed = JSON.parse((llmRes.text ?? '{}').trim()) as {
        transcript?: string;
        reply?: string;
      };
      if (parsed.transcript && !typedText) {
        transcript = parsed.transcript.trim();
      }
      if (parsed.reply) {
        replyText = parsed.reply.trim();
      }
    } catch {
      replyText = (llmRes.text ?? '').trim();
    }

    if (!replyText) {
      replyText = 'ይቅርታ ደንበኛችን፣ ጥያቄዎን በድጋሚ በግልፅ ይንገሩኝ።';
    }

    const replyAudioBase64 = await synthesizeSpeechWav(ai, replyText, voiceName);

    return NextResponse.json(
      {
        ok: true,
        transcript: transcript || '...',
        replyText,
        audioBase64: replyAudioBase64,
        audioMimeType: replyAudioBase64 ? 'audio/wav' : null,
      },
      { headers: corsHeaders }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'AI support call error';
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500, headers: corsHeaders }
    );
  }
}
