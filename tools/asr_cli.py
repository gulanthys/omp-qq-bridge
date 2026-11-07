#!/usr/bin/env python3
"""把一段 WAV 转成文字：可选的 SenseVoice / sherpa-onnx 本地接入。

给 omp-qq-bridge 的语音转写使用；插件只负责将音频交给指定命令。
脚本依赖和模型需自行准备，也可以替换为同样读取 {file}、
向 stdout 输出文字的其他转写程序。

用法：
    在语音转写命令中填写：
    "<你的 python.exe>" "<这个脚本的绝对路径>" "{file}"

要准备的东西（三样，缺一不可）：
    pip install sherpa-onnx numpy soundfile
    模型：SenseVoice int8（model.int8.onnx + tokens.txt），放到 --模型目录 里，或者用环境变量 ASR_MODEL_DIR

退出码 / 输出约定：
    成功 → stdout 打印一行文字（插件把它当成转写结果）
    失败 → 非 0 退出码，诊断写到 stderr；桥接显示通用失败提示
"""
import argparse
import os
import sys
import wave


def read_wav(file_path: str):
    with wave.open(file_path, "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frame_count = wav_file.getnframes()
        data = wav_file.readframes(frame_count)
    if sample_width != 2:
        raise SystemExit(
            "只吃 16-bit PCM 的 wav（这条是 %d bit）—— 先用 ffmpeg 转一下"
            % (sample_width * 8)
        )
    import numpy as np

    samples = np.frombuffer(data, dtype=np.int16).astype("float32") / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if sample_rate != 16000:
        output_length = int(len(samples) * 16000 / sample_rate)
        positions = np.linspace(0.0, len(samples) - 1, output_length)
        samples = np.interp(positions, np.arange(len(samples)), samples).astype("float32")
    return samples


def find_model(directory: str):
    model_path = os.path.join(directory, "model.int8.onnx")
    tokens_path = os.path.join(directory, "tokens.txt")
    if not (os.path.exists(model_path) and os.path.exists(tokens_path)):
        raise SystemExit("模型目录里缺 model.int8.onnx / tokens.txt：%s" % directory)
    return model_path, tokens_path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("file", help="要转写的 wav 路径")
    parser.add_argument("--模型目录", dest="model_dir", default=os.environ.get("ASR_MODEL_DIR", ""))
    parser.add_argument("--线程", dest="threads", type=int, default=4)
    args = parser.parse_args()

    if not os.path.exists(args.file):
        raise SystemExit("找不到音频文件：%s" % args.file)
    if not args.model_dir:
        raise SystemExit("没给模型目录（--模型目录 或 环境变量 ASR_MODEL_DIR）")

    model, tokens = find_model(args.model_dir)
    import sherpa_onnx

    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=model,
        tokens=tokens,
        num_threads=args.threads,
        use_itn=True,
    )
    samples = read_wav(args.file)
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    text = (stream.result.text or "").strip()
    sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
