#!/usr/bin/env bash

node lighthouse-cli/test/fixtures/static-server.js &

sleep 0.5s
# TODO: replace this with a smoketest for --only-categories performance and nuke the perf-config
config="lighthouse-core/config/perf-config.js"
expectations="lighthouse-cli/test/smokehouse/perf/expectations.js"

yarn smokehouse --config-path=$config --expectations-path=$expectations
exit_code=$?

# kill test servers
kill $(jobs -p)

exit "$exit_code"
