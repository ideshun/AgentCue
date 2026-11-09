use super::Cancellation;
use std::{
    io,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

pub struct Temporary {
    pub path: PathBuf,
}
impl Temporary {
    pub fn new() -> io::Result<Self> {
        let path = std::env::temp_dir().join(format!("agentcue-speech-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
        }
        Ok(Self { path })
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}
/// No shell. A cancelled or failed playback is terminated and reaped before returning.
pub async fn command(
    mut command: Command,
    input: Option<&str>,
    max_output: usize,
    mut cancel: Cancellation,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    if cancel.cancelled() {
        return Err("播报已打断".into());
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if max_output > 0 {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("语音程序启动失败：{e}"))?;
    let mut errors = child.stderr.take().ok_or("语音错误管道不可用")?;
    let mut diagnostics = tokio::spawn(async move {
        let mut tail = Vec::new();
        let mut buffer = [0; 1024];
        while let Ok(n) = errors.read(&mut buffer).await {
            if n == 0 {
                break;
            }
            tail.extend_from_slice(&buffer[..n]);
            if tail.len() > 2048 {
                tail.drain(..tail.len() - 2048);
            }
        }
        String::from_utf8_lossy(&tail).trim().to_owned()
    });
    let work = async {
        if let (Some(text), Some(mut input)) = (input, child.stdin.take()) {
            input
                .write_all(text.as_bytes())
                .await
                .map_err(|_| "语音输入管道失败")?;
            input.shutdown().await.map_err(|_| "语音输入管道失败")?;
        }
        let mut bytes = vec![];
        if let Some(output) = child.stdout.take() {
            output
                .take(max_output as u64 + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "语音输出读取失败")?;
            if bytes.len() > max_output {
                return Err("语音输出超过大小上限".to_owned());
            }
        }
        let status = child.wait().await.map_err(|_| "语音程序退出异常")?;
        if !status.success() {
            return Err(format!("语音程序退出异常（{status}）"));
        }
        Ok(bytes)
    };
    let result = tokio::select! {
        _=cancel.wait()=>Err("播报已打断".into()),
        result=tokio::time::timeout(timeout,work)=>result.unwrap_or_else(|_|Err("语音处理超时".into())),
    };
    if result.is_err() {
        let _ = child.kill().await;
    }
    let detail = tokio::time::timeout(Duration::from_millis(100), &mut diagnostics)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    diagnostics.abort();
    result.map_err(|error| {
        if detail.is_empty() || error == "播报已打断" {
            error
        } else {
            format!("{error}：{detail}")
        }
    })
}
pub fn has_aiff_speech(data: &[u8]) -> bool {
    if data.len() < 12
        || &data[..4] != b"FORM"
        || (![b"AIFF".as_slice(), b"AIFC".as_slice()].contains(&&data[8..12]))
    {
        return false;
    }
    let mut position = 12;
    let mut pcm16 = false;
    while position + 8 <= data.len() {
        let size =
            u32::from_be_bytes(data[position + 4..position + 8].try_into().unwrap()) as usize;
        let body = position + 8;
        let Some(end) = body.checked_add(size).filter(|n| *n <= data.len()) else {
            return false;
        };
        if &data[position..position + 4] == b"COMM" && size >= 18 {
            pcm16 = u16::from_be_bytes(data[body + 6..body + 8].try_into().unwrap()) == 16
                && u32::from_be_bytes(data[body + 2..body + 6].try_into().unwrap()) > 0;
        }
        if &data[position..position + 4] == b"SSND" && size > 8 && pcm16 {
            let offset = u32::from_be_bytes(data[body..body + 4].try_into().unwrap()) as usize;
            return body
                .checked_add(8)
                .and_then(|n| n.checked_add(offset))
                .is_some_and(|start| start < end && data[start..end].iter().any(|b| *b != 0));
        }
        position = end + (size % 2);
    }
    false
}
pub fn binary(name: &str) -> Option<PathBuf> {
    let name = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.into()
    };
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .map(|p| p.join(&name))
        .find(|p| {
            let Ok(stat) = p.metadata() else {
                return false;
            };
            if !stat.is_file() {
                return false;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                stat.permissions().mode() & 0o111 != 0
            }
            #[cfg(not(unix))]
            {
                true
            }
        })
}
pub async fn play(file: &Path, volume: f64, cancel: Cancellation) -> Result<(), String> {
    let gain = volume.clamp(0.0, 1.0);
    let cmd = if cfg!(target_os = "macos") {
        let mut c = Command::new("/usr/bin/afplay");
        c.arg("-v").arg(gain.to_string()).arg(file);
        c
    } else if cfg!(windows) {
        if gain != 1.0 {
            let data = tokio::fs::read(file)
                .await
                .map_err(|_| "生成的音频不可读")?;
            let data = scale_wav(&data, gain)?;
            tokio::fs::write(file, data)
                .await
                .map_err(|_| "音量调整失败")?;
        }
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile","-NonInteractive","-Command","$p=New-Object System.Media.SoundPlayer; $p.SoundLocation=$env:AGENTCUE_PLAY_FILE; $p.PlaySync(); $p.Dispose()"]).env("AGENTCUE_PLAY_FILE",file);
        c
    } else if let Some(player) = binary("paplay") {
        let mut c = Command::new(player);
        c.arg(format!("--volume={}", (gain * 65536.0).round() as u32))
            .arg("--")
            .arg(file);
        c
    } else if let Some(player) = binary("aplay") {
        if gain != 1.0 {
            let data = tokio::fs::read(file)
                .await
                .map_err(|_| "生成的音频不可读")?;
            let data = scale_wav(&data, gain)?;
            tokio::fs::write(file, data)
                .await
                .map_err(|_| "音量调整失败")?;
        }
        let mut c = Command::new(player);
        c.arg("-q").arg(file);
        c
    } else {
        return Err("未找到 Linux 音频播放程序（paplay 或 aplay）".into());
    };
    command(cmd, None, 0, cancel, Duration::from_secs(30)).await?;
    Ok(())
}
struct WaveFormat {
    kind: u32,
    bits: u16,
    chunks: Vec<(usize, usize)>,
}
fn wave_format(data: &[u8]) -> Result<WaveFormat, String> {
    if data.len() < 12 || &data[..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("生成的音频不是 WAV".into());
    }
    let end = (u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize)
        .checked_add(8)
        .filter(|n| *n >= 12 && *n <= data.len())
        .ok_or("WAV 数据不完整")?;
    let mut position = 12;
    let mut format = None;
    let mut chunks = vec![];
    while position + 8 <= end {
        let size =
            u32::from_le_bytes(data[position + 4..position + 8].try_into().unwrap()) as usize;
        let body = position + 8;
        let next = body
            .checked_add(size)
            .filter(|n| *n <= end)
            .ok_or("WAV 数据不完整")?;
        if &data[position..position + 4] == b"fmt " {
            if size < 16 {
                return Err("WAV 格式信息不完整".into());
            }
            let mut kind = u16::from_le_bytes(data[body..body + 2].try_into().unwrap()) as u32;
            let channels =
                u16::from_le_bytes(data[body + 2..body + 4].try_into().unwrap()) as usize;
            let block = u16::from_le_bytes(data[body + 12..body + 14].try_into().unwrap()) as usize;
            let bits = u16::from_le_bytes(data[body + 14..body + 16].try_into().unwrap());
            if kind == 0xfffe {
                if size < 40
                    || u16::from_le_bytes(data[body + 16..body + 18].try_into().unwrap()) < 22
                    || data[body + 28..body + 40] != [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]
                {
                    return Err("WAV 扩展格式不受支持".into());
                }
                kind = u32::from_le_bytes(data[body + 24..body + 28].try_into().unwrap());
            }
            if channels == 0
                || block != channels * (bits as usize / 8)
                || !((kind == 1 && [8, 16, 24, 32].contains(&bits))
                    || (kind == 3 && [32, 64].contains(&bits)))
            {
                return Err("WAV 音频格式不受支持".into());
            }
            format = Some((kind, bits, block));
        } else if &data[position..position + 4] == b"data" {
            chunks.push((body, next));
        }
        position = next + (size % 2);
        if position > end {
            return Err("WAV 填充数据不完整".into());
        }
    }
    let (kind, bits, block) = format.ok_or("WAV 缺少格式信息")?;
    if chunks.is_empty() || chunks.iter().any(|(start, end)| (end - start) % block != 0) {
        return Err("WAV 采样数据不完整".into());
    }
    Ok(WaveFormat { kind, bits, chunks })
}
pub fn scale_wav(input: &[u8], gain: f64) -> Result<Vec<u8>, String> {
    if !gain.is_finite() || !(0.0..=1.0).contains(&gain) {
        return Err("音量超出有效范围".into());
    }
    let format = wave_format(input)?;
    let bytes = format.bits as usize / 8;
    let mut data = input.to_vec();
    for (start, end) in format.chunks {
        for sample in data[start..end].chunks_exact_mut(bytes) {
            match (format.kind, format.bits) {
                (3, 32) => {
                    let value = f32::from_le_bytes(sample.try_into().unwrap());
                    if !value.is_finite() {
                        return Err("WAV 含无效浮点采样".into());
                    }
                    sample.copy_from_slice(&((value as f64 * gain) as f32).to_le_bytes());
                }
                (3, 64) => {
                    let value = f64::from_le_bytes(sample.try_into().unwrap());
                    if !value.is_finite() {
                        return Err("WAV 含无效浮点采样".into());
                    }
                    sample.copy_from_slice(&(value * gain).to_le_bytes());
                }
                (1, 8) => {
                    sample[0] = (((sample[0] as f64 - 128.0) * gain + 0.5).floor() + 128.0) as u8;
                }
                (1, 16) => {
                    let n = i16::from_le_bytes(sample.try_into().unwrap());
                    sample.copy_from_slice(&((n as f64 * gain + 0.5).floor() as i16).to_le_bytes());
                }
                (1, 24) => {
                    let value = i32::from_le_bytes([
                        sample[0],
                        sample[1],
                        sample[2],
                        if sample[2] & 0x80 != 0 { 255 } else { 0 },
                    ]);
                    sample.copy_from_slice(
                        &((value as f64 * gain + 0.5).floor() as i32).to_le_bytes()[..3],
                    );
                }
                (1, 32) => {
                    let n = i32::from_le_bytes(sample.try_into().unwrap());
                    sample.copy_from_slice(&((n as f64 * gain + 0.5).floor() as i32).to_le_bytes());
                }
                _ => unreachable!(),
            }
        }
    }
    Ok(data)
}
pub fn has_wav_speech(data: &[u8]) -> bool {
    let Ok(format) = wave_format(data) else {
        return false;
    };
    let bytes = format.bits as usize / 8;
    format.chunks.iter().any(|(start, end)| {
        data[*start..*end]
            .chunks_exact(bytes)
            .any(|sample| match (format.kind, format.bits) {
                (1, 8) => sample[0] != 128,
                (3, 32) => {
                    let value = f32::from_le_bytes(sample.try_into().unwrap());
                    value.is_finite() && value.abs() > 0.000001
                }
                (3, 64) => {
                    let value = f64::from_le_bytes(sample.try_into().unwrap());
                    value.is_finite() && value.abs() > 0.000001
                }
                _ => sample.iter().any(|b| *b != 0),
            })
    })
}
