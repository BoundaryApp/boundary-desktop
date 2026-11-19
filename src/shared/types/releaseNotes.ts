/**
 * What's new content: one entry per release, bundled with the build (ADR 0059). A build with no
 * content bundled has no release notes, and every surface that reads them stays off.
 */

/** One feature in a release: a slide in the popup, a block on the What's new page. */
export interface ReleaseSlide {
  title: string;
  /** One or two sentences. */
  body: string;
  /** A screenshot beside `release.json`, without its extension. A slide can ship without one. */
  image?: string;
  /** An anchor in the screenshot's sidecar, ringed to point the feature out. */
  anchor?: string;
  /** A guide this feature links to. */
  guide?: string;
}

/** One step of a guide: a screenshot and the parts of it the step talks about. */
export interface GuideStep {
  title: string;
  image: string;
  callouts: { anchor: string; text: string }[];
}

export interface Guide {
  id: string;
  title: string;
  /** Roughly how long the walkthrough takes. */
  minutes: number;
  steps: GuideStep[];
}

export interface Release {
  version: string;
  /** As people read it, e.g. `Nov 13`. */
  date: string;
  slides: ReleaseSlide[];
  /** Guides worth listing that no slide links to. */
  guides: string[];
}

/**
 * Where a screenshot's named elements sat when it was taken, as fractions of the image with the
 * origin at its top left. Markers and rings are drawn from these, so they stay right at any size.
 */
export interface AnchorBoxes {
  [anchor: string]: { x: number; y: number; w: number; h: number };
}
