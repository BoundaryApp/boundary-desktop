import { addonSlugFromName } from './utils/slug';

/**
 * A budget's name as agents see it after `budget-` (spec decision 20): the add-on slug rule
 * (`budget.sh`'s `hook_args`), `budget` when nothing is left.
 */
export function slugFromName(name: string): string {
  return addonSlugFromName(name, 'budget');
}
