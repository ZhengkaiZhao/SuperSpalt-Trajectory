ensure_superspalt_node() {
    autoload -Uz is-at-least
    local minimum_node="22.0.0"
    local recommended_node="$(< .nvmrc)"
    local node_exe="$(command -v node 2>/dev/null || true)"
    local node_version=""
    local needs_node=""
    local answer=""

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
        read -r "answer?Install/upgrade Node.js 24 LTS with Homebrew now? [Y/n] "
        if [[ -z "$answer" || "$answer" == [Yy] ]]; then
            if ! command -v brew >/dev/null 2>&1; then
                echo "[ERROR] Homebrew is unavailable. Install Node.js 24 LTS from https://nodejs.org/en/download"
                return 1
            fi
            if brew list --versions node@24 >/dev/null 2>&1; then
                brew upgrade node@24 || true
            else
                brew install node@24
            fi
            node_exe="$(brew --prefix node@24)/bin/node"
            node_version="$("$node_exe" -p 'process.versions.node')"
        elif [[ "$needs_node" == "required" ]]; then
            echo "[ERROR] Node.js $minimum_node or newer is required."
            return 1
        fi
    fi

    export SUPERSPLAT_NODE_EXE="$node_exe"
    echo "Node ready : $node_version"
}
