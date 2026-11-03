# Circle chats UX study

| File | Role |
| --- | --- |
| [spec.md](spec.md) | Living spec, acceptance criteria and phase progress |
| [prototype.html](prototype.html) | Click-through in the Workbench chat frame. The bar above the frame picks a scene, admin or member, and the theme; `?start=` opens a scene: `chat`, `switch`, `mac`, `channels`, `noadmin`, `fresh`, `agent`, `share`, `manage`, `person`, `join`, `inference`, `joincall`, `call`, `ring`, `narrow`. |

People, messages and models in the prototype are made up. Confirmation takes about four seconds there; a real Circle can take up to a minute. The Workbench chat shows one place at a time: This Mac, with projects, Hermes chats, channels and DMs ([chat types](../chat-types-ux-study/README.md)), or one Circle, with its channels and people. There is no Circles screen: the `manage`, `person` and `join` scenes show where its membership parts go, and `inference` where its model sharing and trust go ([ADR 0043](../adr/0043-circles-live-in-the-chat.md)). The `agent` scene shows a later release, not phase 5. Storage and privacy decisions are in [ADR 0042](../adr/0042-circle-chats.md). The `joincall`, `call` and `ring` scenes belong to the [Circle calls spec](../circle-calls-ux-study/spec.md).
