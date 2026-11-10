use super::{Cancellation, SpeakOptions, SpeakResult, audio, models::Models, native};
use crate::mcp;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
};

const MIMO_TTS_INSTRUCTION: &str = "请用平稳、清晰、自然流畅的普通话播报中文，语速适中。保留中英混合内容中的英文原词，并使用开发者熟悉的英文读法：Git 读作英文单词 git（短元音，类似 sit，不要逐字母读）；GitHub、GitLab 按英文名称读；git status、commit、push、branch、merge、pull request 等命令和术语按英文读。CodeX 读作 code ex；CLI、API、MCP 按英文字母逐个读；Node.js 读作 node dot J S。其他产品名、编程语言、协议、命令和缩写也按通行的技术英语读法处理。路径、文件名、代码和参数中的标点或数字不要逐符号展开，只读其中有意义的名称。不要把英文术语改成中文谐音，也不要添加原文没有的数字或内容。";

struct Worker {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    next_id: u64,
    last_used: Instant,
}
impl Worker {
    fn spawn(binary: &Path) -> Result<Self, String> {
        let mut cmd = Command::new(binary);
        #[cfg(windows)]
        cmd.creation_flags(0x08000000);
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "本地语音运行库无法启动，请重新安装应用")?;
        let input = child.stdin.take().ok_or("本地语音输入管道不可用")?;
        let output = BufReader::new(child.stdout.take().ok_or("本地语音输出管道不可用")?);
        Ok(Self {
            child,
            input,
            output,
            next_id: 1,
            last_used: Instant::now(),
        })
    }
    async fn stop(&mut self) {
        let _ = self.input.shutdown().await;
        let _ = self.child.kill().await;
    }
    async fn request(&mut self, mut body: Value) -> Result<(), String> {
        let id = self.next_id;
        self.next_id = self.next_id.wrapping_add(1);
        body["id"] = json!(id);
        self.input
            .write_all(format!("{body}\n").as_bytes())
            .await
            .map_err(|_| "本地语音输入管道已经退出")?;
        self.input
            .flush()
            .await
            .map_err(|_| "本地语音输入管道失败")?;
        let bytes = mcp::read_line(&mut self.output, 1024 * 1024)
            .await
            .map_err(|_| "本地语音输出无效")?
            .ok_or("本地语音工作进程提前退出")?;
        let value: Value =
            serde_json::from_slice(&bytes).map_err(|_| "本地语音工作进程输出非 JSON 消息")?;
        if value["id"] != id {
            return Err("本地语音响应编号不匹配".into());
        }
        if value["ok"] != true {
            return Err(value["error"].as_str().unwrap_or("本地语音合成失败").into());
        }
        self.last_used = Instant::now();
        Ok(())
    }
}
pub struct Backends {
    pub models: Arc<Models>,
    worker_binary: PathBuf,
    worker: Mutex<Option<Worker>>,
}
impl Backends {
    pub fn new(models: Arc<Models>, worker_binary: PathBuf) -> Self {
        Self {
            models,
            worker_binary,
            worker: Mutex::new(None),
        }
    }
    pub async fn release(&self) {
        if let Some(mut worker) = self.worker.lock().await.take() {
            worker.stop().await;
        }
    }
    pub async fn release_idle(&self) {
        let Ok(mut worker) = self.worker.try_lock() else {
            return;
        };
        if worker
            .as_ref()
            .is_some_and(|w| w.last_used.elapsed() >= Duration::from_secs(120))
            && let Some(mut old) = worker.take()
        {
            old.stop().await;
        }
    }
    pub async fn speak(
        &self,
        config: &Value,
        text: String,
        mut cancel: Cancellation,
    ) -> SpeakResult {
        let voice = &config["voice"];
        let options = SpeakOptions {
            text,
            voice_profile: voice["voiceProfile"]
                .as_str()
                .unwrap_or("system-default")
                .into(),
            rate: voice["rate"].as_f64().unwrap_or(1.0),
            volume: voice["volume"].as_f64().unwrap_or(0.8),
        };
        let backend = voice["backend"].as_str().unwrap_or("native");
        let result = match backend {
            "native" => native::speak(&options, cancel.clone()).await,
            "local" => self.local(config, &options, cancel.clone()).await,
            "cloud" => {
                let result = tokio::select! {_=cancel.wait()=>Err("播报已打断".into()),result=synthesize_cloud(config,&options.text)=>result};
                match result {
                    Ok(bytes) => match audio::Temporary::new() {
                        Ok(directory) => {
                            let file = directory.path.join("speech.wav");
                            match tokio::fs::write(&file, bytes).await {
                                Ok(()) => audio::play(&file, options.volume, cancel.clone()).await,
                                Err(_) => Err("云语音临时音频保存失败".into()),
                            }
                        }
                        Err(_) => Err("临时音频目录创建失败".into()),
                    },
                    Err(error) => Err(error),
                }
            }
            "piper" => Err("Piper 缺少模型和真实播放配置，请选择系统音色或本地语音".into()),
            _ => Err("播报后端无效".into()),
        };
        if cancel.cancelled() {
            return SpeakResult::failed("播报已打断");
        }
        match result {
            Ok(()) => SpeakResult {
                ok: true,
                used_backend: Some(backend.into()),
                errors: vec![],
            },
            Err(error) => SpeakResult::failed(format!("{backend}：{error}")),
        }
    }
    async fn local(
        &self,
        config: &Value,
        options: &SpeakOptions,
        mut cancel: Cancellation,
    ) -> Result<(), String> {
        let kind = if config["voice"]["localEngine"] == "zipvoice" {
            "zipvoice"
        } else {
            "kokoro"
        };
        if self.models.status(kind)["state"] != "ready" {
            return Err("本地模型尚未就绪，请先在设置中下载模型".into());
        }
        if kind == "zipvoice"
            && (config["voice"]["zipvoiceReferencePath"]
                .as_str()
                .unwrap_or_default()
                .is_empty()
                || config["voice"]["zipvoiceReferenceText"]
                    .as_str()
                    .unwrap_or_default()
                    .trim()
                    .is_empty())
        {
            return Err("ZipVoice 需要参考音频和逐字对应的参考文本".into());
        }
        if cancel.cancelled() {
            return Err("播报已打断".into());
        }
        let directory = audio::Temporary::new().map_err(|_| "临时音频目录创建失败")?;
        let file = directory.path.join("speech.wav");
        {
            let mut slot = self.worker.lock().await;
            if slot
                .as_mut()
                .is_some_and(|w| w.child.try_wait().is_ok_and(|s| s.is_some()))
            {
                slot.take();
            }
            if slot.is_none() {
                *slot = Some(Worker::spawn(&self.worker_binary)?);
            }
            let worker = slot.as_mut().unwrap();
            let request = json!({"kind":kind,"modelDir":self.models.directory(kind),"output":file,"text":options.text,"profile":options.voice_profile,"rate":options.rate,"referencePath":config["voice"]["zipvoiceReferencePath"],"referenceText":config["voice"]["zipvoiceReferenceText"]});
            let result = tokio::select! {_=cancel.wait()=>Err("播报已打断".into()),result=tokio::time::timeout(Duration::from_secs(120),worker.request(request))=>result.unwrap_or_else(|_|Err("本地语音合成超时（120 秒）".into()))};
            if let Err(error) = result {
                if let Some(mut old) = slot.take() {
                    old.stop().await;
                }
                return Err(error);
            }
        }
        if cancel.cancelled() {
            return Err("播报已打断".into());
        }
        let bytes = tokio::fs::read(&file)
            .await
            .map_err(|_| "本地语音未生成音频文件")?;
        if !audio::has_wav_speech(&bytes) {
            return Err("本地引擎未生成有效语音音频".into());
        }
        audio::play(&file, options.volume, cancel).await
    }
}
pub async fn synthesize_cloud(config: &Value, text: &str) -> Result<Vec<u8>, String> {
    let voice = &config["voice"];
    if voice["backend"] != "cloud" || voice["cloudEnabled"] != true {
        return Err("云 TTS 未开启".into());
    }
    let key = voice["cloudApiKey"].as_str().unwrap_or_default().trim();
    if key.is_empty() {
        return Err("云 TTS 未填写 API Key".into());
    }
    let endpoint = reqwest::Url::parse(voice["cloudEndpoint"].as_str().unwrap_or_default())
        .map_err(|_| "云 TTS 接口地址无效")?;
    if !["https", "http"].contains(&endpoint.scheme()) {
        return Err("云 TTS 地址须使用 http 或 https".into());
    }
    let model = voice["cloudModel"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("mimo-v2.5-tts");
    let profile = voice["cloudVoice"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("mimo_default");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|_| "云 TTS 请求通道不可用")?;
    let mut response=client.post(endpoint).bearer_auth(key).json(&json!({"model":model,"messages":[{"role":"user","content":MIMO_TTS_INSTRUCTION},{"role":"assistant","content":text}],"audio":{"format":"wav","voice":profile},"stream":false})).send().await.map_err(|_|"云 TTS 请求失败或超时（30 秒）")?;
    if !response.status().is_success() {
        return Err(format!(
            "云 TTS 请求失败：HTTP {}{}",
            response.status().as_u16(),
            if response.status().as_u16() == 404 {
                "，请确认接口地址指向 …/v1/chat/completions"
            } else {
                ""
            }
        ));
    }
    let mut bytes = vec![];
    while let Some(chunk) = response.chunk().await.map_err(|_| "云 TTS 响应读取失败")? {
        if bytes.len() + chunk.len() > 64 * 1024 * 1024 {
            return Err("云 TTS 响应超过大小上限".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let body: Value = serde_json::from_slice(&bytes).map_err(|_| "云 TTS 返回了无效 JSON")?;
    let data = body["choices"]
        .as_array()
        .and_then(|a| {
            a.iter()
                .find_map(|v| v["message"]["audio"]["data"].as_str())
        })
        .ok_or("云 TTS 响应缺少音频数据")?;
    let audio = STANDARD
        .decode(data)
        .map_err(|_| "云 TTS 返回了无效音频编码")?;
    if !audio::has_wav_speech(&audio) {
        return Err("云 TTS 未返回有效 WAV 语音，请检查模型与 format 参数".into());
    }
    Ok(audio)
}
