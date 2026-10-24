# @generated sha256:28fb83906ddd44d32cdd516e1f4d1cea713612a93391c207d3bf27686642ef2a
MAX_WINDOWS=8
box_port_for() {
  local kind="$1" display="$2" base
  case "$display" in ''|*[!0-9]*) return 2 ;; esac
  if (( display < 1 || display > MAX_WINDOWS )); then return 2; fi
  case "$kind" in
    vnc) base=5900 ;;
    exec) base=14000 ;;
    pty) base=13600 ;;
    cdp) base=9222 ;;
    externalView) base=9400 ;;
    *) return 2 ;;
  esac
  printf '%s\n' "$((base + display))"
}
