#!/bin/sh
# Official standalone release archives, pinned by version AND release SHA-256.
set -eu
tool=${1:?usage: install_security_tool.sh trivy|gitleaks DESTINATION}
destination=${2:?destination required}
case "$(uname -s):$tool" in
  Linux:trivy) version=0.76.2; repository=aquasecurity/trivy; archive=trivy_${version}_Linux-64bit.tar.gz; digest=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf ;;
  Darwin:trivy) version=0.76.2; repository=aquasecurity/trivy; archive=trivy_${version}_macOS-64bit.tar.gz; digest=e08bb9ea449ecf66c6bfb03cbb8697c503ff33d35fc585c9747e3eaeb7ed4c7b ;;
  Linux:gitleaks) version=8.30.1; repository=gitleaks/gitleaks; archive=gitleaks_${version}_linux_x64.tar.gz; digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Darwin:gitleaks) version=8.30.1; repository=gitleaks/gitleaks; archive=gitleaks_${version}_darwin_x64.tar.gz; digest=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  *) echo 'Only the reviewed x86_64 Linux/macOS archives are supported' >&2; exit 2 ;;
esac
[ "$(uname -m)" = x86_64 ] || { echo 'Unsupported architecture' >&2; exit 2; }
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
# Each new invocation recomputes the resume offset from the existing file.
# curl's internal retry reuses its original offset and can discard partial data.
for attempt in 1 2 3 4; do
  if curl --fail --silent --show-error --http1.1 --location --continue-at - --connect-timeout 15 --max-time "${SECURITY_DOWNLOAD_TIMEOUT:-180}" \
    "https://github.com/$repository/releases/download/v$version/$archive" -o "$temporary/archive.tar.gz"; then
    break
  fi
done
python3 - "$temporary/archive.tar.gz" "$digest" <<'PY'
import hashlib, pathlib, sys
actual = hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest()
if actual != sys.argv[2]:
    raise SystemExit('Security tool archive SHA-256 does not match reviewed release')
PY
tar -xzf "$temporary/archive.tar.gz" -C "$temporary" "$tool"
mkdir -p "$destination"
install -m 755 "$temporary/$tool" "$destination/$tool"
"$destination/$tool" --version
