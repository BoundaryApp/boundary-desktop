# Add-on store UX study

A click-through for browsing add-ons the way an app store does: a Discover page with a featured add-on and shelves, categories, search that also finds what Boundary already runs, and a mark on every add-on that is installed, installing, waiting for a restart or not running. It replaces the single list on Services → Add-ons from the [add-ons study](../addons-ux-study/README.md) and keeps that study's fit check, install steps, restart bar and Turn off rules.

| File | Role |
| --- | --- |
| [spec.md](spec.md) | Living spec: decisions, phases and acceptance criteria |
| [prototype.html](prototype.html) | Click-through. The bar above the frame sets the catalog size, whether anything is installed yet, how full the container engine is, and the theme. `?start=` opens a scene: `search`, `detail`, `installing`, `installed`, `full`; add `catalog=grown` for the larger catalog. |

**Today’s 6** is the catalog the stack can offer soon: Twenty, Tasks, Local models and Signal from the add-ons spec, plus n8n and LightRAG, which ship with Boundary and are off until turned on. **Grown, 15** adds nine example entries, marked **Example**, to show how shelves and categories hold up; none of them is planned. Sizes for the examples are placeholders. The person, Circle and CRM records in the prototype are made up.
