// Shared review controls for the message-actions study kit.
// Pages call study.init({ render }) and mark state buttons with data-state-go / data-variant-go.
// [data-show="a b"] is visible only in states a or b; [data-v="x y"] only in variants x or y.
(() => {
  const params = new URLSearchParams(location.search);
  const root = document.documentElement;
  if (params.has("embed")) root.classList.add("embed");

  const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* private window */ } };

  let render = () => {};

  const gate = () => {
    const { state, variant } = document.body.dataset;
    document.querySelectorAll("[data-show]").forEach((el) => {
      el.hidden = !el.dataset.show.split(" ").includes(state);
    });
    document.querySelectorAll("[data-v]").forEach((el) => {
      if (!el.dataset.v.split(" ").includes(variant)) el.hidden = true;
      else if (!el.dataset.show) el.hidden = false;
    });
    document.querySelectorAll("[data-state-go]").forEach((b) => b.classList.toggle("is-on", b.dataset.stateGo === state));
    document.querySelectorAll("[data-variant-go]").forEach((b) => b.classList.toggle("is-on", b.dataset.variantGo === variant));
  };

  const apply = ({ state, variant } = {}) => {
    if (state) document.body.dataset.state = state;
    if (variant) document.body.dataset.variant = variant;
    render();
    gate();
  };

  const init = (opts = {}) => {
    render = opts.render || render;

    const themeBox = document.getElementById("theme");
    const light = params.get("theme") === "light"
      || (params.get("theme") !== "dark" && safeGet("boundary-chat-theme") === "light");
    root.classList.toggle("light", light);
    if (themeBox) {
      themeBox.checked = light;
      themeBox.addEventListener("change", () => {
        root.classList.toggle("light", themeBox.checked);
        safeSet("boundary-chat-theme", themeBox.checked ? "light" : "dark");
      });
    }
    document.getElementById("notes")?.addEventListener("change", (e) => {
      root.classList.toggle("notes-on", e.target.checked);
    });

    document.addEventListener("click", (e) => {
      const s = e.target.closest("[data-state-go]");
      if (s) apply({ state: s.dataset.stateGo });
      const v = e.target.closest("[data-variant-go]");
      if (v) apply({ variant: v.dataset.variantGo });
    });

    apply({ state: params.get("state") || undefined, variant: params.get("variant") || undefined });
  };

  window.study = { init, apply };
})();
