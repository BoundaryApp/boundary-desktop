/**
 * The screens a release note's screenshot can show (ADR 0059). A scene's key is the `image` a
 * slide or guide step names, so content needs no extra field.
 *
 * Each scene opens a destination in the screenshot harness (scripts/ui-screenshot/harness.tsx),
 * with `query` added to the page's URL when it has one (`chat=chat-grant`), runs its steps, and names the anchors its callouts may point at. Anchors are
 * `data-guide-anchor` attributes in the app's own components.
 *
 * Scenes that would show a private experiment live beside that experiment, not here; this file
 * ships in the public repository.
 *
 * A step is one of:
 *   { click: '<anchor>' }      click the element with that anchor
 *   { clickText: '<text>' }    click the first element whose text is exactly that
 *   { clickLabel: '<label>' }  click the first element with that accessible name
 *   { press: '<key>' }         press a key, as Playwright names it (ArrowDown, Escape)
 *   { scrollText: '<text>' }   scroll the first element whose text is exactly that into view
 *   { hover: '<anchor>' }      move the pointer onto it
 *   { wait: <ms> }             let something settle
 */
export const SCENES = {
  'rail-tour': {
    view: 'chat',
    anchors: ['rail-chat', 'rail-services', 'rail-whats-new', 'rail-settings'],
  },
  'services-home': {
    view: 'services',
    anchors: ['rail-services'],
  },
  'whats-new-page': {
    view: 'whats-new',
    anchors: ['rail-whats-new'],
  },
  'addon-store': {
    view: 'services',
    anchors: ['addon-search'],
    steps: [{ click: 'addon-store' }, { wait: 400 }],
  },
  'writing-voices': {
    view: 'settings',
    anchors: ['settings-writing-voices'],
    steps: [{ click: 'settings-writing-voices' }, { wait: 500 }],
  },
  // The harness's Garden club opens on General, with reactions, an @Ada and an @channel.
  'circle-reactions': { view: 'circles', anchors: ['circle-reactions'] },
};

/** Scenes a content folder may add of its own, merged over the ones above. */
export function withExtraScenes(extra) {
  return { ...SCENES, ...extra };
}
