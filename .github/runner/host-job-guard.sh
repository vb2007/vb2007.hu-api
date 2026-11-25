#!/bin/sh
if [ "$GITHUB_REPOSITORY" = vb2007/vb2007.hu-api ] &&
  { [ "$GITHUB_EVENT_NAME" = push ] || [ "$GITHUB_EVENT_NAME" = workflow_dispatch ]; } &&
  { [ "$GITHUB_REF" = refs/heads/main ] || [ "$GITHUB_REF" = refs/heads/dev ]; }; then
  exit 0
fi
echo "::error::host runner refuses ${GITHUB_EVENT_NAME:-unknown event} on ${GITHUB_REF:-unknown ref} from ${GITHUB_REPOSITORY:-unknown repo}: only push and workflow_dispatch on main or dev of vb2007/vb2007.hu-api run here"
exit 1
