#!/bin/sh
if [ "$GITHUB_REPOSITORY" = vb2007/vb2007.hu-api ] &&
  { [ "$GITHUB_EVENT_NAME" = push ] || [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; } &&
  { [ "$GITHUB_REF" = refs/heads/main ] || [ "$GITHUB_REF" = refs/heads/dev ]; }; then
  exit 0
fi
msg="host runner refuses ${GITHUB_EVENT_NAME:-unknown event} on ${GITHUB_REF:-unknown ref} from ${GITHUB_REPOSITORY:-unknown repo}: only push and workflow_dispatch on main or dev of vb2007/vb2007.hu-api run here"
echo "::error::$msg"
logger -t host-job-guard "$msg (run ${GITHUB_RUN_ID:-unknown})" || true
# A failed hook still lets always()/failure() steps run (actions/runner#2811), so end the job by SIGKILLing its worker.
pid=$PPID
while [ "$pid" -gt 1 ] && [ "$(ps -o comm= -p "$pid")" != Runner.Worker ]; do
  pid=$(ps -o ppid= -p "$pid" | tr -d ' ')
done
[ "$pid" -gt 1 ] && kill -KILL "$pid"
exit 1
