// ITU-T G.711 mu-law codec + linear interpolation resampler.
// Twilio Media Streams: mulaw 8-bit, 8 kHz, mono
// OpenAI Realtime API:  PCM16 (linear16), 24 kHz, mono

const MULAW_BIAS = 0x84; // 132
const MULAW_CLIP = 32635;

const EXP_LUT = [
  0, 132, 396, 924, 1980, 4092, 8316, 16764,
];

/**
 * Decode a single mu-law byte to a 16-bit linear sample.
 */
export function mulawDecode(mulawByte) {
  mulawByte = ~mulawByte & 0xFF;
  const sign = mulawByte & 0x80;
  const exponent = (mulawByte >> 4) & 0x07;
  const mantissa = mulawByte & 0x0F;
  let sample = EXP_LUT[exponent] + (mantissa << (exponent + 3));
  if (sign !== 0) sample = -sample;
  return sample;
}

/**
 * Encode a 16-bit linear sample to a single mu-law byte.
 */
export function mulawEncode(sample) {
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    /* scan for leading 1 */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return ~(sign | (exponent << 4) | mantissa) & 0xFF;
}

/**
 * Resample Int16Array from one sample rate to another using linear interpolation.
 */
export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.round(samples.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? 0;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

/**
 * Convert Twilio media payload (base64 mulaw 8 kHz) to OpenAI input (base64 PCM16 24 kHz).
 */
export function twilioToOpenAI(base64Mulaw) {
  const mulaw = Buffer.from(base64Mulaw, "base64");
  const pcm8k = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    pcm8k[i] = mulawDecode(mulaw[i]);
  }
  const pcm24k = resample(pcm8k, 8000, 24000);
  return Buffer.from(pcm24k.buffer).toString("base64");
}

/**
 * Convert OpenAI output (base64 PCM16 24 kHz) to Twilio media payload (base64 mulaw 8 kHz).
 */
export function openAIToTwilio(base64Pcm16) {
  const buf = Buffer.from(base64Pcm16, "base64");
  const pcm24k = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const pcm8k = resample(pcm24k, 24000, 8000);
  const mulaw = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    mulaw[i] = mulawEncode(pcm8k[i]);
  }
  return mulaw.toString("base64");
}
