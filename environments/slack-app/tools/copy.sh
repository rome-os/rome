# Which copy of the environment a script acts on. Sourced by up.sh, ctl.sh and
# down.sh after they set ENV_DIR; README.md "Two copies side by side" has why.
#
# SLACKENV_PROJECT names the copy: its compose project and, with it, its
# containers, volumes and network. The default, slackenv, keeps .state and the
# slackenv-rome image names; any other name gets .state-<name> and images
# tagged slackenv-<name>-rome. live.sh's project and state folder are refused.
#
# Sets SLACKENV_PROJECT, STATE_DIR and IMAGE_PREFIX.

SLACKENV_PROJECT="${SLACKENV_PROJECT:-slackenv}"
if ! [[ "$SLACKENV_PROJECT" =~ ^[a-z0-9][a-z0-9_-]*$ ]]; then
  echo "[slackenv] the copy's name must be lowercase letters, digits, - and _: $SLACKENV_PROJECT" >&2
  exit 2
fi
case "$SLACKENV_PROJECT" in
  live | slackenv-live)
    echo "[slackenv] $SLACKENV_PROJECT is live.sh's; pick another name" >&2
    exit 2
    ;;
  slackenv)
    STATE_DIR="$ENV_DIR/.state"
    IMAGE_PREFIX=slackenv
    ;;
  *)
    STATE_DIR="$ENV_DIR/.state-$SLACKENV_PROJECT"
    IMAGE_PREFIX="slackenv-$SLACKENV_PROJECT"
    ;;
esac
export SLACKENV_PROJECT STATE_DIR IMAGE_PREFIX
