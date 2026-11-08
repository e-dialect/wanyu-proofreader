#!/bin/sh
# Official standalone release archives, pinned by version AND release SHA-256.
set -eu
tool=${1:?usage: install_security_tool.sh trivy|gitleaks DESTINATION}
destination=${2:?destination required}
case "$(uname -s):$tool" in
  Linux:trivy) version=0.76.2; repository=aquasecurity/trivy; archive=trivy_${version}_Linux-64bit.tar.gz; asset=713401165; digest=bc0fc726e017b8927a62b2d3531d7a84ee01769daf5c99ed866dced54089fdbf ;;
  Darwin:trivy) version=0.76.2; repository=aquasecurity/trivy; archive=trivy_${version}_macOS-64bit.tar.gz; asset=713400752; digest=e08bb9ea449ecf66c6bfb03cbb8697c503ff33d35fc585c9747e3eaeb7ed4c7b ;;
  Linux:gitleaks) version=8.30.1; repository=gitleaks/gitleaks; archive=gitleaks_${version}_linux_x64.tar.gz; asset=378332058; digest=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  Darwin:gitleaks) version=8.30.1; repository=gitleaks/gitleaks; archive=gitleaks_${version}_darwin_x64.tar.gz; asset=378332053; digest=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  *) echo 'Only the reviewed x86_64 Linux/macOS archives are supported' >&2; exit 2 ;;
esac
[ "$(uname -m)" = x86_64 ] || { echo 'Unsupported architecture' >&2; exit 2; }
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM
# Each new invocation recomputes the resume offset from the existing file.
# curl's internal retry reuses its original offset and can discard partial data.
downloaded=false
backoff=2
for attempt in 1 2 3 4 5 6; do
  source="https://github.com/$repository/releases/download/v$version/$archive"
  # Same official release asset and reviewed digest; an alternate GitHub front
  # door recovers release-page/CDN 5xx without changing version or trust source.
  if [ $((attempt % 2)) -eq 0 ]; then
    source="https://api.github.com/repos/$repository/releases/assets/$asset"
  fi
  if curl --fail --silent --show-error --http1.1 --location --continue-at - --connect-timeout 15 --max-time "${SECURITY_DOWNLOAD_TIMEOUT:-180}" \
    --header 'Accept: application/octet-stream' "$source" -o "$temporary/archive.tar.gz"; then
    downloaded=true
    break
  fi
  # Alternate official front doors across a bounded 62-second backoff window.
  # Keep the same partial file so every new curl recomputes its resume offset.
  if [ "$attempt" -lt 6 ]; then
    sleep "$backoff"
    backoff=$((backoff * 2))
  fi
done
if [ "$downloaded" != true ]; then
  echo "Unable to download pinned $tool $version from official release endpoints after 6 attempts" >&2
  exit 1
fi
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
