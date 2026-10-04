#!/usr/bin/env bash
# Bootstrap the single Ubuntu 24.04 development VM; run with sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo 'Run this script with sudo.' >&2
    exit 1
fi
. /etc/os-release
if [[ $ID != ubuntu || $VERSION_ID != 24.04 ]]; then
    echo 'This bootstrap expects Ubuntu 24.04.' >&2
    exit 1
fi

# Use space on the existing OS disk, without provisioning another Azure disk.
if ! swapon --noheadings --show=NAME | grep -Fxq /swapfile; then
    if [[ -e /swapfile ]]; then
        echo 'An inactive /swapfile already exists; inspect it before continuing.' >&2
        exit 1
    fi
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile
fi
if ! grep -Eq '^/swapfile[[:space:]]' /etc/fstab; then
    printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi
printf 'vm.swappiness=20\n' > /etc/sysctl.d/90-switch-dev.conf
sysctl -p /etc/sysctl.d/90-switch-dev.conf

install -m 0755 -d /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-switch-dev.conf <<'EOF'
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
EOF
sshd -t
systemctl reload ssh

if ! command -v docker >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get -o DPkg::Lock::Timeout=180 update -qq
    apt-get -o DPkg::Lock::Timeout=180 install -y -qq ca-certificates curl
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod 0644 /etc/apt/keyrings/docker.asc
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get -o DPkg::Lock::Timeout=180 update -qq
    apt-get -o DPkg::Lock::Timeout=180 install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

# Bound container logs on this development machine. Preserve an existing config.
install -m 0755 -d /etc/docker
if [[ ! -e /etc/docker/daemon.json ]]; then
    cat > /etc/docker/daemon.json <<'EOF'
{"log-driver":"local","log-opts":{"max-size":"10m","max-file":"3"}}
EOF
    systemctl restart docker
fi
systemctl enable --now docker
install -m 0750 -o azureuser -g azureuser -d /opt/switch-dev
docker --version
docker compose version
free -m
sshd -T | grep -E '^(passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitrootlogin) '
