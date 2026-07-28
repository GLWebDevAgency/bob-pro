# Bob Live Whisper audit — third-party notices

This image embeds the following immutable third-party assets:

- `ggml-org/whisper.cpp` `v1.9.1`, licensed under the MIT License.
  Source: <https://github.com/ggml-org/whisper.cpp/tree/v1.9.1>
- `ggml-large-v3-turbo-q5_0.bin`, a quantized conversion of OpenAI Whisper
  `large-v3-turbo`, distributed by the `ggerganov/whisper.cpp` model repository.
  Pinned revision and cryptographic digests are recorded in `manifest.json`.
  The underlying OpenAI Whisper model is licensed under the MIT License,
  Copyright (c) 2022 OpenAI.

The complete upstream MIT licenses are redistributed in this image as
`LICENSE.whisper.cpp` and `LICENSE.openai-whisper`.

Bob Pro does not modify or redistribute user audio as a model asset. Runtime
audio and transcripts are processed in memory and are not retained by this
service.
