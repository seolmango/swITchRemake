#!/bin/sh
# 검증을 통과한 커밋 하나를 Azure VM에 배포한다. GitHub Actions의 deploy 워크플로가 부르고,
# 같은 명령을 손으로 돌릴 수도 있다(docs/deployment.md).
#
#   DEPLOY_HOST=azureuser@4.217.193.234 DEPLOY_SSH_KEY=~/.ssh/switch.pem \
#   DEPLOY_URL=https://switch-dev-193234.koreacentral.cloudapp.azure.com \
#   sh deploy/azure/release.sh <40자 커밋 SHA> [--build-only]
#
# 1. 커밋을 `git archive`로 꺼내 그 내용만으로 backend·web 이미지를 굽는다(작업 트리의 수정은 섞이지 않는다).
#    두 이미지에 org.opencontainers.image.revision=<SHA> 라벨을 넣는다.
# 2. 이미지를 gzip으로 묶어 VM에 올리고 remote-release.sh를 실행한다. 그 스크립트가 idle 확인, 교체,
#    health 확인, 실패 시 자동 원복을 맡는다.
#
# 이 스크립트는 커밋이 검증을 통과했는지 확인하지 않는다. 그 확인은 deploy 워크플로가 하고,
# 손으로 돌릴 때는 돌리는 사람이 `npm run verify` 결과를 확인한다.
set -eu
revision=${1:-}
mode=${2:-}
case "$revision" in *[!a-f0-9]*|'') echo 'usage: release.sh <40-char commit sha> [--build-only]' >&2; exit 2;; esac
test "${#revision}" -eq 40 || { echo 'use the full 40-character SHA' >&2; exit 2; }
release=$(printf '%s' "$revision" | cut -c1-7)
project=${COMPOSE_PROJECT:-switch-azure}
root=$(git rev-parse --show-toplevel)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$root" cat-file -e "$revision^{commit}"
git -C "$root" archive --format=tar "$revision" | tar -x -C "$work"
docker build -f "$work/Dockerfile.backend" --label "org.opencontainers.image.revision=$revision" \
  -t "$project-backend:followup-$release" "$work"
docker build -f "$work/deploy/Dockerfile.web" --label "org.opencontainers.image.revision=$revision" \
  -t "$project-web:followup-$release" "$work"
docker save "$project-backend:followup-$release" "$project-web:followup-$release" | gzip > "$work/release-$release.tar.gz"
echo "built release-$release.tar.gz ($(du -h "$work/release-$release.tar.gz" | cut -f1))"
[ "$mode" = '--build-only' ] && exit 0

: "${DEPLOY_HOST:?DEPLOY_HOST=user@host}"
: "${DEPLOY_URL:?DEPLOY_URL=https://공개주소}"
ssh_opts="-o BatchMode=yes -o StrictHostKeyChecking=yes"
[ -n "${DEPLOY_SSH_KEY:-}" ] && ssh_opts="$ssh_opts -i $DEPLOY_SSH_KEY"
# shellcheck disable=SC2086
scp $ssh_opts "$work/release-$release.tar.gz" "$root/deploy/azure/idle-check.cjs" "$root/deploy/azure/remote-release.sh" "$DEPLOY_HOST:"
# shellcheck disable=SC2086
# \$HOME은 VM에서 풀린다(scp가 올린 곳). sudo 아래에서는 root의 홈이 되므로 인자로 넘긴다.
ssh $ssh_opts "$DEPLOY_HOST" "sudo sh remote-release.sh $revision $DEPLOY_URL \$HOME"
