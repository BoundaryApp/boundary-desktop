import { CORE_SCHEMA, YAMLException, loadAll, mergeTag } from 'js-yaml';

/** YAML 1.2 core plus `<<` merge keys, which compose files and hand-edited configs use. */
const SCHEMA = CORE_SCHEMA.withTags(mergeTag);

/**
 * Parse one YAML document the way js-yaml 4's `load` did: input with no document (empty,
 * whitespace or only comments) gives `undefined` where js-yaml 5's `load` throws, and `<<`
 * merges. More than one document throws, as `load` does.
 */
export function loadYaml(text: string): unknown {
  const docs = loadAll(text, { schema: SCHEMA });
  if (docs.length > 1) {
    throw new YAMLException('expected a single document in the stream, but found more');
  }
  return docs[0];
}
