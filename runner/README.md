# Shared CI runners

Repository runners share one Ubuntu 24.04 host, image, and resource budget. Each registration has an isolated home and package cache. All runners together use at most two CPUs, 4 GiB RAM, and 12 GiB swap; the host retains the remaining RAM and swap for its applications. The shared CI filesystem reserves 100 GiB, and each container exposes no ports or Docker socket. Runner updates remain enabled.

On a new host, create the CI filesystem without overwriting an existing image:

```sh
test ! -e /var/lib/ci-runner.img
fallocate -l 100G /var/lib/ci-runner.img
mkfs.ext4 -q -m 0 -E nodiscard -L ci-runner-data /var/lib/ci-runner.img
install -d /srv/ci-runners
printf '%s\n' '/var/lib/ci-runner.img /srv/ci-runners ext4 loop,nodev,nosuid,nofail,X-fstrim.notrim 0 0' >> /etc/fstab
mount /srv/ci-runners
install -m 0644 ci.slice /etc/systemd/system/ci.slice
systemctl daemon-reload
systemctl enable --now ci.slice
```

Keep one copy of these deployment files on the host. For each repository, copy `.env.example` to `instances/<repository>.env`. Set a unique `RUNNER_NAME` and its `RUNNER_REPOSITORY`, create `/srv/ci-runners/$RUNNER_NAME` owned by UID 1001/GID 123 with mode 750, and run `docker compose --env-file instances/<repository>.env build`. Pipe its short-lived repository registration token to `bash register.sh instances/<repository>.env`; it is read from standard input and is never stored in the deployment files.

Jobs select `[self-hosted, linux, x64, ci]`. Only trusted jobs may use the pool; a personal GitHub account requires a separate registration for each repository. IRIS uses its existing single verification job and clears its source workspace before and after execution.

IRIS command output remains outside public Actions logs. Private output is written under `/home/runner/ci-logs` with owner-only directory/file permissions; successful logs are removed and the latest 20 failed or interrupted command directories are retained for diagnosis.

Use `docker compose --env-file instances/<repository>.env logs --tail 50 runner` for status and the same command with `stop` to stop accepting jobs. Container configuration and caches persist in its repository home; deleting that home requires registration again. The named volume contains only that repository's directory from the shared CI filesystem.
