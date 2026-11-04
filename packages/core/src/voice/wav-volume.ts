/** @description: 对临时 WAV 的 PCM/浮点样本调节增益，不改系统或其他应用的音量。 */
export function scaleWavVolume(source: Buffer, gain: number): Buffer {
  const invalid = (): never => {
    throw new Error('音频格式不支持独立音量调节：需要有效的 PCM 或浮点 WAV');
  };
  if (
    source.length < 12 ||
    source.toString('ascii', 0, 4) !== 'RIFF' ||
    source.toString('ascii', 8, 12) !== 'WAVE'
  )
    return invalid();
  const end = source.readUInt32LE(4) + 8;
  if (end > source.length || end < 12 || !Number.isFinite(gain) || gain < 0 || gain > 1)
    return invalid();
  let format = 0;
  let bits = 0;
  let blockAlign = 0;
  let channels = 0;
  const chunks: Array<{ start: number; size: number }> = [];
  for (let offset = 12; offset + 8 <= end;) {
    const id = source.toString('ascii', offset, offset + 4);
    const size = source.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (start + size > end) return invalid();
    if (id === 'fmt ') {
      if (size < 16) return invalid();
      format = source.readUInt16LE(start);
      channels = source.readUInt16LE(start + 2);
      blockAlign = source.readUInt16LE(start + 12);
      bits = source.readUInt16LE(start + 14);
      if (format === 0xfffe) {
        if (size < 40 || source.readUInt16LE(start + 16) < 22) return invalid();
        const guidTail = Buffer.from([0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]);
        if (!source.subarray(start + 28, start + 40).equals(guidTail)) return invalid();
        format = source.readUInt32LE(start + 24);
      }
    } else if (id === 'data') chunks.push({ start, size });
    offset = start + size + (size & 1);
    if (offset > end) return invalid();
  }
  const bytes = bits / 8;
  if (
    !channels ||
    blockAlign !== channels * bytes ||
    !chunks.length ||
    !((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && [32, 64].includes(bits)))
  )
    return invalid();
  const result = Buffer.from(source);
  for (const chunk of chunks) {
    if (chunk.size % blockAlign !== 0) return invalid();
    for (let offset = chunk.start; offset < chunk.start + chunk.size; offset += bytes) {
      if (format === 3) {
        const sample = bits === 32 ? source.readFloatLE(offset) : source.readDoubleLE(offset);
        if (!Number.isFinite(sample)) return invalid();
        if (bits === 32) result.writeFloatLE(sample * gain, offset);
        else result.writeDoubleLE(sample * gain, offset);
      } else if (bits === 8) {
        result.writeUInt8(Math.round((source.readUInt8(offset) - 128) * gain) + 128, offset);
      } else {
        result.writeIntLE(Math.round(source.readIntLE(offset, bytes) * gain), offset, bytes);
      }
    }
  }
  return result;
}
