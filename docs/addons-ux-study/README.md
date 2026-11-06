# Add-ons UX study

A click-through for installing the stack's optional services from Boundary: Services → Add-ons lists them, an add-on's page says whether it fits this Mac, what it runs and what it needs from the user, and the install screen shows each step through to the assistant restart. The stack work it needs is [change request 0020](../change-requests/0020-ui-installable-addons.md).

| File | Role |
| --- | --- |
| [spec.md](spec.md) | Living spec: decisions, phases and acceptance criteria |
| [prototype.html](prototype.html) | Click-through, plus a tab on update policy and the change request items |

Open `prototype.html` in a browser. The controls along the top set how full this Mac is (room to spare, tight, won't fit), whether the install fails during first-time setup, whether an agent task is running at restart time, and the theme.

Engine memory (12 GiB) and disk (100 GiB) are Boundary's Podman machine defaults. Twenty's figures come from the stack's replies to 0020; the Local models and Signal figures are placeholders. The decisions the mock shows are in [spec.md](spec.md).
