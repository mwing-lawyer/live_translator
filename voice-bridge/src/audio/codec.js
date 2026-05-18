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
 * Used for the 8k -> 24k upsample path (Twilio -> OpenAI). Whisper is robust to
 * imaging artifacts, and this is the per-Twilio-frame hot path.
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
 * Build a windowed-sinc low-pass FIR. Hamming window. Coefficients are normalized
 * so DC gain == 1 and stored as float64 for accumulator precision.
 *
 * @param {number} numTaps - Filter length (odd, e.g. 31).
 * @param {number} cutoffHz - -6 dB cutoff frequency.
 * @param {number} fs - Sample rate.
 * @returns {Float64Array}
 */
function buildLowpass(numTaps, cutoffHz, fs) {
  const taps = new Float64Array(numTaps);
  const fc = cutoffHz / fs; // normalized 0..0.5
  const M = numTaps - 1;
  let sum = 0;
  for (let n = 0; n < numTaps; n++) {
    const k = n - M / 2;
    const sinc = k === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * k) / (Math.PI * k);
    const hamming = 0.54 - 0.46 * Math.cos((2 * Math.PI * n) / M);
    taps[n] = sinc * hamming;
    sum += taps[n];
  }
  // Normalize to unity DC gain.
  for (let n = 0; n < numTaps; n++) taps[n] /= sum;
  return taps;
}

// Anti-alias low-pass for 24 kHz -> 8 kHz decimation. Cutoff comfortably below
// 4 kHz Nyquist of the output, aligned to phone-band so it sounds natural.
const LP_TAPS_24K = buildLowpass(31, 3400, 24000);
const LP_NUM_TAPS = LP_TAPS_24K.length;
const LP_CENTER = (LP_NUM_TAPS - 1) / 2;

/**
 * Convolve pcm24k with the anti-alias FIR and keep every 3rd sample (decimate by 3).
 * Centered FIR: output sample i corresponds to input center index i*3. Out-of-range
 * input is treated as zero, which only affects ~LP_CENTER samples at each chunk edge.
 */
function lowpassDecimate24To8(pcm24k) {
  const outLen = Math.floor(pcm24k.length / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const inCenter = i * 3;
    let acc = 0;
    for (let k = 0; k < LP_NUM_TAPS; k++) {
      const idx = inCenter - LP_CENTER + k;
      if (idx >= 0 && idx < pcm24k.length) {
        acc += LP_TAPS_24K[k] * pcm24k[idx];
      }
    }
    if (acc > 32767) acc = 32767;
    else if (acc < -32768) acc = -32768;
    out[i] = acc | 0;
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
 * Anti-alias low-pass + 3:1 decimation. Without the low-pass, OpenAI voices fold
 * energy above 4 kHz back into the 0-4 kHz band, which sounds gritty/garbled.
 */
export function openAIToTwilio(base64Pcm16) {
  const buf = Buffer.from(base64Pcm16, "base64");
  const pcm24k = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
  const pcm8k = lowpassDecimate24To8(pcm24k);
  const mulaw = Buffer.alloc(pcm8k.length);
  for (let i = 0; i < pcm8k.length; i++) {
    mulaw[i] = mulawEncode(pcm8k[i]);
  }
  return mulaw.toString("base64");
}
