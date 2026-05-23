import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import os from 'os';

/**
 * Transcribe audio buffer to text using gpt-4o-transcribe,
 * then clean up the transcription with GPT-4o-mini.
 */
export async function transcribeAudio(audioBuffer: Buffer): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(
      'OpenAI API key not configured. Please set OPENAI_API_KEY in server environment.',
    );
  }

  // Convert audio to mp3 format
  // @ts-expect-error - fluent-ffmpeg has no published type definitions
  const ffmpeg = (await import('fluent-ffmpeg')).default;
  const ffmpegPath = (await import('ffmpeg-static')).default as unknown as string;

  ffmpeg.setFfmpegPath(ffmpegPath);

  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `input_${Date.now()}.webm`);
  const outputPath = path.join(tmpDir, `output_${Date.now()}.mp3`);

  // Write input buffer to temp file
  await fs.writeFile(inputPath, audioBuffer);

  // Convert to mp3
  await new Promise<void>((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat('mp3')
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });

  // Use gpt-4o-transcribe for transcription
  const OpenAI = (await import('openai')).default;
  const openai = new OpenAI({ apiKey });

  const transcription = await openai.audio.transcriptions.create({
    file: createReadStream(outputPath),
    model: 'gpt-4o-transcribe',
    language: 'en', // Force English to prevent auto-detection errors
  });

  // Clean up temp files
  await fs.unlink(inputPath).catch(() => {});
  await fs.unlink(outputPath).catch(() => {});

  let transcribedText = transcription.text || '';

  // If no transcribed text, return empty
  if (!transcribedText) {
    return '';
  }

  // Clean up the transcription
  transcribedText = await cleanupTranscription(openai as unknown as OpenAIChatClient, transcribedText);

  return transcribedText;
}

/**
 * Clean up a raw transcription to fix grammar, filler words, etc.
 * while preserving the user's exact intent.
 */
type OpenAIChatClient = {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: Array<{ role: string; content: string }>;
        temperature: number;
        max_tokens: number;
      }) => Promise<{ choices: Array<{ message: { content: string | null } }> }>;
    };
  };
};

async function cleanupTranscription(
  openai: OpenAIChatClient,
  rawText: string,
): Promise<string> {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You are a transcription cleaner. Your ONLY job is to output a clean, polished version of the user\'s spoken message. Do NOT answer questions, provide information, or interpret the content.',
        },
        {
          role: 'user',
          content: `You are cleaning up a voice-to-text transcription. Your task is to:

1. TRANSCRIBE: Output ONLY what the user said, cleaned up
2. CLARIFY: Fix grammar, filler words (um, uh), and incomplete sentences
3. PRESERVE: Keep the user's exact intent, meaning, and tone

CRITICAL RULES:
- Output ONLY the cleaned message, nothing else
- Do NOT answer questions the user asks
- Do NOT provide information or explanations
- Do NOT add your own words, context, or instructions
- Do NOT change the meaning or expand on ideas
- If the user asks "What is the weather in Paris?", output exactly: "What is the weather in Paris?"

Raw transcription to clean:
"${rawText}"

Cleaned message:`,
        },
      ],
      temperature: 0.3,
      max_tokens: 800,
    });

    const cleaned = completion.choices[0]?.message.content ?? rawText;
    // Strip surrounding quotes that the LLM sometimes adds
    return cleaned.replace(/^["']|["']$/g, '');
  } catch (error) {
    console.error('Transcription cleanup error:', error);
    // Fall back to raw transcription if cleanup fails
    return rawText;
  }
}
