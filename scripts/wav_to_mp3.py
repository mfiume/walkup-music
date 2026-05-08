#!/usr/bin/env python3
"""Encode every WAV in walkups-clean/ to MP3 at 192 kbps using libmp3lame."""
import glob
import os
import struct
import wave

import lameenc

SRC = "/Users/mfiume/Development/walkup-music/audio/simple/walkups-clean"
DST = "/Users/mfiume/Development/walkup-music/audio/simple/walkups-clean"  # same dir


def encode(in_path: str, out_path: str, bitrate_kbps: int = 192) -> None:
    with wave.open(in_path, "rb") as w:
        n_ch = w.getnchannels()
        rate = w.getframerate()
        sampwidth = w.getsampwidth()
        n_frames = w.getnframes()
        pcm = w.readframes(n_frames)

    if sampwidth != 2:
        raise RuntimeError(f"{in_path}: expected 16-bit PCM, got {sampwidth*8}-bit")

    enc = lameenc.Encoder()
    enc.set_bit_rate(bitrate_kbps)
    enc.set_in_sample_rate(rate)
    enc.set_channels(n_ch)
    enc.set_quality(2)  # 2 = high (0=highest/slowest, 9=lowest)
    mp3 = enc.encode(pcm)
    mp3 += enc.flush()

    with open(out_path, "wb") as f:
        f.write(mp3)


def main() -> None:
    wavs = sorted(glob.glob(os.path.join(SRC, "*.wav")))
    if not wavs:
        print(f"No WAVs in {SRC}")
        return
    for w in wavs:
        out = os.path.join(DST, os.path.splitext(os.path.basename(w))[0] + ".mp3")
        encode(w, out)
        in_size = os.path.getsize(w)
        out_size = os.path.getsize(out)
        print(f"  ✓ {os.path.basename(w)} ({in_size//1024}KB) → {os.path.basename(out)} ({out_size//1024}KB)")


if __name__ == "__main__":
    main()
