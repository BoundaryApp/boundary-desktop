/** An iCloud app-specific password: four groups of four lowercase letters. */
export const APP_SPECIFIC = /^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$/;

export const APP_SPECIFIC_FORMAT_WARNING =
  'That doesn’t look like an app-specific password. Those are four groups of four letters, like abcd-efgh-ijkl-mnop. Your normal Apple Account password won’t work here.';
