# CosyVoice3 Local Setup (macOS arm64)

This file documents the exact local setup validated in this workspace to run:
- model: `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`
- task: zero-shot voice cloning from a prompt audio

## 1) Environment

```bash
brew install python@3.10
cd CosyVoice
git submodule update --init --recursive
/opt/homebrew/bin/python3.10 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip "setuptools<81" wheel
pip install --no-build-isolation -r requirements.macos.inference.txt
```

## 2) Download the model

```bash
cd CosyVoice
source .venv/bin/activate
python - << 'PY'
from huggingface_hub import snapshot_download
snapshot_download(
    "FunAudioLLM/Fun-CosyVoice3-0.5B-2512",
    local_dir="pretrained_models/Fun-CosyVoice3-0.5B",
)
PY
```

## 3) Run voice cloning (zero-shot)

```bash
cd CosyVoice
source .venv/bin/activate
python tools/run_zero_shot_local.py \
  --text "Bonjour, ceci est un test local de clonage de voix avec CosyVoice trois." \
  --prompt-wav asset/zero_shot_prompt.wav \
  --prompt-text "希望你以后能够做的比我还好呦。" \
  --output outputs/test_zero_shot.wav
```

## 4) Use your own prompt audio

Requirements for best quality:
- clean speech, 3-10 seconds
- close-mic recording, low background noise
- exact transcript passed in `--prompt-text`

Example:

```bash
python tools/run_zero_shot_local.py \
  --text "Texte a synthetiser." \
  --prompt-wav /absolute/path/to/your_prompt.wav \
  --prompt-text "Exact transcript of your prompt audio." \
  --output outputs/your_clone.wav
```

## 5) API + frontend

For full API + single-page frontend stack, see:

- `README_API.md`
- `/Users/usernamap/Documents/dev_pers/t/frontend/README.md`
