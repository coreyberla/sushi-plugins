#!/usr/bin/env bash
# Installs sushi plugins from src/. Each plugin is a top-level .js file plus
# an optional directory of the same name holding its helpers.

set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 [options] plugin...
       $0 [options] --all

Installs the named plugins from src/ (e.g. "epub").

Options:
  --all           Act on every plugin in src/
  --copy          Copy files instead of symlinking them
  --dest DIR      Install into DIR instead of the user plugin directory
  --uninstall     Remove the plugins instead of installing them
  --force         Replace or remove files this script didn't install
  -l, --list      List available plugins
  -h, --help      Show this help

Restart sushi afterwards, e.g. with: pkill -f org.gnome.NautilusPreviewer
EOF
}

src_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/src"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/sushi/plugins-1"
mode=link
action=install
all=false
force=false
plugins=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --copy) mode=copy ;;
        --dest) dest="${2:?--dest needs a directory}"; shift ;;
        --dest=*) dest="${1#--dest=}" ;;
        --all) all=true ;;
        --uninstall) action=uninstall ;;
        --force) force=true ;;
        -l|--list) action=list ;;
        -h|--help) usage; exit 0 ;;
        -*) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
        *) plugins+=("${1%.js}") ;;
    esac
    shift
done

[[ $action == list ]] && all=true

if $all; then
    plugins=()
    for file in "$src_dir"/*.js; do
        plugins+=("$(basename "$file" .js)")
    done
elif [[ ${#plugins[@]} -eq 0 ]]; then
    echo "No plugins given; name some or pass --all. Available:" >&2
    for file in "$src_dir"/*.js; do
        echo "  $(basename "$file" .js)" >&2
    done
    exit 1
fi

for name in "${plugins[@]}"; do
    if [[ ! -f "$src_dir/$name.js" ]]; then
        echo "No such plugin: $name" >&2
        exit 1
    fi
done

if [[ $action == list ]]; then
    printf '%s\n' "${plugins[@]}"
    exit 0
fi

# Each install leaves a marker listing the entries it created, so later runs
# only replace or remove files this script put there. Copies also get a
# checksum file, so edits made after installing aren't thrown away.
marker() { echo "$dest/.$1.installed"; }
checksums() { echo "$dest/.$1.sha256"; }

# Entries in src/ for a plugin
source_entries() {
    echo "$1.js"
    [[ -d "$src_dir/$1" ]] && echo "$1"
    return 0
}

# Entries a previous install recorded for a plugin
installed_entries() {
    [[ -f "$(marker "$1")" ]] && cat "$(marker "$1")"
    return 0
}

# Checksum lines recorded for an entry, i.e. for it and anything inside it
recorded_sums() {
    local sums
    sums="$(checksums "$1")"
    [[ -f "$sums" ]] || return 0
    # sha256sum lines are a 64 character hash, two separator characters, then the path
    awk -v e="$2" '{ p = substr($0, 67) } p == e || index(p, e "/") == 1' "$sums"
}

# Whether an existing entry in $dest can be replaced or removed:
# 0 if it's ours and unchanged, 1 if we didn't install it, 2 if it was modified
check_entry() {
    local name="$1" entry="$2" recorded actual
    [[ -L "$dest/$entry" && "$(readlink "$dest/$entry")" == "$src_dir/$entry" ]] && return 0
    installed_entries "$name" | grep -qxF -- "$entry" || return 1
    # A symlink we created holds nothing that could be lost
    [[ -L "$dest/$entry" ]] && return 0

    recorded="$(recorded_sums "$name" "$entry")"
    [[ -n "$recorded" ]] || return 2
    actual="$(cd "$dest" && find "$entry" -type f | sort)"
    [[ "$actual" == "$(cut -c67- <<<"$recorded" | sort)" ]] || return 2
    (cd "$dest" && sha256sum --status -c - <<<"$recorded") || return 2
}

# Check everything before changing anything, so a conflict doesn't leave a
# half-installed plugin behind
foreign=()
modified=()
if ! $force; then
    for name in "${plugins[@]}"; do
        while read -r entry; do
            [[ -e "$dest/$entry" || -L "$dest/$entry" ]] || continue
            status=0
            check_entry "$name" "$entry" || status=$?
            case $status in
                1) foreign+=("$dest/$entry") ;;
                2) modified+=("$dest/$entry") ;;
            esac
        done < <({ installed_entries "$name"; source_entries "$name"; } | sort -u)
    done
fi
if [[ ${#foreign[@]} -gt 0 ]]; then
    echo "Not touching files this script didn't install:" >&2
    printf '  %s\n' "${foreign[@]}" >&2
fi
if [[ ${#modified[@]} -gt 0 ]]; then
    echo "Not touching files that changed since they were installed:" >&2
    printf '  %s\n' "${modified[@]}" >&2
fi
if [[ ${#foreign[@]} -gt 0 || ${#modified[@]} -gt 0 ]]; then
    echo "Move them out of the way, or pass --force to $action anyway." >&2
    exit 1
fi

mkdir -p "$dest"

for name in "${plugins[@]}"; do
    # Also clean up entries an older version of the plugin installed
    mapfile -t old < <(installed_entries "$name")
    mapfile -t new < <(source_entries "$name")
    if [[ $action == uninstall && ${#old[@]} -eq 0 ]] &&
        ! check_entry "$name" "$name.js" && ! $force; then
        echo "$name is not installed in $dest"
        continue
    fi

    for entry in "${old[@]}" "${new[@]}"; do
        rm -rf -- "${dest:?}/$entry"
    done
    rm -f -- "$(marker "$name")" "$(checksums "$name")"

    if [[ $action == uninstall ]]; then
        echo "Removed $name from $dest"
        continue
    fi

    for entry in "${new[@]}"; do
        if [[ $mode == copy ]]; then
            cp -r -- "$src_dir/$entry" "$dest/$entry"
        else
            ln -s -- "$src_dir/$entry" "$dest/$entry"
        fi
    done
    if [[ $mode == copy ]]; then
        (cd "$dest" && find "${new[@]}" -type f -print0 | sort -z | xargs -0 sha256sum) \
            > "$(checksums "$name")"
    fi
    printf '%s\n' "${new[@]}" > "$(marker "$name")"
    echo "Installed $name to $dest"
done
