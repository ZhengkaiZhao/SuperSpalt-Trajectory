superspalt_find_brew() {
    local brew_exe="$(command -v brew 2>/dev/null || true)"
    local candidate=""

    if [[ -n "$brew_exe" && -x "$brew_exe" ]]; then
        print -r -- "$brew_exe"
        return 0
    fi

    # Finder-launched .command files often receive a minimal PATH. Probe the
    # standard Apple Silicon and Intel Homebrew locations explicitly.
    for candidate in /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [[ -x "$candidate" ]]; then
            print -r -- "$candidate"
            return 0
        fi
    done

    return 1
}

ensure_superspalt_node() {
    autoload -Uz is-at-least
    local minimum_node="22.0.0"
    local recommended_node="$(< .nvmrc)"
    local recommended_major="${recommended_node%%.*}"
    local node_formula="node@${recommended_major}"
    local node_exe="$(command -v node 2>/dev/null || true)"
    local brew_exe="$(superspalt_find_brew || true)"
    local node_version=""
    local needs_node=""
    local answer=""

    # Reuse a keg-only Homebrew Node installation even when Finder did not put
    # it on PATH. This avoids an unnecessary install prompt on a healthy Mac.
    if [[ -z "$node_exe" && -n "$brew_exe" ]] && "$brew_exe" list --versions "$node_formula" >/dev/null 2>&1; then
        node_exe="$("$brew_exe" --prefix "$node_formula")/bin/node"
    fi

    if [[ -n "$node_exe" ]]; then
        node_version="$("$node_exe" -p 'process.versions.node')"
    fi

    echo "============================================================"
    echo " SuperSpalt Trajectory - Node.js environment check"
    echo "============================================================"
    echo "Installed  : ${node_version:-not found}"
    echo "Minimum    : $minimum_node"
    echo "Recommended: $recommended_node LTS"

    if [[ -z "$node_version" ]] || ! is-at-least "$minimum_node" "$node_version"; then
        needs_node="required"
    elif ! is-at-least "$recommended_node" "$node_version"; then
        needs_node="recommended"
    fi

    if [[ -n "$needs_node" ]]; then
        read -r "answer?Install/upgrade Node.js ${recommended_major} LTS with Homebrew now? [Y/n] "
        if [[ -z "$answer" || "$answer" == [Yy] ]]; then
            if [[ -z "$brew_exe" ]]; then
                echo "[ERROR] Homebrew is unavailable. Install Node.js ${recommended_major} LTS from https://nodejs.org/en/download"
                return 1
            fi
            if "$brew_exe" list --versions "$node_formula" >/dev/null 2>&1; then
                if ! "$brew_exe" upgrade "$node_formula"; then
                    echo "[ERROR] Homebrew could not upgrade $node_formula."
                    return 1
                fi
            else
                if ! "$brew_exe" install "$node_formula"; then
                    echo "[ERROR] Homebrew could not install $node_formula."
                    return 1
                fi
            fi
            node_exe="$("$brew_exe" --prefix "$node_formula")/bin/node"
            if [[ ! -x "$node_exe" ]]; then
                echo "[ERROR] Homebrew completed but $node_exe is unavailable."
                return 1
            fi
            node_version="$("$node_exe" -p 'process.versions.node')"
        elif [[ "$needs_node" == "required" ]]; then
            echo "[ERROR] Node.js $minimum_node or newer is required."
            return 1
        fi
    fi

    if [[ -z "$node_exe" || -z "$node_version" ]] || ! is-at-least "$minimum_node" "$node_version"; then
        echo "[ERROR] Node.js $minimum_node or newer is required."
        return 1
    fi

    export SUPERSPLAT_NODE_EXE="$node_exe"
    echo "Node ready : $node_version"
}
