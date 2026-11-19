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
 *   { click: '<anchor>' }   click the element with that anchor
 *   { hover: '<anchor>' }   move the pointer onto it
 *   { wait: <ms> }          let something settle
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
};

/** Scenes a content folder may add of its own, merged over the ones above. */
export function withExtraScenes(extra) {
  return { ...SCENES, ...extra };
}
