/**
 * The release notes bundled with this build. `@release-notes` is an alias: the content folder a
 * build was pointed at, or an empty one. Nothing here touches React or IPC.
 *
 * An owner is what a screenshot belongs to: a version (`0.0.1-rc.11`) or a guide
 * (`guides/reactions`).
 */
import type { AnchorBoxes, Guide, Release, ReleaseSlide } from '../../../shared/types/releaseNotes';

/** The glob results, as the content folder holds them. Split out so it can be built in tests. */
export interface ContentSources {
  releases: { version: string; date: string }[];
  /** Keyed by version. */
  details: Record<string, { slides: ReleaseSlide[]; guides?: string[] }>;
  /** Keyed by guide id. */
  guides: Record<string, Omit<Guide, 'id'>>;
  /** Keyed by `<owner>/<image>`. */
  images: Record<string, string>;
  /** Keyed by `<owner>/<image>`. */
  boxes: Record<string, AnchorBoxes>;
}

export interface Content {
  /** Newest first, in `releases.json` order. */
  releases: Release[];
  guide(id: string): Guide | null;
  imageUrl(owner: string, image: string | undefined): string | null;
  anchorBoxes(owner: string, image: string | undefined): AnchorBoxes;
}

export function buildContent(sources: ContentSources): Content {
  const releases = sources.releases.flatMap<Release>(({ version, date }) => {
    const detail = sources.details[version];
    return detail ? [{ version, date, slides: detail.slides ?? [], guides: detail.guides ?? [] }] : [];
  });
  return {
    releases,
    guide: (id) => {
      const found = sources.guides[id];
      return found ? { id, ...found } : null;
    },
    imageUrl: (owner, image) => (image ? (sources.images[`${owner}/${image}`] ?? null) : null),
    anchorBoxes: (owner, image) => (image ? (sources.boxes[`${owner}/${image}`] ?? {}) : {}),
  };
}

/** `…/0.0.1-rc.11/one.png` → `0.0.1-rc.11/one`; `…/guides/reactions/hover.png` → `guides/reactions/hover`. */
function contentKey(path: string): string {
  const parts = path.split('/');
  const file = parts[parts.length - 1].replace(/\.[^.]+$/, '');
  const owner = parts[parts.length - 3] === 'guides' ? `guides/${parts[parts.length - 2]}` : parts[parts.length - 2];
  return `${owner}/${file}`;
}

/** The folder a `<name>.json` or `<name>/release.json` sits in. */
function folderOf(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 2];
}

const DESCRIPTORS = new Set(['releases.json', 'release.json', 'guide.json']);

function fromGlobs(): ContentSources {
  const listed = import.meta.glob<{ version: string; date: string }[]>('@release-notes/releases.json', {
    eager: true,
    import: 'default',
  });
  const details = import.meta.glob<{ slides: ReleaseSlide[]; guides?: string[] }>(
    '@release-notes/*/release.json',
    { eager: true, import: 'default' }
  );
  const guides = import.meta.glob<Omit<Guide, 'id'>>('@release-notes/guides/*/guide.json', {
    eager: true,
    import: 'default',
  });
  const images = import.meta.glob<string>('@release-notes/**/*.png', {
    eager: true,
    import: 'default',
    query: '?url',
  });
  const sidecars = import.meta.glob<AnchorBoxes>('@release-notes/**/*.json', { eager: true, import: 'default' });

  const sources: ContentSources = { releases: [], details: {}, guides: {}, images: {}, boxes: {} };
  for (const value of Object.values(listed)) sources.releases = value ?? [];
  for (const [path, value] of Object.entries(details)) sources.details[folderOf(path)] = value;
  for (const [path, value] of Object.entries(guides)) sources.guides[folderOf(path)] = value;
  for (const [path, value] of Object.entries(images)) sources.images[contentKey(path)] = value;
  for (const [path, value] of Object.entries(sidecars)) {
    if (DESCRIPTORS.has(path.split('/').pop() ?? '')) continue;
    sources.boxes[contentKey(path)] = value;
  }
  return sources;
}

const bundled = buildContent(fromGlobs());

export const loadReleases = (): Release[] => bundled.releases;
export const loadGuide = (id: string): Guide | null => bundled.guide(id);
export const imageUrl = (owner: string, image: string | undefined): string | null =>
  bundled.imageUrl(owner, image);
export const anchorBoxes = (owner: string, image: string | undefined): AnchorBoxes =>
  bundled.anchorBoxes(owner, image);
