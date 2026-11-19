// Stand-in for the calendar helper in tests. Run with node: fake-calendar-helper.mjs <behaviour>.
//   ok            answers every request; `getEvent` returns an event with a made-up title
//   crash-after-1 answers the first request, then exits
//   hang          never answers `getEvent` or `search`, answers everything else
//   slow-reads    takes 30 s over `listEvents` and `search`, and like the real helper answers
//                 one request at a time, in order
//   garbage       writes an unreadable line before each reply
//   denied        answers every request with a denied error
//   hold-access   holds its reply to `requestAccess` until a `release` request arrives
// `emitChanged` as a request op writes {"event":"changed"} before its reply.
// The tests also run it in-process: serveFakeCalendarHelper speaks the same protocol over any
// pair of streams.
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Reads requests from `input` and writes replies to `output`, one JSON line each. Calls `exit`
 * when the behaviour crashes or `input` closes.
 */
export function serveFakeCalendarHelper(behaviour, input, output, exit) {
  let seen = 0;
  let heldAccessId = null;
  let busy = Promise.resolve();

  const write = (value) => output.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`);

  const rl = readline.createInterface({ input });
  rl.on('line', (line) => {
    const req = JSON.parse(line);
    if (behaviour === 'slow-reads') {
      const ms = req.op === 'listEvents' || req.op === 'search' ? 30_000 : 0;
      busy = busy
        .then(() => (ms ? new Promise((resolve) => setTimeout(resolve, ms)) : undefined))
        .then(() => answer(req));
      return;
    }
    answer(req);
  });
  rl.on('close', exit);

  function answer(req) {
    seen += 1;
    if (behaviour === 'hang' && (req.op === 'getEvent' || req.op === 'search')) return;
    if (behaviour === 'hold-access' && req.op === 'requestAccess') {
      heldAccessId = req.id;
      return;
    }
    if (behaviour === 'hold-access' && req.op === 'release' && heldAccessId !== null) {
      write({ id: heldAccessId, ok: true, result: { access: 'granted' } });
      heldAccessId = null;
    }
    if (behaviour === 'garbage') write('not json at all');
    if (req.op === 'emitChanged') write({ event: 'changed' });
    if (behaviour === 'denied') {
      write({ id: req.id, ok: false, error: { code: 'denied', message: 'Calendar access is denied' } });
    } else {
      const result =
        req.op === 'status' || req.op === 'requestAccess'
          ? { access: 'granted' }
          : req.op === 'listCalendars'
            ? [
                { id: 'cal-1', title: 'Secret Title Work', color: '#112233', source: 'iCloud', kind: 'icloud', writable: true },
                { id: 'cal-2', title: 'Holidays', color: '#445566', source: 'Subscribed', kind: 'subscribed', writable: false },
              ]
            : req.op === 'listEvents'
              ? [
                  {
                    id: 'ev-1',
                    calendarId: 'cal-1',
                    title: 'Secret Title Dentist',
                    start: '2026-11-12T09:00:00-08:00',
                    end: '2026-11-12T10:00:00-08:00',
                    allDay: false,
                    recurring: false,
                    attendees: [],
                  },
                ]
              : { echoedParams: req.params, title: 'Secret Title Dentist' };
      write({ id: req.id, ok: true, result });
    }
    if (behaviour === 'crash-after-1' && seen === 1) exit();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  serveFakeCalendarHelper(process.argv[2] ?? 'ok', process.stdin, process.stdout, () => {
    process.stdout.write('', () => process.exit(0));
  });
}
