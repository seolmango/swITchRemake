#!/bin/sh
# VM에서 돈다. deploy/azure/release.sh가 이미지와 함께 올려 실행한다. 직접 부를 일은 없다.
#
#   sh remote-release.sh <40자 커밋 SHA> <공개 주소, 예: https://game.example.com> <업로드 폴더>
#
# 순서: 지금 이미지를 rollback 태그로 보존 → 원복 스크립트 작성 → 대기방·경기·연결이 0인지 두 번 확인 →
# 라벨을 확인한 새 이미지로 match·cluster·web만 교체 → healthy와 /api/health/ready 확인.
# 확인이 하나라도 실패하면 자동으로 원복한다. 설정 파일·볼륨·DB는 건드리지 않는다.
set -eu
revision=$1
public_url=$2
deploy_dir=${DEPLOY_DIR:-/opt/switch-dev}
upload_dir=${3:?upload directory}
project=${COMPOSE_PROJECT:-switch-azure}
case "$revision" in *[!a-f0-9]*|'') echo 'revision must be a hex commit SHA' >&2; exit 2;; esac
test "${#revision}" -eq 40
release=$(printf '%s' "$revision" | cut -c1-7)
cd "$deploy_dir"
backup=$deploy_dir/releases/followup-$release
test ! -e "$backup"
mkdir -m 700 -p "$deploy_dir/releases"
mkdir -m 700 "$backup"
docker inspect --format '{{.Image}}' "$project-match-1" > "$backup/backend.id"
docker inspect --format '{{.Image}}' "$project-web-1" > "$backup/web.id"
docker tag "$(cat "$backup/backend.id")" "$project-backend:rollback-$release"
docker tag "$(cat "$backup/web.id")" "$project-web:rollback-$release"
gunzip -c "$upload_dir/release-$release.tar.gz" | docker load
for image in "$project-backend:followup-$release" "$project-web:followup-$release"; do
  test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")" = "$revision"
done
cat > "$backup/rollback.sh" <<ROLLBACK
#!/bin/sh
set -eu
cd $deploy_dir
docker tag $project-backend:rollback-$release $project-backend:local
docker tag $project-web:rollback-$release $project-web:local
docker compose -f compose.yml up -d --no-deps --force-recreate match cluster web
ROLLBACK
chmod 700 "$backup/rollback.sh"
docker exec -i "$project-cluster-1" node < "$upload_dir/idle-check.cjs" > "$backup/idle-before-1.json"
sleep 3
docker exec -i "$project-cluster-1" node < "$upload_dir/idle-check.cjs" > "$backup/idle-before-2.json"
changed=0
rollback_on_failure() {
  status=$?
  trap - EXIT
  if [ "$status" -ne 0 ] && [ "$changed" -eq 1 ]; then
    echo 'Deployment check failed; restoring the previous images.' >&2
    "$backup/rollback.sh"
  fi
  exit "$status"
}
trap rollback_on_failure EXIT
changed=1
docker tag "$project-backend:followup-$release" "$project-backend:local"
docker tag "$project-web:followup-$release" "$project-web:local"
docker compose -f compose.yml up -d --no-deps --force-recreate match cluster web
attempt=0
for service in match cluster web; do
  until [ "$(docker inspect --format '{{.State.Health.Status}}' "$project-$service-1")" = healthy ]; do
    attempt=$((attempt + 1))
    test "$attempt" -lt 36
    sleep 5
  done
done
curl --fail --silent --show-error --max-time 10 "$public_url/api/health/ready" > "$backup/readiness.json"
printf '%s\n' "$revision" > "$backup/revision.txt"
docker inspect --format '{{.Name}} {{.Image}} {{.RestartCount}} {{.State.OOMKilled}}' "$project-match-1" "$project-cluster-1" "$project-web-1" > "$backup/containers.txt"
rm -f "$upload_dir/release-$release.tar.gz"
echo "DEPLOYMENT_HEALTH_PASSED revision=$revision"
echo "rollback: sudo sh $backup/rollback.sh"
