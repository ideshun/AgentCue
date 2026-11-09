use super::{Cancellation, SpeakOptions, audio};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{sync::LazyLock, time::Duration};
use tokio::process::Command;
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Voice {
    pub id: String,
    pub name: String,
    pub language: String,
}
#[derive(Serialize)]
pub struct VoiceList {
    pub voices: Vec<Voice>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
fn allowlist() -> Vec<(Regex, Regex)> {
    let rules: Vec<Value> =
        serde_json::from_str(include_str!("../../resources/native-voices.json"))
            .expect("embedded native voices");
    rules
        .iter()
        .map(|rule| {
            (
                Regex::new(&format!("(?i){}", rule["pattern"].as_str().unwrap())).unwrap(),
                Regex::new(&format!("(?i){}", rule["language"].as_str().unwrap())).unwrap(),
            )
        })
        .collect()
}
pub fn parse_voices(output: &str) -> Vec<Voice> {
    static LINE: LazyLock<Regex> = LazyLock::new(|| {
        Regex::new(r"(?i)^(.+?)\s+([a-z]{2,3}(?:[_-][a-z0-9]{2,8})+)\s+#").unwrap()
    });
    static ALLOW: LazyLock<Vec<(Regex, Regex)>> = LazyLock::new(allowlist);
    let mut voices = vec![];
    for line in output.lines() {
        if let Some(c) = LINE.captures(line) {
            let name = c[1].trim();
            let language = &c[2];
            if let Some(rank) = ALLOW
                .iter()
                .position(|(pattern, lang)| pattern.is_match(name) && lang.is_match(language))
            {
                voices.push((
                    rank,
                    Voice {
                        id: name.into(),
                        name: name.into(),
                        language: language.into(),
                    },
                ));
            }
        }
    }
    voices.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then(a.1.name.cmp(&b.1.name))
            .then(a.1.language.cmp(&b.1.language))
    });
    voices.dedup_by(|a, b| a.1.id == b.1.id && a.1.language == b.1.language);
    voices.into_iter().map(|v| v.1).collect()
}
pub async fn voices() -> VoiceList {
    if !cfg!(target_os = "macos") {
        return VoiceList {
            voices: vec![],
            error: Some("当前平台尚不支持列出原生音色，仍可使用系统默认语音".into()),
        };
    }
    let (keep, receiver) = tokio::sync::watch::channel(0);
    let cancel = Cancellation {
        receiver,
        generation: 0,
    };
    let mut cmd = Command::new("/usr/bin/say");
    cmd.args(["-v", "?"]);
    let result = audio::command(cmd, None, 256 * 1024, cancel, Duration::from_secs(3)).await;
    drop(keep);
    match result {
        Ok(bytes) => {
            let voices = parse_voices(&String::from_utf8_lossy(&bytes));
            let error = voices
                .is_empty()
                .then(|| "本机未安装可用的系统中文音色，请在系统设置下载中文音色".into());
            VoiceList { voices, error }
        }
        Err(error) => VoiceList {
            voices: vec![],
            error: Some(error),
        },
    }
}
pub async fn speak(options: &SpeakOptions, cancel: Cancellation) -> Result<(), String> {
    if cfg!(target_os = "macos") {
        let voices = voices().await;
        let selected = voices
            .voices
            .iter()
            .find(|v| v.id == options.voice_profile)
            .or_else(|| voices.voices.iter().find(|v| v.language.starts_with("zh")))
            .ok_or_else(|| {
                voices
                    .error
                    .unwrap_or_else(|| "本机未安装可用的系统中文音色".into())
            })?;
        if cancel.cancelled() {
            return Err("播报已打断".into());
        }
        let directory = audio::Temporary::new().map_err(|_| "临时音频目录创建失败")?;
        let file = directory.path.join("speech.aiff");
        let mut cmd = Command::new("/usr/bin/say");
        cmd.arg("-r")
            .arg((options.rate.clamp(0.5, 2.0) * 180.0).round().to_string())
            .arg("-o")
            .arg(&file)
            .arg("-v")
            .arg(&selected.id);
        audio::command(
            cmd,
            Some(&options.text),
            0,
            cancel.clone(),
            Duration::from_secs(30),
        )
        .await?;
        let data = tokio::fs::read(&file)
            .await
            .map_err(|_| "系统生成的音频不可读")?;
        if !audio::has_aiff_speech(&data) {
            return Err("系统语音未生成有效音频，请检查音色与系统语音权限".into());
        }
        audio::play(&file, options.volume, cancel).await
    } else if cfg!(windows) {
        let mut cmd = Command::new("powershell.exe");
        cmd.args(["-NoProfile","-NonInteractive","-Command","[Console]::InputEncoding=New-Object System.Text.UTF8Encoding; Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=[int]$env:AGENTCUE_RATE; $s.Volume=[int]$env:AGENTCUE_VOLUME; if($env:AGENTCUE_VOICE){$s.SelectVoice($env:AGENTCUE_VOICE)}; $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()"]).env("AGENTCUE_RATE",((options.rate.clamp(0.5,2.0)-1.0)*5.0).round().to_string()).env("AGENTCUE_VOLUME",(options.volume.clamp(0.0,1.0)*100.0).round().to_string()).env("AGENTCUE_VOICE",if options.voice_profile=="system-default"{""}else{&options.voice_profile});
        audio::command(cmd, Some(&options.text), 0, cancel, Duration::from_secs(30)).await?;
        Ok(())
    } else {
        let binary = audio::binary("espeak-ng")
            .or_else(|| audio::binary("espeak"))
            .ok_or("未找到系统语音程序（espeak-ng 或 espeak）")?;
        let mut cmd = Command::new(binary);
        cmd.arg("--stdin")
            .arg("-s")
            .arg((options.rate.clamp(0.5, 2.0) * 175.0).round().to_string())
            .arg("-a")
            .arg((options.volume.clamp(0.0, 1.0) * 200.0).round().to_string());
        if options.voice_profile != "system-default" && !options.voice_profile.is_empty() {
            cmd.arg("-v").arg(&options.voice_profile);
        }
        audio::command(cmd, Some(&options.text), 0, cancel, Duration::from_secs(30)).await?;
        Ok(())
    }
}
