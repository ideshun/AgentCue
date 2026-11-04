import { describe, expect, it } from 'vitest';
import { scaleWavVolume } from './wav-volume';

function wav(format: number, bits: number, samples: number[]): Buffer {
  const bytes = bits / 8;
  const data = Buffer.alloc(44 + bytes * samples.length);
  data.write('RIFF', 0);
  data.writeUInt32LE(data.length - 8, 4);
  data.write('WAVE', 8);
  data.write('fmt ', 12);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(format, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(24000, 24);
  data.writeUInt32LE(24000 * bytes, 28);
  data.writeUInt16LE(bytes, 32);
  data.writeUInt16LE(bits, 34);
  data.write('data', 36);
  data.writeUInt32LE(bytes * samples.length, 40);
  samples.forEach((sample, index) => {
    const offset = 44 + index * bytes;
    if (format === 3) data.writeFloatLE(sample, offset);
    else if (bits === 8) data.writeUInt8(sample, offset);
    else data.writeIntLE(sample, offset, bytes);
  });
  return data;
}

describe('WAV playback gain', () => {
  it('scales PCM samples while leaving the source buffer and header intact', () => {
    const source = wav(1, 16, [10000, -10000, 32767, -32768]);
    const output = scaleWavVolume(source, 0.5);
    expect([44, 46, 48, 50].map((offset) => output.readInt16LE(offset))).toEqual([
      5000, -5000, 16384, -16384,
    ]);
    expect(source.readInt16LE(44)).toBe(10000);
    expect(output.subarray(0, 44)).toEqual(source.subarray(0, 44));
    expect(scaleWavVolume(source, 0).readInt16LE(44)).toBe(0);
  });

  it('scales unsigned PCM and float samples', () => {
    const unsigned = scaleWavVolume(wav(1, 8, [0, 128, 255, 128]), 0.5);
    expect([...unsigned.subarray(44)]).toEqual([64, 128, 192, 128]);
    const float = scaleWavVolume(wav(3, 32, [0.75, -0.5]), 0.5);
    expect(float.readFloatLE(44)).toBeCloseTo(0.375);
    expect(float.readFloatLE(48)).toBeCloseTo(-0.25);
  });

  it.each([24, 32])('scales %s-bit PCM without changing the container format', (bits) => {
    const max = 2 ** (bits - 1) - 1;
    const min = -(2 ** (bits - 1));
    const output = scaleWavVolume(wav(1, bits, [max, min]), 0.5);
    expect(output.readIntLE(44, bits / 8)).toBe(Math.round(max * 0.5));
    expect(output.readIntLE(44 + bits / 8, bits / 8)).toBe(min / 2);
  });

  it('accepts PCM WAVE_FORMAT_EXTENSIBLE', () => {
    const input = Buffer.alloc(70);
    input.write('RIFF');
    input.writeUInt32LE(62, 4);
    input.write('WAVE', 8);
    input.write('fmt ', 12);
    input.writeUInt32LE(40, 16);
    input.writeUInt16LE(0xfffe, 20);
    input.writeUInt16LE(1, 22);
    input.writeUInt32LE(24000, 24);
    input.writeUInt32LE(48000, 28);
    input.writeUInt16LE(2, 32);
    input.writeUInt16LE(16, 34);
    input.writeUInt16LE(22, 36);
    input.writeUInt16LE(16, 38);
    input.writeUInt32LE(1, 44);
    Buffer.from([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]).copy(input, 48);
    input.write('data', 60);
    input.writeUInt32LE(2, 64);
    input.writeInt16LE(10000, 68);
    expect(scaleWavVolume(input, 0.5).readInt16LE(68)).toBe(5000);
  });

  it('rejects truncated or unsupported WAV data instead of silently ignoring volume', () => {
    expect(() => scaleWavVolume(Buffer.from('bad'), 0.5)).toThrow('音量调节');
    const unsupported = wav(1, 16, [100]);
    unsupported.writeUInt16LE(6, 20);
    expect(() => scaleWavVolume(unsupported, 0.5)).toThrow('音量调节');
    expect(() => scaleWavVolume(wav(1, 16, [100]).subarray(0, 45), 0.5)).toThrow('音量调节');
  });
});
