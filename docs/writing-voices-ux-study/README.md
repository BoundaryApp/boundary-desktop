# Writing voices UX study

| File | Role |
| --- | --- |
| [spec.md](spec.md) | Living spec: flows, decisions, acceptance criteria and phase progress |
| [prototype.html](prototype.html) | Click-through in the Workbench frame. The bar picks a scene and the theme; `?start=` opens a scene: `voices`, `create`, `calibrating`, `card`, `agent`, `slash`, `chip`, `kept`, `delete`. In `slash`, arrows move, Enter picks for the message and Tab keeps the voice for the chat. |

Agents, voices, samples and numbers in the prototype are made up. Calibration takes about five seconds there; a real one depends on the model and the number of samples. Storage, the two agent settings and how each voice reaches Hermes are in [ADR 0056](../adr/0056-writing-voices.md).
