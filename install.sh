#!/bin/sh
# Run from the checked-out project. Secrets are never emitted in unattended logs.
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    printf '%s\n' 'Install Docker Engine and the Docker Compose plugin first.' >&2
    exit 1
fi
service=lcsc-stock-mobile
helper() {
    # Root can read an existing root-owned /app/data key; return .env ownership
    # to the invoking host user so their next Compose command can read it.
    docker compose run --rm -T --no-deps -v "$PWD:/project" --entrypoint python "$service" -c '
import os, stat, sys
sys.path.insert(0, "/app/backend")
import access, manage

def container_id(host_id, mapping):
    with open(mapping, encoding="ascii") as stream:
        for line in stream:
            inner, outer, length = map(int, line.split())
            if outer <= host_id < outer + length:
                return inner + host_id - outer
    raise RuntimeError("Host owner is not mapped into this container; check Docker user namespace configuration.")

uid = container_id(int(sys.argv[1]), "/proc/self/uid_map")
gid = container_id(int(sys.argv[2]), "/proc/self/gid_map")
try:
    code = manage.main(sys.argv[3:])
finally:
    with access.locked("/project/.env"):
        for name in ("/project/.env", "/project/.env.lock"):
            path = access._check(name)
            if not path.exists():
                continue
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                    raise access.AccessError("Refusing unsafe credential ownership change.")
                os.fchown(fd, uid, gid)
                os.fchmod(fd, 0o600)
            finally:
                os.close(fd)
raise SystemExit(code)
' "$(id -u)" "$(id -g)" "$@" --env-file /project/.env
}
wait_ready() {
    docker compose exec -T "$service" python -c '
import os, time, urllib.request
for attempt in range(60):
    try:
        request = urllib.request.Request("http://127.0.0.1:8088/api/version", headers={"Authorization": "Bearer " + os.environ.get("PINBOX_API_TOKEN", "")})
        with urllib.request.urlopen(request, timeout=2) as response:
            if response.status == 200:
                break
    except Exception:
        time.sleep(1)
else:
    raise SystemExit("PinBox did not become ready; inspect docker compose logs privately.")
'
}
case "${1:-install}" in
    install|update)
        docker compose build "$service"
        metadata=$(helper setup --mode shared --json)
        docker compose up -d --no-build --force-recreate "$service"
        wait_ready
        printf '%s\n' "PinBox started. Open ${PINBOX_PUBLIC_URL:-http://<server-ip>:8088} (trusted HTTPS is recommended)." \
            "Private connection settings: $PWD/.env" \
            'Other devices: choose Connect to an existing warehouse and enter its address and connection key.'
        case "$metadata" in
            *'"created": true'*)
                if [ -t 0 ] && [ -t 1 ]; then
                    printf '%s\n' 'Your new connection key (keep private):'
                    helper token show
                else
                    printf '%s\n' 'No secret was printed. Run ./install.sh token show in a private terminal to view the key.'
                fi
                ;;
        esac
        ;;
    status)
        helper status
        docker compose ps "$service"
        ;;
    token)
        case "${2:-}" in
            show) helper token show ;;
            reset)
                if [ -n "${PINBOX_API_TOKEN:-}" ]; then
                    printf '%s\n' 'Unset PINBOX_API_TOKEN in this shell before reset; otherwise it overrides the updated .env.' >&2
                    exit 1
                fi
                if [ "${3:-}" != '--yes' ]; then
                    printf '%s\n' 'Reset disconnects all clients. Use ./install.sh token reset --yes to confirm.' >&2
                    exit 1
                fi
                helper token reset --yes
                docker compose up -d --no-build --force-recreate "$service"
                wait_ready
                printf '%s\n' 'Service recreated. Use ./install.sh token show, then reconnect your devices.'
                ;;
            *) printf '%s\n' 'Usage: ./install.sh token show | token reset --yes' >&2; exit 1 ;;
        esac
        ;;
    *) printf '%s\n' 'Usage: ./install.sh [install|update|status|token show|token reset --yes]' >&2; exit 1 ;;
esac
