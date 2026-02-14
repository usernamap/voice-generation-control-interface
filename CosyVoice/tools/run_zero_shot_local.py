#!/usr/bin/env python3

import argparse
import os
import sys
from pathlib import Path

import torch
import torchaudio

os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))
sys.path.append(str(REPO_ROOT / "third_party" / "Matcha-TTS"))
from cosyvoice.cli.cosyvoice import AutoModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run local CosyVoice3 zero-shot voice cloning from an audio prompt."
    )
    parser.add_argument(
        "--model-dir",
        default="pretrained_models/Fun-CosyVoice3-0.5B",
        help="Path to the local Fun-CosyVoice3 model directory.",
    )
    parser.add_argument(
        "--text",
        required=True,
        help="Target text to synthesize.",
    )
    parser.add_argument(
        "--prompt-wav",
        required=True,
        help="Reference audio file used for voice cloning.",
    )
    parser.add_argument(
        "--prompt-text",
        required=True,
        help="Transcript of the reference audio.",
    )
    parser.add_argument(
        "--instruction",
        default="You are a helpful assistant.",
        help="Instruction prefix. '<|endofprompt|>' is appended automatically if missing.",
    )
    parser.add_argument(
        "--output",
        default="outputs/zero_shot.wav",
        help="Output wav path.",
    )
    parser.add_argument(
        "--stream",
        action="store_true",
        help="Enable stream mode and merge generated chunks into one wav.",
    )
    return parser.parse_args()


def build_prompt(instruction: str, prompt_text: str) -> str:
    normalized = instruction.strip()
    if "<|endofprompt|>" not in normalized:
        normalized = f"{normalized}<|endofprompt|>"
    return f"{normalized}{prompt_text}"


def main() -> None:
    args = parse_args()

    if not os.path.exists(args.prompt_wav):
        raise FileNotFoundError(f"Prompt audio not found: {args.prompt_wav}")
    if not os.path.isdir(args.model_dir):
        raise FileNotFoundError(f"Model directory not found: {args.model_dir}")

    prompt = build_prompt(args.instruction, args.prompt_text)
    model = AutoModel(model_dir=args.model_dir)

    chunks = []
    for output in model.inference_zero_shot(
        args.text,
        prompt,
        args.prompt_wav,
        stream=args.stream,
    ):
        chunks.append(output["tts_speech"])

    if not chunks:
        raise RuntimeError("No audio generated.")

    merged = torch.cat(chunks, dim=1) if len(chunks) > 1 else chunks[0]
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    torchaudio.save(str(output_path), merged, model.sample_rate)
    print(f"Saved: {output_path} (sample_rate={model.sample_rate}, chunks={len(chunks)})")


if __name__ == "__main__":
    main()
