# 0032. Circles: invite-only groups that network peer to peer

- Date: 2026-10-29
- Status: Accepted
- Parent: [0001](0001-record-architecture-decisions.md)
- Related: [0027](0027-host-bridge.md) (utility process owned by main), [0033](0033-inference-chains.md), [0034](0034-shared-models.md), [circles plan](../circles-plan.md)

## Context

Boundary users want to join small groups of people they know: to share a local model with each other ([0034](0034-shared-models.md)) and to keep a shared chat history. There is no server Boundary can run for this, and the product should not depend on one. Keet's group rooms show the shape that works without one: peers find each other on a DHT, connect directly with hole punching, and replicate signed append-only logs.

The Holepunch stack provides each part as a Node module:

- `hyperswarm` (4.17) finds peers by topic and opens Noise-encrypted connections.
- `hypercore` (11.39) and `corestore` (7.16) store and replicate signed append-only logs.
- `autobase` (7.28) merges several writers' logs into one view.
- `blind-pairing` (2.3) carries an invite from an existing member to a new device.
- `protomux` (3.13) runs several protocols over one connection.

Holepunch's `autopass` example uses `autobase` and `blind-pairing` together for invites and shared state. The modules depend on native addons: `sodium-native`, `udx-native`, and `rocksdb-native` through Hypercore's storage. Boundary has already lost a launch to a native addon whose signature broke after an in-place rebuild, so packaging is a risk to retire first.

The name for a group is **Circle**. Boundary already uses project, channel, DM, room and workspace for other things.

## Decision

1. **A network utility process.** Hyperswarm, Corestore and Autobase run in their own Electron `utilityProcess`, the same arrangement as the host bridge ([0027](0027-host-bridge.md) §1). Main owns policy, keys and the user's choices, and talks to it over a MessagePort. The renderer never talks to it directly. Corestore keeps its data in Boundary's user data folder. Each Circle's Autobase is encrypted with its own key, which an invite hands to the new member and main keeps with `safeStorage`, so blocks on disk and on the wire are unreadable without it.
2. **One identity per user, one key per device.** Each user has an identity keypair that signs a key for each of their devices. The device key is also the device's swarm key, so a connection's remote key says which member's device it is, which is how presence works. Members of one Circle can see that a person in another Circle is the same identity. That is acceptable for invite-only groups, and it lets a provider count usage per person across Circles ([0034](0034-shared-models.md) §5).
3. **A Circle is an Autobase.** Its view holds the members and their device keys, each member's role, shared-model offers ([0034](0034-shared-models.md)) and the Circle's chat channels. The Circle's discovery key is its swarm topic.
4. **Two roles: admin and member.** Admins invite, remove members and change roles. The creator is the first admin. Admins are Autobase indexers; members are writers.
5. **Invites use `blind-pairing`.** An admin creates an invite, which is a link or code. The invitee's device presents it to the swarm, and an online admin's device adds the invitee's device key as a writer. An invite needs an admin online to complete. Invites expire and can be revoked. The device that makes an invite keeps its code, encrypted with `safeStorage` and never in the Circle's log, until the invite is used, revoked or expired, or the Circle is left. An invite made with the name of an open invite on that device revokes the older one, which stops working once an admin's device has seen the revoke.
6. **Members keep history.** Every member keeps a full replica of the Circle's logs, and any peer that holds blocks can serve them. Removing a member does not erase what they already hold. A device replicates only with devices that are members of one of its user's Circles (or with anyone while it is still joining one), and disconnects a device that has been removed from every Circle they share. That stops new data reaching a removed member through peers they share no other Circle with. It is not a guarantee: a removed member who still shares another Circle with a peer, or who makes a new device key and finds a peer still joining, can fetch the Circle's blocks, and still holds its key. Closing that needs a new key for the Circle after a removal, which Autobase does not offer; it is later work. A removed device stops receiving the Circle's log, so it can't read its own removal entry. An admin sends it a one-frame notice instead, when it is removed or when it next connects, and the device closes the Circle and forgets its secrets. The device acts only on a notice from a device that is an admin in its own view. The connection stays open for about two seconds so the notice goes out. When an admin is demoted, removed or leaves, the acting device also revokes their open invites.
7. **Admins being online matters for two things:** completing invites, and confirming the order of messages. Autobase shows writers' entries before the indexers confirm them; Boundary marks unconfirmed entries in the UI until they are confirmed. An entry is confirmed once a majority of the Circle's admins have indexed it ([Autobase 7: writers' entries while no indexer is online](../circles-autobase-confirmation.md)), so in a Circle with three or more admins one online admin is not enough. An admin's device also checks an invite's expiry before it adds anyone, because Autobase's apply step has no clock.
8. **Circle chats are separate from Hermes chats.** A Circle chat is stored in the Circle's Autobase, not in Hermes. Moving anything from a Hermes chat into a Circle is an explicit share action, because Hermes sessions are private to their owner.
9. **Packaging is proven first.** Phase 0 builds the network process with all native addons into a signed, notarized macOS build before any Circle feature depends on it.

## Consequences

- Circles work while Boundary runs. With Boundary closed, a user's device does not serve history, accept invites or share a model.
- A Circle with no admin online can still chat, but invites wait and new messages stay unconfirmed.
- Removing a member is forward-only. The UI says so when an admin removes someone.
- The identity key is the most sensitive secret Boundary holds after model keys. It is kept with `safeStorage`, like those keys ([0015](0015-inference-provider-slots.md)).
- Multi-device sign-in (adding a second Mac to the same identity) reuses `blind-pairing` and is later work.
