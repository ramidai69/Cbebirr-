import { GoogleGenAI, Type } from '@google/genai';
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

interface RequestBody {
  audioBase64?: string;
  audioMimeType?: string;
  text?: string;
  history?: HistoryItem[];
  context?: SupportContext;
  agentName?: string;
  voiceName?: string;
  systemNotes?: string;
  mp3ContextSummary?: string;
}

const VALID_VOICES = new Set(['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr']);

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: 'GEMINI_API_KEY is not configured on the server.' },
        { status: 500, headers: corsHeaders }
      );
    }

    const body = (await req.json()) as RequestBody;
    const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : '';
    const audioMimeType =
      typeof body.audioMimeType === 'string' && body.audioMimeType.trim()
        ? body.audioMimeType.trim()
        : 'audio/webm';
    const typedText = typeof body.text === 'string' ? body.text.trim() : '';

    if (!audioBase64 && !typedText) {
      return NextResponse.json(
        { ok: false, error: 'Either audioBase64 or text is required.' },
        { status: 400, headers: corsHeaders }
      );
    }

    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const ctx = body.context || {};
    const agentName = (body.agentName || 'እድሪስ').trim();
    const voiceName = VALID_VOICES.has(String(body.voiceName || ''))
      ? String(body.voiceName)
      : 'Charon';

    const historyLines = Array.isArray(body.history)
      ? body.history
          .slice(-10)
          .map((h) => `${h.role === 'user' ? 'ደንበኛ' : 'ባለሙያ'}: ${String(h.text || '').trim()}`)
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

    const llmRes = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents,
      config: {
        systemInstruction,
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

    // Generate spoken WAV audio via Gemini TTS
    let replyAudioBase64: string | null = null;
    try {
      const ttsRes = await ai.models.generateContent({
        model: 'gemini-3.8-flash-lite-tts',
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: replyText,
                speechMetadata: {
                  style: 'Warm, calm, professional Ethiopian bank customer support agent on a phone call',
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
      replyAudioBase64 =
        ttsRes.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data ?? null;
    } catch (ttsErr) {
      console.warn('[Dialer AI Support TTS fallback]', ttsErr);
      replyAudioBase64 = null;
    }

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
