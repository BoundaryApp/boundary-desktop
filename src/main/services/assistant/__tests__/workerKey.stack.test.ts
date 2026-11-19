/**
 * Stack contract: the SSH worker key belongs to the hermes user after Boundary sets HERMES_UID
 * and HERMES_GID (change request 0021 R1, stack v0.3.11). Runs only under `bun run test:stack`.
 *
 * Reads the key's owner and mode and the hermes user's ids in the running container. Nothing is
 * written and no SSH connection is made. Skips when the container has no copied key, as on a
 * stack whose terminal backend isn't ssh.
 */
import { describe, expect, it } from 'vitest';
import { probeStack, pythonJsonInHermes, skipNote } from './stackHarness';

const probe = await probeStack();

interface KeyFacts {
  present: boolean;
  keyUid?: number;
  keyGid?: number;
  mode?: number;
  hermesUid?: number;
  hermesGid?: number;
}

const PROGRAM = `
import json, os, pwd
path = "/var/lib/hermes-worker-key/id_ed25519"
if not os.path.exists(path):
    print(json.dumps({"present": False}))
    raise SystemExit(0)
st = os.stat(path)
user = pwd.getpwnam("hermes")
print(json.dumps({
    "present": True,
    "keyUid": st.st_uid,
    "keyGid": st.st_gid,
    "mode": st.st_mode & 0o777,
    "hermesUid": user.pw_uid,
    "hermesGid": user.pw_gid,
}))
`;

describe.skipIf(!probe.ok)(`SSH worker key owner${skipNote(probe)}`, () => {
  it('the copied key is owned by the remapped hermes user and readable only by it', async (ctx) => {
    if (!probe.ok) return;
    const facts = await pythonJsonInHermes<KeyFacts>(probe.target, PROGRAM);
    if (!facts.present) {
      ctx.skip('this container has no /var/lib/hermes-worker-key/id_ed25519');
      return;
    }
    expect(facts.keyUid).toBe(facts.hermesUid);
    expect(facts.keyGid).toBe(facts.hermesGid);
    expect(facts.mode).toBe(0o600);
  });
});
