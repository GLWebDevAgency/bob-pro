# Bob Live private Whisper auditor

This service is the independent acoustic auditor for Bob Live. It is not a
general-purpose transcription API.

Production invariants:

- Railway service name: `bob-live-whisper-audit`;
- private networking only; no public domain or TCP proxy;
- the only secret is `BOB_LIVE_LOCAL_AUDIT_TOKEN`;
- no OpenAI, Mistral, Supabase, database or Storage credentials;
- immutable `whisper.cpp` and model digests from `manifest.json`;
- one active inference and two queued requests per replica;
- WAV-only French transcription; no runtime model reload or media conversion;
- no audio or transcript logging/persistence.

The public container listener exposes only:

- `GET /v1/health`;
- `POST /v1/audio/transcriptions` with an exact bearer token.

The upstream `whisper-server` listens only on loopback inside this isolated
container. The Node gateway validates and rebuilds every multipart request
before forwarding it, blocks upstream redirects, and supervises the child
process.

Local contract tests:

```sh
node --test infra/whisper-audit/server.test.mjs
```

The image build itself is part of the release proof because it downloads the
pinned source and model and verifies both SHA-256 digests before compilation.

Railway staging must configure this service with:

- config file `/railway.whisper-audit.json`;
- automatic deploy disabled (the release workflow deploys the exact candidate SHA);
- exactly one user-defined variable: `BOB_LIVE_LOCAL_AUDIT_TOKEN`;
- GitHub staging variable `RAILWAY_WHISPER_AUDIT_SERVICE_ID`;
- no Railway service domain, custom domain, TCP proxy or persistent volume.

The `AgentMission M1-B Staging Certification` workflow proves those invariants
through Railway's API, deploys this service before the API candidate, and only
accepts API readiness after the real OpenAI TTS → private Whisper round-trip.
