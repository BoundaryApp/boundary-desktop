// bitwarden-broker, web-browser and bitwarden-signin as stack v0.3.16's docker-compose.yml has
// them (lines 2392–2418, 2319–2342, 2490–2522 and 2755–2759), trimmed.
export const V0316_COMPOSE = `services:
  hermes:
    tmpfs:
      - /tmp
  bitwarden-broker:
    profiles: ["bitwarden"]
    container_name: \${CONTAINER_PREFIX:-}bitwarden-broker
    # The host user, as email-imap and the Hermes readers of instances/ run:
    # the store keeps instances/ at 0700, owned by that user.
    user: "\${HERMES_UID:-1000}:\${HERMES_GID:-1000}"
    read_only: true
    tmpfs:
      - /tmp
      # The Unix socket for manual unlocks (python3 -m broker.unlock, run with
      # docker compose exec as the same user). A tmpfs, so its owner follows
      # HERMES_UID; nothing else mounts it.
      - /run/bitwarden-sync:mode=0700,uid=\${HERMES_UID:-1000},gid=\${HERMES_GID:-1000}
    cap_drop: [ALL]
  web-browser:
    profiles: ["web-browser"]
    read_only: true
    tmpfs:
      - /tmp:size=512m
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
      # Docker's default profile plus the clone, unshare and chroot cases
      # Chromium's namespace sandbox needs with no capabilities.
      - seccomp=./compose/bitwarden-signin/seccomp.json
    environment:
      - WEB_BROWSER_LISTEN=0.0.0.0:9222
  bitwarden-signin:
    profiles: ["bitwarden"]
    read_only: true
    # The per-session Chromium profile (HOME, TMPDIR, cache, crash files).
    tmpfs:
      - /tmp:size=512m
    mem_limit: 768m
    cap_drop: [ALL]
    # Docker's default profile plus the clone, unshare and chroot cases
    # Chromium's namespace sandbox needs (see the comment key in the file).
    security_opt:
      - no-new-privileges:true
      - seccomp=./compose/bitwarden-signin/seccomp.json
    environment:
      - BITWARDEN_SIGNIN_SOCKET=/run/bitwarden-signin/signin.sock
    volumes:
      - bitwarden_signin:/run/bitwarden-signin

volumes:
  web_browser_profile:
  # bitwarden-signin's socket folder, mounted by it and bitwarden-broker only.
  bitwarden_signin:
    driver_opts:
      type: tmpfs
      device: tmpfs
      o: "uid=\${HERMES_UID:-1000},gid=\${HERMES_GID:-1000},mode=0700,size=1m"
`;
