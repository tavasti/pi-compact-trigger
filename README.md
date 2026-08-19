# pi-compact-trigger

**This is coded after misconfiguring and misunderstanding how pi compation works. Only valid use for this expansion is if you want to have different headroom for some models.**


Headroom-based compaction trigger for [Pi](https://github.com/earendil-works/pi-coding-agent), designed to work with the [blackhole](https://github.com/tavasti/pi-blackhole) VCC compaction engine.

Blackhole uses a single static token threshold to decide when to compact. That works fine with one model, but breaks when you switch between models with different context sizes — a threshold that's safe for 84k context triggers way too early for 256k context. 

This plugin replaces the static threshold with a headroom-based approach:

```
trigger when: usedTokens > contextWindow - headroomTokens
```

One setting (`headroomTokens: 20000`) scales automatically to any model.


## Configuration

Edit `extensions/compact-trigger/config.json`:

```json
{
  "headroomTokens": 20000,
  "models": {}
}
```

Per-model overrides use glob patterns:

```json
{
  "headroomTokens": 20000,
  "models": {
    "Qwen3.6*": 25000
  }
}
```

## Notification

After compaction, Pi shows in footer statistics like:

```
compact: 3x, max 75922 / avg 68000 of 84500
```

## How it works

This extension handles the **trigger** — when to compact. Blackhole handles the **engine** — how to compact (VCC summaries).

At `turn_end`, the plugin checks `usage.totalTokens` against `contextWindow - headroomTokens`. When the threshold is crossed, it inflates the token count so Pi's internal `shouldCompact()` fires. Blackhole then intercepts and produces the VCC summary.

Without blackhole, compaction still fires but uses Pi's default LLM summary instead — Pi natively has headroom-based compaction, so not much difference.

## Requirements

- Pi `@earendil-works/pi-coding-agent` ^0.74.0
- `compaction.enabled: true` in `settings.json`
- [blackhole extension](https://github.com/tavasti/pi-blackhole) for VCC summaries (recommended)
  — This plugin has not been tested without blackhole.

## License

MIT

## About

Fully AI-coded with [Qwen3.6-27B](https://huggingface.co/unsloth/Qwen3.6-27B).
