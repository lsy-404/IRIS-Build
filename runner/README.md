# IRIS CI runner

The single Linux CI job runs in an Ubuntu 24.04 container with two CPUs and 4 GiB of memory. The container exposes no ports and mounts only its own named volume. Runner updates remain enabled.

Build the image with `docker compose build`. Register it with `docker compose run --rm -T runner ./config.sh` using a short-lived repository registration token, the name `ionos5-iris-ci`, the label `iris-ci`, and work directory `_work`. Supply the token through standard input to a shell wrapper so it stays out of shell history. Then start with `docker compose up -d`.

Use `docker compose logs --tail 50 runner` for status and `docker compose stop` to stop accepting jobs. Configuration and package caches persist in `iris-ci-runner-home`; removing that volume requires registration again. CI clears the source workspace before and after each job.

Only trusted dispatches on the repository default branch may use this runner. Build and publication jobs use their existing runners.
