#[cfg(unix)]
use agentcue_runtime::voice::Cancellation;
use agentcue_runtime::voice::{audio, native};
fn wave(format: u16, bits: u16, samples: &[u8]) -> Vec<u8> {
    let mut data = vec![];
    data.extend_from_slice(b"RIFF");
    data.extend_from_slice(
        &(36_u32 + samples.len() as u32 + (samples.len() % 2) as u32).to_le_bytes(),
    );
    data.extend_from_slice(b"WAVEfmt ");
    data.extend_from_slice(&16_u32.to_le_bytes());
    data.extend_from_slice(&format.to_le_bytes());
    data.extend_from_slice(&1_u16.to_le_bytes());
    data.extend_from_slice(&24000_u32.to_le_bytes());
    data.extend_from_slice(&(24000_u32 * (bits as u32 / 8)).to_le_bytes());
    data.extend_from_slice(&(bits / 8).to_le_bytes());
    data.extend_from_slice(&bits.to_le_bytes());
    data.extend_from_slice(b"data");
    data.extend_from_slice(&(samples.len() as u32).to_le_bytes());
    data.extend_from_slice(samples);
    if !samples.len().is_multiple_of(2) {
        data.push(0);
    }
    data
}
#[test]
fn pcm_and_float_volume_preserve_format_and_js_rounding() {
    let values = [1000_i16, -1000, 1, -1];
    let pcm = wave(
        1,
        16,
        &values
            .iter()
            .flat_map(|n| n.to_le_bytes())
            .collect::<Vec<_>>(),
    );
    let half = audio::scale_wav(&pcm, 0.5).unwrap();
    let actual: Vec<i16> = half[44..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|s| i16::from_le_bytes(*s))
        .collect();
    assert_eq!(actual, vec![500, -500, 1, 0]);
    assert_eq!(&half[..44], &pcm[..44]);
    assert!(audio::has_wav_speech(&pcm));
    assert!(!audio::has_wav_speech(
        &audio::scale_wav(&pcm, 0.0).unwrap()
    ));
    let float = wave(3, 64, &0.8_f64.to_le_bytes());
    let half = audio::scale_wav(&float, 0.5).unwrap();
    assert_eq!(f64::from_le_bytes(half[44..52].try_into().unwrap()), 0.4);
    assert!(!audio::has_wav_speech(&wave(1, 8, &[128, 128])));
}
#[test]
fn malformed_or_nonfinite_audio_and_out_of_range_gain_are_errors() {
    let data = wave(1, 16, &1000_i16.to_le_bytes());
    for gain in [-0.1, 1.1, f64::NAN] {
        assert!(audio::scale_wav(&data, gain).is_err());
    }
    assert!(audio::scale_wav(&data[..data.len() - 1], 0.5).is_err());
    assert!(audio::scale_wav(&wave(3, 32, &f32::NAN.to_le_bytes()), 0.5).is_err());
    assert!(!audio::has_aiff_speech(b"FORM empty"));
    let mut bad = data;
    bad[32] = 3;
    assert!(audio::scale_wav(&bad, 0.5).is_err());
}
#[test]
fn chinese_voice_allowlist_filters_problematic_languages_and_preserves_manual_english() {
    let voices = native::parse_voices(
        "Grandma zh_CN # 示例\nSinji zh_HK # 示例\nShelley zh_CN # 示例\nShelley zh_TW # 示例\nSamantha en_US # Hello\nSinji zh_HK # 重复",
    );
    assert_eq!(voices.len(), 3);
    assert_eq!(voices[0].id, "Shelley");
    assert_eq!(voices[1].id, "Sinji");
    assert_eq!(voices[2].id, "Samantha");
}
#[cfg(unix)]
#[tokio::test]
async fn native_command_cancellation_reaps_the_process_before_returning() {
    let (cancel, receiver) = tokio::sync::watch::channel(0);
    let cancellation = Cancellation {
        receiver,
        generation: 0,
    };
    let command = tokio::process::Command::new("/bin/sleep");
    let mut command = command;
    command.arg("60");
    let task = tokio::spawn(audio::command(
        command,
        None,
        0,
        cancellation,
        std::time::Duration::from_secs(30),
    ));
    tokio::task::yield_now().await;
    cancel.send(1).unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(result.unwrap_err(), "播报已打断");
}
