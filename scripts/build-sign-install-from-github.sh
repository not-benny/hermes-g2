#!/usr/bin/env bash

# Build a release APK from a fresh GitHub checkout, sign it locally, and update
# the existing owner installation without removing its app-private data.
set +x
set +a
set -euo pipefail

# Capture caller-provided secrets before any child process runs, then remove the
# exported names from the build environment. The local values are never logged.
input_keystore_password=${HERMES_KEYSTORE_PASSWORD:-}
input_key_password=${HERMES_KEY_PASSWORD:-}
unset HERMES_KEYSTORE_PASSWORD HERMES_KEY_PASSWORD

readonly GITHUB_REPOSITORY="https://github.com/not-benny/hermes-g2.git"
readonly DEFAULT_REF="fix/mcp-glasses-reliability"
readonly EXPECTED_PACKAGE="com.faceclaw.app"
readonly ANDROID_BUILD_TOOLS_VERSION="35.0.1"
readonly ANDROID_NDK_VERSION="27.2.12479018"

ref=${HERMES_GITHUB_REF:-$DEFAULT_REF}
serial=${HERMES_ADB_SERIAL:-${ANDROID_SERIAL:-}}
adb_port=${HERMES_ADB_SERVER_PORT:-${ANDROID_ADB_SERVER_PORT:-5037}}
keystore=${HERMES_KEYSTORE_PATH:-}
key_alias=${HERMES_KEY_ALIAS:-}
output_path=${HERMES_APK_OUTPUT:-}
install_apk=true
allow_downgrade=false
allow_signer_mismatch=false
invocation_dir=$PWD
temporary_root=

usage() {
  cat <<'EOF'
Usage: scripts/build-sign-install-from-github.sh [options]

Fetch a clean Hermes G2 source snapshot from GitHub, build the repository's
unsigned Android release, zipalign and sign it locally, then update the app via
adb install -r so Android retains the current app data.

Options:
  --ref REF                    Git branch, tag, or commit to fetch
                               (default: fix/mcp-glasses-reliability)
  --serial SERIAL              Target adb device serial (or ANDROID_SERIAL)
  --adb-port PORT              adb server port (default: 5037)
  --keystore PATH              Signing keystore (or HERMES_KEYSTORE_PATH)
  --key-alias ALIAS            Signing key alias (or HERMES_KEY_ALIAS)
  --output PATH                Destination for the signed APK
  --build-only, --no-install   Build, sign, and verify without contacting adb
  --allow-downgrade            Permit an older versionCode and pass adb -d
  --allow-signer-mismatch      Permit the install attempt when certificates differ
  -h, --help                   Show this help

Signing passwords are read only from HERMES_KEYSTORE_PASSWORD and, optionally,
HERMES_KEY_PASSWORD. They are passed to apksigner through its environment
password provider and are never placed on a command line or printed. If no
keystore is configured, the calling owner's existing ~/.android/debug.keystore
is used with its standard debug identity. No keystore is created by this script.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

need_option_value() {
  local option=$1
  local present=${2+x}
  local value=${2-}
  [[ -n "$present" && -n "$value" ]] || die "$option requires a non-empty value"
}

while (($#)); do
  case "$1" in
    --ref)
      need_option_value "$1" "${2-}"
      ref=$2
      shift 2
      ;;
    --ref=*)
      ref=${1#*=}
      [[ -n "$ref" ]] || die "--ref requires a non-empty value"
      shift
      ;;
    --serial)
      need_option_value "$1" "${2-}"
      serial=$2
      shift 2
      ;;
    --serial=*)
      serial=${1#*=}
      [[ -n "$serial" ]] || die "--serial requires a non-empty value"
      shift
      ;;
    --adb-port)
      need_option_value "$1" "${2-}"
      adb_port=$2
      shift 2
      ;;
    --adb-port=*)
      adb_port=${1#*=}
      [[ -n "$adb_port" ]] || die "--adb-port requires a non-empty value"
      shift
      ;;
    --keystore)
      need_option_value "$1" "${2-}"
      keystore=$2
      shift 2
      ;;
    --keystore=*)
      keystore=${1#*=}
      [[ -n "$keystore" ]] || die "--keystore requires a non-empty value"
      shift
      ;;
    --key-alias)
      need_option_value "$1" "${2-}"
      key_alias=$2
      shift 2
      ;;
    --key-alias=*)
      key_alias=${1#*=}
      [[ -n "$key_alias" ]] || die "--key-alias requires a non-empty value"
      shift
      ;;
    --output)
      need_option_value "$1" "${2-}"
      output_path=$2
      shift 2
      ;;
    --output=*)
      output_path=${1#*=}
      [[ -n "$output_path" ]] || die "--output requires a non-empty value"
      shift
      ;;
    --build-only|--no-install)
      install_apk=false
      shift
      ;;
    --allow-downgrade)
      allow_downgrade=true
      shift
      ;;
    --allow-signer-mismatch)
      allow_signer_mismatch=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      (($# == 0)) || die "unexpected positional arguments: $*"
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

[[ -n "$ref" && "$ref" != -* && "$ref" != *$'\n'* && "$ref" != *$'\r'* ]] ||
  die "invalid Git ref"
[[ -z "$serial" || ("$serial" != *$'\n'* && "$serial" != *$'\r'*) ]] ||
  die "invalid adb serial"
[[ "$adb_port" =~ ^[0-9]{1,5}$ ]] || die "adb port must be an integer between 1 and 65535"
adb_port=$((10#$adb_port))
((adb_port >= 1 && adb_port <= 65535)) || die "adb port must be between 1 and 65535"

for required_command in bash git npm python3 unzip find sort sed awk mktemp sha256sum readlink dirname; do
  command -v "$required_command" >/dev/null 2>&1 || die "required command not found: $required_command"
done
git check-ref-format --allow-onelevel "$ref" >/dev/null 2>&1 ||
  die "ref must be one exact branch, tag, full ref, or commit without revision syntax"
if [[ "$install_apk" == true ]]; then
  command -v adb >/dev/null 2>&1 || die "required command not found: adb"
fi

owner_home=${HOME:-}
if [[ -z "$owner_home" ]] && command -v getent >/dev/null 2>&1; then
  owner_home=$(getent passwd "$(id -u)" | awk -F: 'NR == 1 { print $6 }')
fi

sdk_root=${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}
if [[ -z "$sdk_root" && -n "$owner_home" && -d "$owner_home/Android/Sdk" ]]; then
  sdk_root=$owner_home/Android/Sdk
fi
[[ -n "$sdk_root" && -d "$sdk_root/build-tools" ]] ||
  die "set ANDROID_SDK_ROOT or ANDROID_HOME to an installed Android SDK"
sdk_root=$(readlink -f -- "$sdk_root")

java_major_for_home() {
  local candidate=$1
  local version_line
  [[ -x "$candidate/bin/java" ]] || return 1
  version_line=$("$candidate/bin/java" -version 2>&1 | head -n 1) || return 1
  printf '%s\n' "$version_line" |
    sed -nE 's/.* version "([0-9]+)(\.[^"]*)?".*/\1/p'
}

jdk_home=${JAVA_HOME:-}
if [[ -n "$jdk_home" ]]; then
  [[ -x "$jdk_home/bin/java" ]] || die "JAVA_HOME does not contain a Java runtime"
  jdk_home=$(readlink -f -- "$jdk_home")
else
  default_java=$(command -v java 2>/dev/null || true)
  default_jdk_home=
  if [[ -n "$default_java" ]]; then
    resolved_java=$(readlink -f -- "$default_java")
    default_jdk_home=$(dirname "$(dirname "$resolved_java")")
  fi
  for candidate_jdk in \
    "$default_jdk_home" \
    /usr/lib/jvm/java-21-openjdk \
    /usr/lib/jvm/java-21-openjdk-amd64 \
    /usr/lib/jvm/temurin-21-jdk-amd64; do
    [[ -n "$candidate_jdk" && -x "$candidate_jdk/bin/java" ]] || continue
    if [[ "$(java_major_for_home "$candidate_jdk")" == "21" ]]; then
      jdk_home=$(readlink -f -- "$candidate_jdk")
      break
    fi
  done
fi
[[ -n "$jdk_home" && "$(java_major_for_home "$jdk_home")" == "21" ]] ||
  die "Hermes G2 builds require JDK 21; set JAVA_HOME to a JDK 21 installation"

build_tools_dir=$sdk_root/build-tools/$ANDROID_BUILD_TOOLS_VERSION
[[ -n "$build_tools_dir" && -d "$build_tools_dir" ]] ||
  die "pinned Android SDK build-tools $ANDROID_BUILD_TOOLS_VERSION not found"
ndk_dir=$sdk_root/ndk/$ANDROID_NDK_VERSION
[[ -d "$ndk_dir" ]] || die "pinned Android NDK $ANDROID_NDK_VERSION not found"

JAVA_HOME=$jdk_home
ANDROID_HOME=$sdk_root
ANDROID_SDK_ROOT=$sdk_root
ANDROID_NDK_HOME=$ndk_dir
PATH=$JAVA_HOME/bin:$PATH
export JAVA_HOME ANDROID_HOME ANDROID_SDK_ROOT ANDROID_NDK_HOME PATH

zipalign=$build_tools_dir/zipalign
apksigner=$build_tools_dir/apksigner
aapt=$build_tools_dir/aapt
for android_tool in "$zipalign" "$apksigner" "$aapt"; do
  [[ -x "$android_tool" ]] || die "required Android build tool not found: $android_tool"
done

using_default_debug_keystore=false
if [[ -z "$keystore" ]]; then
  default_debug_keystore=${owner_home:+$owner_home/.android/debug.keystore}
  [[ -n "$default_debug_keystore" && -f "$default_debug_keystore" ]] ||
    die "configure a keystore; no owner debug keystore exists"
  keystore=$default_debug_keystore
  using_default_debug_keystore=true
fi
if [[ "$keystore" != /* ]]; then
  keystore=$invocation_dir/$keystore
fi
[[ -f "$keystore" ]] || die "keystore not found: $keystore"
keystore=$(readlink -f -- "$keystore")

if [[ "$using_default_debug_keystore" == true ]]; then
  [[ -n "$key_alias" ]] || key_alias=androiddebugkey
  keystore_password=${input_keystore_password:-android}
  key_password=${input_key_password:-$keystore_password}
else
  [[ -n "$key_alias" ]] || die "set --key-alias or HERMES_KEY_ALIAS for a custom keystore"
  [[ -n "$input_keystore_password" ]] ||
    die "set HERMES_KEYSTORE_PASSWORD for a custom keystore"
  keystore_password=$input_keystore_password
  key_password=${input_key_password:-$keystore_password}
fi
input_keystore_password=
input_key_password=

cleanup() {
  if [[ -n "$temporary_root" && -d "$temporary_root" &&
        "$temporary_root" == "${TMPDIR:-/tmp}"/hermes-g2-github.* ]]; then
    rm -rf -- "$temporary_root"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

temporary_root=$(mktemp -d "${TMPDIR:-/tmp}/hermes-g2-github.XXXXXXXX")
source_checkout=$temporary_root/source
mkdir -p "$source_checkout"

note "Fetching $GITHUB_REPOSITORY ref $ref"
git -C "$source_checkout" init --quiet
git -C "$source_checkout" remote add origin "$GITHUB_REPOSITORY"
git -C "$source_checkout" fetch --quiet --depth=1 --no-tags origin "$ref"
git -C "$source_checkout" checkout --quiet --detach FETCH_HEAD
resolved_commit=$(git -C "$source_checkout" rev-parse --verify HEAD^{commit})
short_commit=${resolved_commit:0:12}
[[ -z "$(git -C "$source_checkout" status --porcelain --untracked-files=no)" ]] ||
  die "fresh GitHub checkout is unexpectedly dirty"
note "Building GitHub commit $resolved_commit"

(
  cd "$source_checkout"
  npm ci
  npm run verify:release-unsigned
)

mapfile -t unsigned_apks < <(
  find "$source_checkout/platforms/android/app/build/outputs/apk/release" \
    -maxdepth 1 -type f -name '*-release-unsigned.apk' -print | sort
)
((${#unsigned_apks[@]} == 1)) ||
  die "expected exactly one unsigned release APK, found ${#unsigned_apks[@]}"
unsigned_apk=${unsigned_apks[0]}
(
  cd "$source_checkout"
  env \
    ANDROID_HOME="$sdk_root" \
    ANDROID_SDK_ROOT="$sdk_root" \
    ANDROID_NDK_HOME="$ndk_dir" \
    JAVA_HOME="$jdk_home" \
    HERMES_SIGNING_MODE=unsigned \
    HERMES_ARTIFACT_VARIANT=release \
    bash scripts/verify-release-artifacts.sh "$unsigned_apk"
)
if "$apksigner" verify "$unsigned_apk" >/dev/null 2>&1; then
  die "positively verified unsigned release is unexpectedly accepted as signed"
fi

aligned_apk=$temporary_root/hermes-g2-aligned-unsigned.apk
signed_apk=$temporary_root/hermes-g2-signed.apk
"$zipalign" -f -P 16 4 "$unsigned_apk" "$aligned_apk"
export HERMES_APKSIGNER_STORE_PASSWORD=$keystore_password
export HERMES_APKSIGNER_KEY_PASSWORD=$key_password
"$apksigner" sign \
  --debuggable-apk-permitted false \
  --ks "$keystore" \
  --ks-key-alias "$key_alias" \
  --ks-pass env:HERMES_APKSIGNER_STORE_PASSWORD \
  --key-pass env:HERMES_APKSIGNER_KEY_PASSWORD \
  --out "$signed_apk" \
  "$aligned_apk"
unset HERMES_APKSIGNER_STORE_PASSWORD HERMES_APKSIGNER_KEY_PASSWORD
keystore_password=
key_password=

certificate_sha256() {
  local apk=$1
  local report
  local -a digests=()
  report=$("$apksigner" verify --verbose --print-certs "$apk") || return 1
  mapfile -t digests < <(
    printf '%s\n' "$report" |
      sed -nE 's/^Signer #[0-9]+ certificate SHA-256 digest: ([[:xdigit:]]{64})$/\1/p' |
      tr '[:upper:]' '[:lower:]' |
      sort -u
  )
  ((${#digests[@]} == 1)) || return 1
  printf '%s\n' "${digests[0]}"
}

apk_identity() {
  local apk=$1
  local badging
  badging=$("$aapt" dump badging "$apk") || return 1
  printf '%s\n' "$badging" |
    sed -nE "s/^package: name='([^']+)' versionCode='([0-9]+)' versionName='([^']+)'.*$/\\1|\\2|\\3/p" |
    head -n 1
}

"$zipalign" -c -P 16 4 "$signed_apk" >/dev/null
new_certificate=$(certificate_sha256 "$signed_apk") || die "signed APK certificate verification failed"
new_identity=$(apk_identity "$signed_apk") || die "could not read signed APK package identity"
IFS='|' read -r new_package new_version_code new_version_name <<<"$new_identity"
[[ "$new_package" == "$EXPECTED_PACKAGE" ]] ||
  die "unexpected package in signed APK: $new_package"
[[ "$new_version_code" =~ ^[0-9]+$ && -n "$new_version_name" ]] ||
  die "signed APK has an invalid version"

source_version_code=$(sed -nE \
  's/^[[:space:]]*versionCode[[:space:]]+([0-9]+).*$/\1/p' \
  "$source_checkout/App_Resources/Android/app.gradle" | tail -n 1)
source_version_name=$(sed -nE \
  's/^[[:space:]]*versionName[[:space:]]+"([^"]+)".*$/\1/p' \
  "$source_checkout/App_Resources/Android/app.gradle" | tail -n 1)
[[ -n "$source_version_code" && -n "$source_version_name" ]] ||
  die "could not read the source release version"
[[ "$new_version_code" == "$source_version_code" &&
   "$new_version_name" == "$source_version_name" ]] ||
  die "signed APK version does not match the fetched source"

if [[ -z "$output_path" ]]; then
  output_path=$invocation_dir/build/apk-from-github/hermes-g2-$short_commit-signed.apk
elif [[ "$output_path" != /* ]]; then
  output_path=$invocation_dir/$output_path
fi
output_path=$(readlink -m -- "$output_path")
[[ "$output_path" != "$keystore" ]] || die "APK output path must not overwrite the signing keystore"
[[ ! -e "$output_path" || -f "$output_path" ]] || die "APK output must be a regular file path"
if [[ -e "$output_path" && "$output_path" -ef "$keystore" ]]; then
  die "APK output must not alias the signing keystore"
fi
mkdir -p "$(dirname "$output_path")"
cp -- "$signed_apk" "$output_path"
chmod 0644 "$output_path"

note "Verified package $new_package $new_version_name ($new_version_code)"
note "Signing certificate SHA-256: $new_certificate"
note "Signed APK: $output_path"
note "APK SHA-256: $(sha256sum "$output_path" | awk '{print $1}')"

if [[ "$install_apk" != true ]]; then
  note "Build-only mode complete; adb was not contacted."
  exit 0
fi

adb_base=(adb -P "$adb_port")
if [[ -z "$serial" ]]; then
  mapfile -t connected_serials < <(
    "${adb_base[@]}" devices |
      awk 'NR > 1 && $2 == "device" { print $1 }'
  )
  ((${#connected_serials[@]} == 1)) ||
    die "select one authorised device with --serial (found ${#connected_serials[@]})"
  serial=${connected_serials[0]}
fi
adb_device=("${adb_base[@]}" -s "$serial")
[[ "$("${adb_device[@]}" get-state 2>/dev/null)" == "device" ]] ||
  die "adb device is unavailable or unauthorised: $serial"

pull_installed_base() {
  local destination=$1
  local package_listing
  local paths
  local base_path
  if ! package_listing=$(
    "${adb_device[@]}" shell pm list packages "$EXPECTED_PACKAGE" 2>/dev/null | tr -d '\r'
  ); then
    return 2
  fi
  if ! printf '%s\n' "$package_listing" |
    awk -v expected="package:$EXPECTED_PACKAGE" '$0 == expected { found = 1 } END { exit !found }'; then
    return 1
  fi
  if ! paths=$("${adb_device[@]}" shell pm path "$EXPECTED_PACKAGE" 2>/dev/null | tr -d '\r'); then
    return 2
  fi
  [[ -n "$paths" ]] || return 2
  base_path=$(printf '%s\n' "$paths" | sed -n 's/^package://p' | awk '/\/base\.apk$/ { print; exit }')
  [[ -n "$base_path" ]] || return 2
  "${adb_device[@]}" pull "$base_path" "$destination" >/dev/null || return 2
  [[ -s "$destination" ]] || return 2
}

installed_before=$temporary_root/installed-before.apk
install_args=(install -r)
installed_pull_status=0
pull_installed_base "$installed_before" || installed_pull_status=$?
if ((installed_pull_status == 0)); then
  installed_certificate=$(certificate_sha256 "$installed_before") ||
    die "could not verify the installed APK signer"
  installed_identity=$(apk_identity "$installed_before") ||
    die "could not read the installed APK version"
  IFS='|' read -r installed_package installed_version_code installed_version_name <<<"$installed_identity"
  [[ "$installed_package" == "$EXPECTED_PACKAGE" &&
     "$installed_version_code" =~ ^[0-9]+$ ]] ||
    die "installed APK identity is invalid"

  if [[ "$installed_certificate" != "$new_certificate" ]]; then
    if [[ "$allow_signer_mismatch" != true ]]; then
      die "signing certificate differs from the installed app; refusing a data-risking update"
    fi
    note "WARNING: signer mismatch explicitly allowed; Android may still reject the update."
  fi

  if ((10#$new_version_code < 10#$installed_version_code)); then
    if [[ "$allow_downgrade" != true ]]; then
      die "versionCode $new_version_code is older than installed $installed_version_code; use --allow-downgrade explicitly"
    fi
    install_args+=(-d)
    note "WARNING: version downgrade explicitly allowed."
  fi
  note "Installed version before update: $installed_version_name ($installed_version_code)"
elif ((installed_pull_status == 1)); then
  note "No existing $EXPECTED_PACKAGE installation found; signer and downgrade comparison skipped."
else
  die "could not determine or read the existing app; refusing an unchecked update"
fi

install_args+=("$output_path")
note "Installing with adb install -r; no uninstall or data-clear operation is used."
"${adb_device[@]}" "${install_args[@]}"

installed_after=$temporary_root/installed-after.apk
pull_installed_base "$installed_after" || die "installed APK could not be read back"
after_certificate=$(certificate_sha256 "$installed_after") ||
  die "installed APK signature could not be verified after update"
after_identity=$(apk_identity "$installed_after") ||
  die "installed APK identity could not be read after update"
IFS='|' read -r after_package after_version_code after_version_name <<<"$after_identity"
[[ "$after_package" == "$new_package" &&
   "$after_version_code" == "$new_version_code" &&
   "$after_version_name" == "$new_version_name" &&
   "$after_certificate" == "$new_certificate" ]] ||
  die "installed APK does not match the verified build"

note "Installed and verified $after_package $after_version_name ($after_version_code) on $serial."
