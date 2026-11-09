//! Inference-only sidecar: no GUI, network, database, playback or user-data discovery.
//! The desktop starts it only for local TTS and terminates it on cancellation or timeout.
use serde::Deserialize;
use serde_json::{Value, json};
use sherpa_onnx::{
    GenerationConfig, OfflineTts, OfflineTtsConfig, OfflineTtsKokoroModelConfig,
    OfflineTtsModelConfig, OfflineTtsZipvoiceModelConfig, Wave,
};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, BufRead, Write},
    path::PathBuf,
};
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    kind: String,
    model_dir: PathBuf,
    output: PathBuf,
    text: String,
    profile: String,
    rate: f32,
    #[serde(default)]
    reference_path: PathBuf,
    #[serde(default)]
    reference_text: String,
}
struct Cached {
    key: (String, PathBuf),
    engine: OfflineTts,
}
fn pronunciation(source: &str) -> Result<String, String> {
    let phrases: Vec<String> =
        serde_json::from_str(include_str!("../resources/pronunciation.json"))
            .map_err(|_| "发音词典配置无效")?;
    let needed: HashSet<_> = phrases
        .iter()
        .flat_map(|s| s.chars().skip(1))
        .chain(['崇', '虫'])
        .collect();
    let mut entries = HashMap::new();
    for line in source.lines() {
        let mut parts = line.split_whitespace();
        let Some(word) = parts.next() else {
            continue;
        };
        let mut chars = word.chars();
        let Some(character) = chars.next() else {
            continue;
        };
        if chars.next().is_some() || !needed.contains(&character) {
            continue;
        }
        let phones = parts.collect::<Vec<_>>().join(" ");
        if !phones.is_empty() {
            entries.entry(character).or_insert(phones);
        }
    }
    let chong = entries
        .get(&'崇')
        .or_else(|| entries.get(&'虫'))
        .ok_or("Kokoro 中文词典缺少 chóng 基础读音，请重新下载模型")?;
    let mut result = String::new();
    for phrase in phrases {
        let suffix: Option<Vec<&String>> =
            phrase.chars().skip(1).map(|c| entries.get(&c)).collect();
        if let Some(suffix) = suffix {
            result.push_str(&format!(
                "{phrase} {chong} {}\n",
                suffix
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
        }
    }
    Ok(result)
}
fn load(request: &Request) -> Result<Cached, String> {
    let model = &request.model_dir;
    let file = |name: &str| Some(model.join(name).to_string_lossy().into_owned());
    let mut config = OfflineTtsConfig {
        model: OfflineTtsModelConfig {
            num_threads: 2,
            provider: Some("cpu".into()),
            ..Default::default()
        },
        max_num_sentences: 1,
        silence_scale: 0.2,
        ..Default::default()
    };
    let mut temporary = None;
    match request.kind.as_str() {
        "kokoro" => {
            let source = fs::read_to_string(model.join("lexicon-zh.txt"))
                .map_err(|_| "Kokoro 中文词典不可读")?;
            let lexicon = pronunciation(&source)?;
            let override_file = request
                .output
                .with_file_name(format!("pronunciation-{}.txt", uuid::Uuid::new_v4()));
            fs::write(&override_file, lexicon).map_err(|_| "临时词典写入失败")?;
            config.model.kokoro = OfflineTtsKokoroModelConfig {
                model: file("model.onnx"),
                voices: file("voices.bin"),
                tokens: file("tokens.txt"),
                lexicon: Some(format!(
                    "{},{},{}",
                    override_file.to_string_lossy(),
                    model.join("lexicon-us-en.txt").to_string_lossy(),
                    model.join("lexicon-zh.txt").to_string_lossy()
                )),
                ..Default::default()
            };
            temporary = Some(override_file);
        }
        "zipvoice" => {
            config.model.zipvoice = OfflineTtsZipvoiceModelConfig {
                encoder: file("encoder.int8.onnx"),
                decoder: file("decoder.int8.onnx"),
                vocoder: file("vocos_24khz.onnx"),
                tokens: file("tokens.txt"),
                lexicon: Some(format!(
                    "{},{}",
                    model.join("lexicon.txt").to_string_lossy(),
                    model.join("lexicon-en-us.txt").to_string_lossy()
                )),
                feat_scale: 0.1,
                t_shift: 0.5,
                target_rms: 0.1,
                guidance_scale: 1.0,
                ..Default::default()
            };
        }
        _ => return Err("本地语音引擎无效".into()),
    }
    let engine = OfflineTts::create(&config);
    if let Some(file) = temporary {
        let _ = fs::remove_file(file);
    }
    let engine = engine.ok_or("本地模型初始化失败，请检查模型文件与运行库版本")?;
    Ok(Cached {
        key: (request.kind.clone(), model.clone()),
        engine,
    })
}
fn generate(request: Request, cache: &mut Option<Cached>) -> Result<(), String> {
    if request.text.trim().is_empty()
        || request.text.chars().count() > 200
        || request.text.contains('\0')
        || !request.model_dir.is_absolute()
        || !request.output.is_absolute()
        || !request.rate.is_finite()
        || !(0.5..=2.0).contains(&request.rate)
    {
        return Err("语音请求参数无效".into());
    }
    if request.kind == "zipvoice"
        && (request.reference_text.trim().is_empty() || !request.reference_path.is_absolute())
    {
        return Err("ZipVoice 需要参考音频和逐字对应的参考文本".into());
    }
    let key = (request.kind.clone(), request.model_dir.clone());
    if cache.as_ref().is_none_or(|c| c.key != key) {
        *cache = None;
        *cache = Some(load(&request)?);
    }
    let engine = &cache.as_ref().unwrap().engine;
    let mut generation = GenerationConfig {
        speed: request.rate,
        ..Default::default()
    };
    if request.kind == "zipvoice" {
        let reference = Wave::read(
            request
                .reference_path
                .to_str()
                .ok_or("参考音频路径编码无效")?,
        )
        .ok_or("参考音频读取失败，请使用单声道 PCM WAV 文件")?;
        if reference.samples().is_empty() || reference.sample_rate() < 16000 {
            return Err("参考音频须为非空的单声道 PCM WAV，采样率至少 16 kHz".into());
        }
        generation.reference_audio = Some(reference.samples().to_vec());
        generation.reference_sample_rate = reference.sample_rate();
        generation.reference_text = Some(request.reference_text);
        generation.num_steps = 4;
        generation.extra = Some(HashMap::from([("min_char_in_sentence".into(), json!(10))]));
    } else {
        let count = engine.num_speakers();
        if count <= 0 {
            return Err("Kokoro 模型没有可用音色".into());
        }
        generation.sid = request
            .profile
            .strip_prefix("kokoro:")
            .and_then(|s| s.parse::<i32>().ok())
            .filter(|n| *n >= 0 && *n < count)
            .unwrap_or_else(|| 3.min(count - 1));
    }
    let audio = engine
        .generate_with_config(&request.text, &generation, None::<fn(&[f32], f32) -> bool>)
        .ok_or("本地语音合成失败")?;
    if audio.samples().is_empty()
        || audio.sample_rate() <= 0
        || audio.samples().iter().any(|s| !s.is_finite())
    {
        return Err("本地引擎生成了无效音频".into());
    }
    if !audio.save(request.output.to_str().ok_or("输出音频路径编码无效")?) {
        return Err("合成音频保存失败".into());
    }
    Ok(())
}
fn read_line(input: &mut impl BufRead) -> io::Result<Option<Vec<u8>>> {
    let mut line = vec![];
    loop {
        let chunk = input.fill_buf()?;
        if chunk.is_empty() {
            return Ok((!line.is_empty()).then_some(line));
        }
        let newline = chunk.iter().position(|b| *b == b'\n');
        let length = newline.map(|n| n + 1).unwrap_or(chunk.len());
        if line.len() + length > 1024 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "语音请求超过大小上限",
            ));
        }
        line.extend_from_slice(&chunk[..length]);
        input.consume(length);
        if newline.is_some() {
            return Ok(Some(line));
        }
    }
}
fn run() -> io::Result<()> {
    let stdin = io::stdin();
    let mut input = stdin.lock();
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let mut cache = None;
    while let Some(line) = read_line(&mut input)? {
        let raw = serde_json::from_slice::<Value>(&line);
        let id = raw
            .as_ref()
            .ok()
            .and_then(|v| v.get("id"))
            .cloned()
            .unwrap_or(Value::Null);
        let result = if !id.is_u64() {
            Err("语音请求编号无效".into())
        } else {
            raw.map_err(|_| "语音请求 JSON 无效".to_owned())
                .and_then(|v| {
                    serde_json::from_value::<Request>(v).map_err(|_| "语音请求字段无效".into())
                })
                .and_then(|request| generate(request, &mut cache))
        };
        let response = match result {
            Ok(()) => json!({"id":id,"ok":true}),
            Err(error) => json!({"id":id,"ok":false,"error":error}),
        };
        writeln!(output, "{response}")?;
        output.flush()?;
    }
    Ok(())
}
fn main() {
    if run().is_err() {
        eprintln!("本地语音工作进程退出");
        std::process::exit(1);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pronunciation_keeps_unambiguous_development_terms_only() {
        let source = "崇 ch ong2\n构 g ou4\n新 x in1\n要 y ao4\n";
        let out = pronunciation(source).unwrap();
        assert!(out.contains("重构 ch ong2 g ou4"));
        assert!(out.contains("重新 ch ong2 x in1"));
        assert!(!out.contains("重要"));
        assert!(pronunciation("构 g ou4").is_err());
    }
    #[test]
    fn bounded_framing_and_invalid_requests_fail_before_inference() {
        let mut input = io::Cursor::new(b"{}\n".as_slice());
        assert_eq!(read_line(&mut input).unwrap().unwrap(), b"{}\n");
        assert!(read_line(&mut input).unwrap().is_none());
        let mut input = io::Cursor::new(vec![b'x'; 1024 * 1024 + 1]);
        assert!(read_line(&mut input).is_err());
        assert!(!std::path::Path::new("relative").is_absolute());
    }
}
