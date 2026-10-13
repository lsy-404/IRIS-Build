FROM ghcr.io/actions/actions-runner:2.338.0@sha256:4ffadc0002b2581327e06101fc8c06cd189232baf79fe561fac9caeb76f5e807

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential dbus-x11 gh libasound2t64 libgbm1 libgtk-3-0t64 \
        libnss3 libxss1 musl-tools pkg-config python3 xauth xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && chmod 750 /home/runner

USER runner
