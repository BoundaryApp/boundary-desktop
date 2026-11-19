# Ubuntu 24.04 matches GitHub's ubuntu-latest runner. Holds the tools Forge's deb and rpm makers
# need and the libraries Electron needs to start under Xvfb.
FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl zip unzip git rsync python3 xz-utils \
      fakeroot dpkg-dev rpm \
      xvfb xauth libgtk-3-0t64 libnss3 libasound2t64 libgbm1 libxss1 libxtst6 libsecret-1-0 \
      libnotify4 libatspi2.0-0t64 libdrm2 libxkbcommon0 dbus-x11 \
    && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-$(dpkg --print-architecture | sed 's/amd64/x64/').tar.xz \
      | tar -xJ -C /usr/local --strip-components=1
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
# A normal user, as on the runner. Root ignores file modes, which some tests rely on.
RUN useradd -m runner && mkdir /work && chown runner /work
USER runner
WORKDIR /work
