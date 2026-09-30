#!/usr/bin/env bash
# kanban-hub 部署管理脚本：安装、启停、配置、自检、卸载（单文件，bash 3.2+）
#
# 安装：curl -fsSL https://raw.githubusercontent.com/LanceLRQ/kanban-hub/main/deploy/kanban-hub.sh | bash
# 管理：bash kanban-hub.sh [命令] [--dir 目录]
#
# KH_SOURCE_ONLY=1 时只定义函数、不执行 main（供测试 source）。

# 以 sh 调用时改用 bash 重新执行。这几行必须保持 POSIX sh 兼容
if [ -z "${BASH_VERSION:-}" ]; then
  if [ -f "$0" ] && command -v bash >/dev/null 2>&1; then exec bash "$0" "$@"; fi
  echo "kanban-hub.sh 需要用 bash 运行" >&2
  exit 1
fi

# ===== 1. 常量与可覆盖路径 =====

# 脚本自身版本与内嵌模板版本相互独立：改模板只需后者 +1
KH_SCRIPT_VERSION="0.1.0"
KH_TEMPLATE_VERSION=1
KH_HUB_IMAGE="lancelrq/kanban-hub"
# 本地构建镜像固定用这个名:tag，不随仓库/机器变化
KH_DEV_IMAGE="kanban-hub"
KH_DEV_TAG="dev"
KH_CONTAINER="kanban-hub"
KH_DEFAULT_HOME="/opt/kanban-hub"
KH_DEFAULT_PORT=28970
# .env 缺了这些键容器起不来（compose 模板里有对应的 :? 强制校验）
KH_ENV_REQUIRED="KH_VERSION KH_ADMIN_PASSWORD"

# 以下路径与命令均可被环境变量覆盖：测试注入桩，或特殊环境（非常规安装位置）
KH_DOCKER="${KH_DOCKER_BIN:-docker}"
KH_SUDO="${KH_SUDO:-sudo}"
KH_DOCKER_SOCK="${KH_DOCKER_SOCK:-/var/run/docker.sock}"
KH_PROC="${KH_PROC:-/proc}"
KH_ETC="${KH_ETC:-/etc}"
KH_TTY="${KH_TTY:-/dev/tty}"
# 交互输入源只在这里打开一次，之后所有读都走这个 fd；编号写死是因为 bash 3.2 没有
# `exec {var}<…` 的自动分配。`-` 表示沿用已继承的 stdin（测试用）。打不开就让 fd 空着，
# 交互入口（ui_plain / cmd_install）照常探测得到并给出提示。
#
# 为什么不逐次 `read <"$KH_TTY"` 重开：那在 Linux 上对管道不成立。stdin 是管道时
# /dev/stdin 指向 /proc/self/fd/0 → pipe:[N]，写端一关（curl 的输出喂完立刻就关）再 open
# 直接 ENXIO；macOS 的 /dev/stdin 是 fd 0 的克隆设备才看不出问题。
#
# 花括号组包住 exec 才能吞掉 open 失败的报错：重定向按从左到右处理，写成
# `exec 9<… 2>/dev/null` 时 9< 已经失败并打印，2> 再关也来不及
KH_TTY_FD=9
if [ "$KH_TTY" = "-" ]; then
  exec 9<&0
else
  { exec 9<"$KH_TTY"; } 2>/dev/null || true
fi
KH_RAW_BASE="${KH_RAW_BASE:-https://raw.githubusercontent.com/LanceLRQ/kanban-hub}"
KH_HUB_TAGS_URL="${KH_HUB_TAGS_URL:-https://hub.docker.com/v2/repositories/lancelrq/kanban-hub/tags?page_size=100}"
# 就绪探测轮询上限（秒）
KH_READY_TIMEOUT="${KH_READY_TIMEOUT:-60}"

# 脚本自身路径：curl | bash 时为空（读不到自身文件，安装时改为按版本重新下载）
KH_SELF="${BASH_SOURCE[0]:-}"

# 安装目录（运行期变量）。可为环境变量 KH_HOME 预设——home_candidate 会先读它；
# 变量名与环境变量同名是有意的：读取发生在任何赋值之前
OPT_DIR=""
OPT_FOLLOW=0
# upgrade 的目标版本与本地重建的仓库路径（--to / --repo）；restore 的备份文件名（位置参数）
OPT_TO=""
OPT_REPO=""
OPT_RESTORE_NAME=""
CMD=""

# ===== 2. 输出 =====

# 颜色只在 stderr 是终端且未设 NO_COLOR 时启用
kh_color_on() { [ -z "${NO_COLOR:-}" ] && [ -t 2 ]; }
kh_sgr() { if kh_color_on; then printf '\033[%sm' "$1"; fi; }

# 提示信息一律写 stderr：stdout 留给可被 $(...) 捕获的函数返回值
info() { printf '%s\n' "$*" >&2; }
ok() { printf '%s✔%s %s\n' "$(kh_sgr 32)" "$(kh_sgr 0)" "$*" >&2; }
warn() { printf '%s⚠%s %s\n' "$(kh_sgr 33)" "$(kh_sgr 0)" "$*" >&2; }
err() { printf '%s✘%s %s\n' "$(kh_sgr 31)" "$(kh_sgr 0)" "$*" >&2; }

# ===== 3. 通用工具 =====

# 单引号转义，结果可安全拼进 sh 命令行
sh_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

# 转绝对路径：展开 ~、拼 PWD、去掉 /./ 与末尾斜杠（不解析 .. 与符号链接）
abs_path() {
  local p="$1"
  # shellcheck disable=SC2088  # 下面是 case 模式匹配字面量 "~/"，不是期待展开的命令参数，误报；
  # 指令只能放在完整命令（这里是 case）前，放在单个分支前 ShellCheck 会报语法错误
  case "$p" in
    "~") p="$HOME" ;;
    "~/"*) p="$HOME/${p#\~/}" ;;
  esac
  case "$p" in
    /*) ;;
    *) p="$PWD/$p" ;;
  esac
  while :; do
    case "$p" in
      */./*) p="${p%%/./*}/${p#*/./}" ;;
      *) break ;;
    esac
  done
  case "$p" in */.) p="${p%/.}" ;; esac
  [ "$p" = / ] || p="${p%/}"
  printf '%s' "${p:-/}"
}

# path_forbidden 绝对路径 → 0 表示禁止用作安装/删除目标（危险路径），1 表示可用。
# 拒绝空串、根目录、$HOME、含 /../ 片段或以 /.. 收尾（abs_path 不解析 ..，这里兜底）、
# 以及系统/挂载顶层目录本身（精确匹配，/opt/kanban-hub 这类子目录不受影响，唯独 /usr 连
# 子目录一并拒绝——/usr/* 下没有第三方安装该待的地方，不像 /opt 天生就是给第三方软件用的）
path_forbidden() {
  local p="$1"
  case "$p" in
    "" | / | "$HOME" | ..) return 0 ;;
    */../* | */..) return 0 ;;
  esac
  case "$p" in
    /opt | /usr | /usr/* | /home | /root | /etc | /var | /bin | /sbin | /lib | /lib64 | /boot | \
      /srv | /mnt | /media | /data | /tmp | /proc | /sys | /dev | /run)
      return 0
      ;;
  esac
  return 1
}

# 属主 uid:gid（GNU/busybox 用 -c，BSD 用 -f）
stat_owner() {
  stat -c '%u:%g' "$1" 2>/dev/null || stat -f '%u:%g' "$1" 2>/dev/null
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# 随机字母数字串（默认 20 位）
gen_password() {
  LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c "${1:-20}"
}

# KB → 38G / 1.2T 这种写法：≥10 取整，<10 保留一位小数
fmt_kb() {
  awk -v k="$1" 'BEGIN {
    split("K M G T P", u, " "); v = k + 0; i = 1
    while (v >= 1024 && i < 5) { v /= 1024; i++ }
    if (v >= 10 || i == 1) printf "%d%s", v, u[i]; else printf "%.1f%s", v, u[i]
  }'
}

# 路径所在磁盘的剩余空间（KB）；df 失败返回 1
df_avail_kb() {
  df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4; f = 1 } END { exit !f }'
}

# ===== 4. .env / state / 版本 =====

# .env 值的写法：只含安全字符时原样写，否则单引号包裹（compose 对单引号值不做 $ 插值）
env_quote() {
  case "$1" in
    *[!A-Za-z0-9_./:@,+%=-]*) printf "'%s'" "$1" ;;
    *) printf '%s' "$1" ;;
  esac
}

# 单引号包裹无法表达值里的单引号与换行，这两种一律拒绝
env_valid_value() {
  case "$1" in
    *"'"* | *$'\n'*) return 1 ;;
  esac
  return 0
}

# env_get FILE KEY：取最后一次出现的值，去掉包裹引号与未加引号值的行尾注释；缺键返回 1
env_get() {
  local line v
  [ -f "$1" ] || return 1
  line=$(grep "^$2=" "$1" | tail -n 1)
  [ -n "$line" ] || return 1
  v="${line#*=}"
  # 整段值首尾都是同一种引号时，原样剥掉首尾各一个字符——保留内部可能出现的同类引号
  # （比如存 JSON 字符串时转义写出的 \"），不能用「找最靠左引号」的办法，否则会在内部截断。
  # 引号开头但不是这种首尾对称收尾（闭合引号后还跟了空白与行尾注释）时，才退化为剥到
  # 最靠左的同类引号为止；这两类分支必须放在这个先后顺序，前者更精确、要优先匹配
  case "$v" in
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
    \'*) v="${v#\'}"; v="${v%%\'*}" ;;
    \"*) v="${v#\"}"; v="${v%%\"*}" ;;
    *) v="${v%% #*}" ;;
  esac
  printf '%s\n' "$v"
}

# env_set FILE KEY VALUE：原地替换首个同名行并删去其余同名行；缺失则追加。
# 不重排、不动注释与其他变量；写回用 cat > 保留原文件权限与属主
env_set() {
  local f="$1" k="$2" v="$3" line tmp old_umask
  env_valid_value "$v" || return 2
  line="$k=$(env_quote "$v")"
  tmp="$f.tmp.$$"
  # 临时文件可能含密码等敏感值：用 077 的 umask 建它（新文件即 600），
  # 避免默认 umask 下先落一份 644 的明文副本，哪怕转瞬即逝
  old_umask=$(umask)
  umask 077
  if [ -f "$f" ] && grep -q "^$k=" "$f"; then
    KH_LINE="$line" awk -v k="$k=" '
      index($0, k) == 1 { if (!done) { print ENVIRON["KH_LINE"]; done = 1 } next }
      { print }' "$f" >"$tmp" || { rm -f "$tmp"; umask "$old_umask"; return 1; }
  else
    {
      if [ -f "$f" ]; then
        cat "$f"
        [ -z "$(tail -c 1 "$f")" ] || printf '\n'
      fi
      printf '%s\n' "$line"
    } >"$tmp" || { rm -f "$tmp"; umask "$old_umask"; return 1; }
  fi
  umask "$old_umask"
  if [ -f "$f" ]; then
    cat "$tmp" >"$f" && rm -f "$tmp"
  else
    mv "$tmp" "$f"
  fi
}

# env_missing_keys FILE KEY... → 每行一个缺失（或为空）的键；一个都没缺返回 0
env_missing_keys() {
  local f="$1" k rc=0
  shift
  for k in "$@"; do
    if [ -z "$(env_get "$f" "$k")" ]; then
      printf '%s\n' "$k"
      rc=1
    fi
  done
  return "$rc"
}

state_file() { printf '%s/.kanban-hub-state' "$KH_HOME"; }
state_get() { env_get "$(state_file)" "$1"; }
state_set() { env_set "$(state_file)" "$1" "$2"; }

_num_cmp() {
  if [ "$1" -gt "$2" ]; then echo 1; elif [ "$1" -lt "$2" ]; then echo -1; else echo 0; fi
}

# ver_cmp A B → 1 / 0 / -1。X.Y.Z 逐段数值比较；主体相同时预发布低于正式版，预发布之间按字典序
ver_cmp() {
  local a="${1#v}" b="${2#v}" ap="" bp="" r
  local a1 a2 a3 b1 b2 b3
  case "$a" in *-*) ap="${a#*-}"; a="${a%%-*}" ;; esac
  case "$b" in *-*) bp="${b#*-}"; b="${b%%-*}" ;; esac
  # 逐段剥离：缺段（如 "0.1"）时剩余段为空，下面统一补 0
  a1="${a%%.*}"; a="${a#"$a1"}"; a="${a#.}"; a2="${a%%.*}"; a="${a#"$a2"}"; a="${a#.}"; a3="${a%%.*}"
  b1="${b%%.*}"; b="${b#"$b1"}"; b="${b#.}"; b2="${b%%.*}"; b="${b#"$b2"}"; b="${b#.}"; b3="${b%%.*}"
  for r in a1 a2 a3 b1 b2 b3; do
    eval "$r=\${$r%%[!0-9]*}; $r=\${$r:-0}"
  done
  r=$(_num_cmp "$a1" "$b1"); [ "$r" = 0 ] || { echo "$r"; return; }
  r=$(_num_cmp "$a2" "$b2"); [ "$r" = 0 ] || { echo "$r"; return; }
  r=$(_num_cmp "$a3" "$b3"); [ "$r" = 0 ] || { echo "$r"; return; }
  if [ "$ap" = "$bp" ]; then
    echo 0
  elif [ -z "$ap" ]; then
    echo 1
  elif [ -z "$bp" ]; then
    echo -1
  elif [ "$(printf '%s\n%s\n' "$ap" "$bp" | sort | head -n 1)" = "$ap" ]; then
    echo -1
  else
    echo 1
  fi
}

# stdin 每行一个版本 → 输出最大的正式版（X.Y.Z）；一个都没有返回 1
ver_latest_stable() {
  local best="" v
  while IFS= read -r v; do
    v="${v#v}"
    printf '%s' "$v" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || continue
    if [ -z "$best" ] || [ "$(ver_cmp "$v" "$best")" = 1 ]; then best="$v"; fi
  done
  [ -n "$best" ] || return 1
  printf '%s\n' "$best"
}

# Docker Hub tags API 的 JSON（stdin）→ 每行一个 tag 名
hub_tags_parse() {
  grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*"\([^"]*\)"$/\1/'
}

# 查询 Docker Hub 上的最大正式版本（升级流程用）；网络失败返回 1
fetch_latest_version() {
  local tmp v=""
  tmp=$(mktemp 2>/dev/null) || return 1
  if download_to "$KH_HUB_TAGS_URL" "$tmp" "${1:-10}"; then
    v=$(hub_tags_parse <"$tmp" | ver_latest_stable)
  fi
  rm -f "$tmp"
  [ -n "$v" ] || return 1
  printf '%s\n' "$v"
}

# 目标版本格式：X.Y.Z 或 X.Y.Z-预发布（预发布段为字母数字加点），upgrade --to 的入参校验。
# 不校验的话畸形值会被 ver_cmp 当 0.0.0 比较，最后走到 raw 下载 404 才报错，报因失真
valid_version() {
  printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$'
}

# ===== 5. 端口探测 =====

# ss -tln / netstat -tln 的输出（stdin）里是否有该端口在监听：两者第 4 列都是「本地地址:端口」
listen_table_has_port() {
  awk -v p="$1" '{ n = split($4, a, ":"); if (a[n] == p) f = 1 } END { exit !f }'
}

# proc_tcp_has_port PORT FILE...：/proc/net/tcp{,6} 第 2 列本地地址末尾是 :十六进制端口，第 4 列 0A 为 LISTEN
proc_tcp_has_port() {
  local hex f
  hex=$(printf '%04X' "$1")
  shift
  for f in "$@"; do
    [ -r "$f" ] || continue
    awk -v h=":$hex" 'NR > 1 && $4 == "0A" && substr($2, length($2) - 4) == h { f = 1 } END { exit !f }' "$f" && return 0
  done
  return 1
}

# 依次尝试 ss / netstat / /proc，三条路总有一条走得通
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -tln 2>/dev/null | listen_table_has_port "$1"
    return
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -tln 2>/dev/null | listen_table_has_port "$1"
    return
  fi
  proc_tcp_has_port "$1" "$KH_PROC/net/tcp" "$KH_PROC/net/tcp6"
}

# ===== 6. 环境探测 =====

kh_is_root() { [ "$(id -u)" = 0 ]; }

# 以 root 身份执行：已是 root 直接跑，否则经 sudo；都不行时报错
as_root() {
  if kh_is_root; then
    "$@"
    return
  fi
  if command -v "$KH_SUDO" >/dev/null 2>&1; then
    "$KH_SUDO" "$@"
    return
  fi
  err "该操作需要 root 权限，但当前不是 root 且没有可用的 sudo"
  return 1
}

platform_ok() {
  [ "${KH_SKIP_PLATFORM_CHECK:-}" = 1 ] || [ "$(uname -s)" = Linux ]
}

DK_SUDO=0
DK_STATE=""

# 所有 docker 调用都经它：探测出需要 sudo 时自动加上
dk() {
  if [ "$DK_SUDO" = 1 ]; then
    "$KH_SUDO" "$KH_DOCKER" "$@"
  else
    "$KH_DOCKER" "$@"
  fi
}

# 设置 DK_STATE：ok / missing / daemon_down / no_compose，非 ok 返回 1。
# 不检测 rootless：本服务不挂载 docker.sock，rootless Docker 照样能跑。
# 连不上 daemon 分两种情况：当前用户无权访问 docker.sock（非 root 且不可读写），或服务没起；
# 前者改经 sudo 重试，成功后后续 docker 命令都自动带上 sudo
docker_probe() {
  DK_SUDO=0
  if ! command -v "$KH_DOCKER" >/dev/null 2>&1; then
    DK_STATE=missing
    return 1
  fi
  if ! "$KH_DOCKER" info >/dev/null 2>&1; then
    if [ -S "$KH_DOCKER_SOCK" ] && ! kh_is_root &&
      { [ ! -r "$KH_DOCKER_SOCK" ] || [ ! -w "$KH_DOCKER_SOCK" ]; } &&
      command -v "$KH_SUDO" >/dev/null 2>&1; then
      info "当前用户无权访问 docker.sock（不是 root 也不在 docker 组），接下来的 docker 命令将通过 sudo 执行，可能需要输入密码"
      DK_SUDO=1
      if ! dk info >/dev/null 2>&1; then
        DK_STATE=daemon_down
        return 1
      fi
    else
      DK_STATE=daemon_down
      return 1
    fi
  fi
  if ! dk compose version >/dev/null 2>&1; then
    DK_STATE=no_compose
    return 1
  fi
  DK_STATE=ok
}

docker_probe_message() {
  case "$DK_STATE" in
    missing) printf '未找到 docker 命令。请先安装 Docker Engine：https://docs.docker.com/engine/install/' ;;
    daemon_down) printf '无法连接 Docker daemon。请确认服务已启动（systemctl start docker）' ;;
    no_compose) printf '缺少 docker compose v2 插件：https://docs.docker.com/compose/install/linux/' ;;
    *) printf 'Docker 状态未知' ;;
  esac
}

require_docker() {
  docker_probe && return 0
  err "$(docker_probe_message)"
  return 1
}

# 时区探测：/etc/timezone → timedatectl → /etc/localtime 符号链接，都拿不到按 UTC
detect_timezone() {
  local tz="" link
  [ -f "$KH_ETC/timezone" ] && tz=$(head -n 1 "$KH_ETC/timezone")
  [ -n "$tz" ] || tz=$(timedatectl show -p Timezone --value 2>/dev/null)
  if [ -z "$tz" ] && [ -L "$KH_ETC/localtime" ]; then
    link=$(readlink "$KH_ETC/localtime")
    case "$link" in
      *zoneinfo/*) tz="${link##*zoneinfo/}" ;;
    esac
  fi
  printf '%s' "${tz:-UTC}"
}

lan_ips() {
  local ips
  ips=$(hostname -I 2>/dev/null)
  [ -n "$ips" ] || ips=$(ip -4 -o addr show scope global 2>/dev/null | awk '{ sub(/\/.*/, "", $4); print $4 }')
  # shellcheck disable=SC2086
  printf '%s\n' $ips | grep -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' | head -n 3
}

# access_urls 监听地址 端口 → 每行一个可访问地址
access_urls() {
  local ip
  case "$1" in
    "" | 0.0.0.0)
      for ip in $(lan_ips) 127.0.0.1; do printf 'http://%s:%s\n' "$ip" "$2"; done
      ;;
    *) printf 'http://%s:%s\n' "$1" "$2" ;;
  esac
}

# ===== 7. 终端交互 =====

# 交互输出一律写 stderr；按键一律从 $KH_TTY_FD 读（curl | bash 时 stdin 是管道，不能读 stdin）

# 读一行到指定变量。plain 模式的菜单/输入/确认都经这里，测试里替换交互函数时也调它
ui_read_line() {
  IFS= read -r -u "$KH_TTY_FD" "$1"
}

# 数字菜单模式：显式要求、哑终端、stderr 不是终端、或交互输入源没能打开
ui_plain() {
  [ "${KH_PLAIN:-}" = 1 ] && return 0
  [ "${TERM:-dumb}" = dumb ] && return 0
  [ -t 2 ] || return 0
  { : <&"$KH_TTY_FD"; } 2>/dev/null || return 0
  return 1
}

KH_STTY_SAVED=""

# 进入菜单：关回显与行缓冲、隐藏光标、关自动换行（超长行被终端截断而不是折行，重绘行数才算得准）
ui_raw_on() {
  KH_STTY_SAVED=$(stty -g <&"$KH_TTY_FD" 2>/dev/null)
  stty -echo -icanon <&"$KH_TTY_FD" 2>/dev/null
  printf '\033[?25l\033[?7l' >&2
}

ui_raw_off() {
  if [ -n "$KH_STTY_SAVED" ]; then
    stty "$KH_STTY_SAVED" <&"$KH_TTY_FD" 2>/dev/null
    KH_STTY_SAVED=""
  fi
  printf '\033[?25h\033[?7h' >&2
}

# 退出 / 中断时恢复终端（由 main 挂到 trap）
ui_restore() {
  if [ -n "$KH_STTY_SAVED" ]; then ui_raw_off; fi
}

# 读一个按键 → up / down / left / right / enter / backspace / char:<字符>。
# 方向键是 ESC [ X（或 ESC O X）三字节：读到 ESC 再读两字节。不支持单按 ESC（会阻塞等待后续字节）
ui_read_key() {
  local k rest
  IFS= read -rsn1 -u "$KH_TTY_FD" k || return 1
  case "$k" in
    $'\033')
      IFS= read -rsn2 -u "$KH_TTY_FD" rest
      case "$rest" in
        "[A" | OA) echo up ;;
        "[B" | OB) echo down ;;
        "[C" | OC) echo right ;;
        "[D" | OD) echo left ;;
        *) echo other ;;
      esac
      ;;
    "") echo enter ;;
    $'\177' | $'\010') echo backspace ;;
    *) printf 'char:%s\n' "$k" ;;
  esac
}

# ui_menu 标题 选项... → UI_CHOICE（0 起）；q 或输入结束返回 1。UI_DEFAULT 可预设初始选中项（用后清零）
ui_menu() {
  local title="$1" n sel key i ans
  shift
  n=$#
  sel="${UI_DEFAULT:-0}"
  UI_DEFAULT=0
  if ui_plain; then
    printf '%s\n' "$title" >&2
    i=1
    for ans in "$@"; do
      printf '  %d) %s\n' "$i" "$ans" >&2
      i=$((i + 1))
    done
    while :; do
      printf '%s' "请输入序号（q 返回）：" >&2
      ui_read_line ans || return 1
      case "$ans" in
        q | Q) return 1 ;;
        "" | *[!0-9]*) continue ;;
      esac
      if [ "$ans" -ge 1 ] && [ "$ans" -le "$n" ]; then
        UI_CHOICE=$((ans - 1))
        return 0
      fi
    done
  fi
  ui_raw_on
  printf '%s\n' "$title" >&2
  _ui_menu_draw "$sel" "$@"
  while :; do
    key=$(ui_read_key) || { ui_raw_off; return 1; }
    case "$key" in
      up | char:k) sel=$(((sel + n - 1) % n)) ;;
      down | char:j) sel=$(((sel + 1) % n)) ;;
      enter) break ;;
      char:q | char:Q) ui_raw_off; return 1 ;;
      *) continue ;;
    esac
    printf '\033[%dA' "$((n + 1))" >&2
    _ui_menu_draw "$sel" "$@"
  done
  ui_raw_off
  UI_CHOICE=$sel
}

_ui_menu_draw() {
  local sel="$1" i=0 o
  shift
  for o in "$@"; do
    if [ "$i" = "$sel" ]; then
      printf '\r\033[K  %s▶ %s%s\n' "$(kh_sgr '1;36')" "$o" "$(kh_sgr 0)" >&2
    else
      printf '\r\033[K    %s\n' "$o" >&2
    fi
    i=$((i + 1))
  done
  printf '\r\033[K  %s%s%s\n' "$(kh_sgr 2)" "↑↓ 选择   Enter 确认   q 返回" "$(kh_sgr 0)" >&2
}

# ui_input 提示 默认值 → UI_VALUE。终端模式支持 ←→ 移动光标与退格（按字节计，面向 ASCII 路径与数字）
ui_input() {
  local prompt="$1" def="${2:-}" buf pos key ch
  if ui_plain; then
    if [ -n "$def" ]; then printf '%s [%s]: ' "$prompt" "$def" >&2; else printf '%s: ' "$prompt" >&2; fi
    ui_read_line buf || return 1
    UI_VALUE="${buf:-$def}"
    return 0
  fi
  buf="$def"
  pos=${#buf}
  KH_STTY_SAVED=$(stty -g <&"$KH_TTY_FD" 2>/dev/null)
  stty -echo -icanon <&"$KH_TTY_FD" 2>/dev/null
  while :; do
    printf '\r\033[K%s: %s' "$prompt" "$buf" >&2
    if [ "$pos" -lt "${#buf}" ]; then printf '\033[%dD' "$((${#buf} - pos))" >&2; fi
    key=$(ui_read_key) || { ui_raw_off; return 1; }
    case "$key" in
      enter) break ;;
      left) [ "$pos" -gt 0 ] && pos=$((pos - 1)) ;;
      right) [ "$pos" -lt "${#buf}" ] && pos=$((pos + 1)) ;;
      backspace)
        if [ "$pos" -gt 0 ]; then
          buf="${buf:0:pos-1}${buf:pos}"
          pos=$((pos - 1))
        fi
        ;;
      char:*)
        ch="${key#char:}"
        buf="${buf:0:pos}${ch}${buf:pos}"
        pos=$((pos + 1))
        ;;
    esac
  done
  printf '\n' >&2
  ui_raw_off
  UI_VALUE="$buf"
}

# ui_password 提示 → UI_VALUE（不回显）
ui_password() {
  local p
  printf '%s: ' "$1" >&2
  IFS= read -rs -u "$KH_TTY_FD" p || { printf '\n' >&2; return 1; }
  printf '\n' >&2
  UI_VALUE="$p"
}

_ui_btn() {
  if [ "$2" = 1 ]; then
    printf '%s[ %s ]%s' "$(kh_sgr '1;7')" "$1" "$(kh_sgr 0)"
  else
    printf '  %s  ' "$1"
  fi
}

# ui_confirm 提示 [y|n 默认] → 0 是 / 1 否。终端模式「是 / 否」横排，←→ 切换，也可直接按 y / n
ui_confirm() {
  local prompt="$1" def="${2:-y}" sel key ans
  if ui_plain; then
    while :; do
      if [ "$def" = y ]; then printf '%s (Y/n) ' "$prompt" >&2; else printf '%s (y/N) ' "$prompt" >&2; fi
      ui_read_line ans || return 1
      case "${ans:-$def}" in
        y | Y | yes | YES | 是) return 0 ;;
        n | N | no | NO | 否) return 1 ;;
      esac
    done
  fi
  if [ "$def" = y ]; then sel=0; else sel=1; fi
  ui_raw_on
  while :; do
    printf '\r\033[K%s  %s %s' "$prompt" "$(_ui_btn "是" "$([ "$sel" = 0 ] && echo 1)")" \
      "$(_ui_btn "否" "$([ "$sel" = 1 ] && echo 1)")" >&2
    key=$(ui_read_key) || { ui_raw_off; return 1; }
    case "$key" in
      left | right | char:h | char:l) sel=$((1 - sel)) ;;
      char:y | char:Y) sel=0; break ;;
      char:n | char:N) sel=1; break ;;
      enter) break ;;
    esac
  done
  printf '\n' >&2
  ui_raw_off
  [ "$sel" = 0 ]
}

ui_pause() {
  local _
  printf '%s' "按 Enter 继续…" >&2
  ui_read_line _
}

# ===== 8. 模板与写入 =====

# 内嵌 compose 模板：语义与仓库里的 deploy/docker-compose.yml 一致（无 build 段，用现成镜像）。
# 改模板时把 KH_TEMPLATE_VERSION 加 1；校验和记录在 state 里，doctor 据此发现手改
tpl_compose() {
  cat <<'KH_COMPOSE_EOF'
# kanban-hub 生产部署编排。可变项全部在同目录 .env 里（kanban-hub.sh 生成并维护，也可手改）。
# data/ 与 backups/ 必须先存在再启动：宿主机上不存在的挂载目录会被 Docker 以 root 创建，
# 容器以 PUID 运行后就写不进去（kanban-hub.sh start 会自动建好并对齐属主）。
services:
  kanban-hub:
    image: ${KH_IMAGE:-lancelrq/kanban-hub}:${KH_VERSION:?请在 .env 设置 KH_VERSION}
    container_name: kanban-hub
    restart: unless-stopped
    # 运行身份：容器要写 data 与 backups 两个挂载目录，uid 必须对它们可写
    user: "${PUID:-1000}:${PGID:-1000}"
    # 宿主机端口与监听地址可改；容器内固定监听 28970
    ports:
      - "${KH_BIND:-0.0.0.0}:${KH_PORT:-28970}:28970"
    volumes:
      - ./data:/data
      - ./backups:/backups
    environment:
      - TZ=${TZ:-Asia/Shanghai}
      - UMASK=${UMASK:-022}
      # 管理员密码唯一来源：服务启动时与库内不一致即更新，并让全部登录会话失效
      - KH_ADMIN_PASSWORD=${KH_ADMIN_PASSWORD:?请在 .env 设置 KH_ADMIN_PASSWORD}
      # 接入引导里展示给 agent 的服务地址；留空则从请求的 Host 推断
      - KH_PUBLIC_URL=${KH_PUBLIC_URL:-}
      # 项目多少天没有活动算停滞
      - KH_STALE_DAYS=${KH_STALE_DAYS:-7}
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - "fetch('http://127.0.0.1:28970/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
      interval: 30s
      timeout: 5s
      start_period: 20s
      retries: 3
KH_COMPOSE_EOF
}

# image_ref [.env 文件，默认 $KH_HOME/.env]：镜像名（空 = Hub 镜像）+ 版本号，
# printf 输出「镜像名:版本」（不带换行）——供菜单头、status、doctor 等展示复用
image_ref() {
  local f="${1:-$KH_HOME/.env}" name
  name=$(env_get "$f" KH_IMAGE)
  printf '%s:%s' "${name:-$KH_HUB_IMAGE}" "$(env_get "$f" KH_VERSION)"
}

# image_is_hub [.env 文件，默认 $KH_HOME/.env] → 0 表示镜像名为空或等于 Hub 镜像
image_is_hub() {
  local f="${1:-$KH_HOME/.env}" name
  name=$(env_get "$f" KH_IMAGE)
  [ -z "$name" ] || [ "$name" = "$KH_HUB_IMAGE" ]
}

# image_local_exists <镜像引用> → 0 表示本地已有该镜像
image_local_exists() {
  dk image inspect "$1" >/dev/null 2>&1
}

# repo_detect DIR → 0 表示该目录是 kanban-hub 仓库本体：含 Dockerfile，且 package.json 的
# "name" 字段为 kanban-hub（冒号后允许任意空白，用 grep -E 而非精确字符串匹配）
repo_detect() {
  [ -f "$1/Dockerfile" ] && [ -f "$1/package.json" ] || return 1
  grep -Eq '"name"[[:space:]]*:[[:space:]]*"kanban-hub"' "$1/package.json"
}

# image_build 仓库路径 目标tag：本地构建镜像，透传 Dockerfile 声明的两个代理 ARG
# （HTTP_PROXY/HTTPS_PROXY，优先大写）；构建输出直接透给用户，不吞掉
image_build() {
  local repo="$1" tag="$2" args=() p
  p="${HTTP_PROXY:-$http_proxy}"
  [ -n "$p" ] && args+=(--build-arg "HTTP_PROXY=$p")
  p="${HTTPS_PROXY:-$https_proxy}"
  [ -n "$p" ] && args+=(--build-arg "HTTPS_PROXY=$p")
  if ! dk build "${args[@]}" -t "$tag" "$repo"; then
    err "构建镜像 $tag 失败"
    return 1
  fi
}

# 向导答案（W_*）的默认值；安装与修改配置共用这组变量。
# 运行身份默认当前用户：安装时会建好 data/、backups/ 并对齐属主
wizard_defaults() {
  W_VERSION="$KH_SCRIPT_VERSION"
  W_IMAGE=""
  W_IMAGE_SOURCE=hub
  W_PUID="$(id -u)"
  W_PGID="$(id -g)"
  W_PORT="$KH_DEFAULT_PORT"
  W_BIND=0.0.0.0
  W_PASSWORD=""
  W_PASSWORD_GENERATED=0
  W_TZ=UTC
  W_PUBLIC_URL=""
}

env_header() {
  cat <<'KH_ENV_HEADER_EOF'
# kanban-hub 部署配置（由 kanban-hub.sh 生成）。可以手改：脚本只按键替换，不会删除你的注释与自定义变量
# 含管理员密码，请勿提交到版本库或外传

KH_ENV_HEADER_EOF
}

# 把 W_* 按键写入 .env（原地替换，保留文件其余内容）。
# KH_IMAGE 留空 = 用 compose 模板里的 Hub 镜像默认值；本地构建时写固定名 kanban-hub
write_env_values() {
  local f="$1"
  env_set "$f" KH_VERSION "$W_VERSION" &&
    env_set "$f" KH_IMAGE "$W_IMAGE" &&
    env_set "$f" KH_ADMIN_PASSWORD "$W_PASSWORD" &&
    env_set "$f" PUID "$W_PUID" &&
    env_set "$f" PGID "$W_PGID" &&
    env_set "$f" KH_BIND "$W_BIND" &&
    env_set "$f" KH_PORT "$W_PORT" &&
    env_set "$f" KH_PUBLIC_URL "$W_PUBLIC_URL" &&
    env_set "$f" KH_STALE_DAYS "7" &&
    env_set "$f" TZ "$W_TZ" &&
    env_set "$f" UMASK "022"
}

# 写 compose 模板并把校验和记进 state，doctor 据此判断用户是否手改过
write_templates() {
  tpl_compose >"$KH_HOME/docker-compose.yml" || return 1
  state_set compose_sha256 "$(sha256_file "$KH_HOME/docker-compose.yml")" &&
    state_set template_version "$KH_TEMPLATE_VERSION"
}

# fix_owner 目录 UID GID：属主不符时改（先直接改，没权限再提权）
fix_owner() {
  [ "$(stat_owner "$1")" = "$2:$3" ] && return 0
  chown -R "$2:$3" "$1" 2>/dev/null && return 0
  info "需要 root 权限把 $1 的属主改为 $2:$3"
  as_root chown -R "$2:$3" "$1"
}

# 按 W_* 写出全部部署文件（全新安装与修改后重写共用）。
# state（尤其 installed_at）必须最后写：入口靠「state 文件存在」判定目录已安装，
# 一旦半路失败却已经落了 state，重跑会被误判成已安装直接跳过向导
apply_install() {
  local envf="$KH_HOME/.env"
  mkdir -p "$KH_HOME/data" "$KH_HOME/backups" || return 1
  chmod 700 "$KH_HOME/backups" 2>/dev/null
  fix_owner "$KH_HOME/data" "$W_PUID" "$W_PGID" || return 1
  fix_owner "$KH_HOME/backups" "$W_PUID" "$W_PGID" || return 1
  write_templates || return 1
  [ -f "$envf" ] || env_header >"$envf" || return 1
  chmod 600 "$envf" || return 1
  write_env_values "$envf" || return 1
  state_set image_source "$W_IMAGE_SOURCE" || return 1
  state_set installed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || return 1
}

# ===== 9. 安装与向导 =====

# dir_state 目录 → installed / adopt / empty
dir_state() {
  if [ -f "$1/.kanban-hub-state" ]; then
    printf installed
  elif [ -f "$1/docker-compose.yml" ] || [ -f "$1/.env" ]; then
    printf adopt
  else
    printf empty
  fi
}

# 安装目录候选：--dir > KH_HOME 环境变量 > 脚本自身所在目录
home_candidate() {
  if [ -n "$OPT_DIR" ]; then
    abs_path "$OPT_DIR"
  elif [ -n "${KH_HOME:-}" ]; then
    abs_path "$KH_HOME"
  elif [ -n "$KH_SELF" ] && [ -f "$KH_SELF" ]; then
    abs_path "$(dirname "$KH_SELF")"
  fi
}

# download_to 地址 文件 [超时秒]
download_to() {
  local to="${3:-30}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 10 --max-time "$to" -o "$2" "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T "$to" -O "$2" "$1" 2>/dev/null
  else
    return 127
  fi
}

raw_url() {
  printf '%s/%s/deploy/kanban-hub.sh' "$KH_RAW_BASE" "$1"
}

# 把脚本本体放进安装目录：真实文件运行时复制自身；curl | bash 时读不到自身，
# 按自身版本的 tag 重新下载（tag 未发布时回退 main），过了 bash -n 才落盘
place_self() {
  local home="$1" dst="$1/kanban-hub.sh" tmp="$1/.kanban-hub.sh.tmp"
  if [ -n "$KH_SELF" ] && [ -f "$KH_SELF" ]; then
    [ "$(abs_path "$KH_SELF")" = "$dst" ] && return 0
    cp "$KH_SELF" "$tmp" || return 1
  elif ! download_to "$(raw_url "v$KH_SCRIPT_VERSION")" "$tmp" &&
    ! download_to "$(raw_url main)" "$tmp"; then
    rm -f "$tmp"
    err "下载脚本失败（可设置 KH_RAW_BASE 指向可访问的镜像地址）"
    return 1
  fi
  if ! bash -n "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    err "下载的脚本未通过语法检查，已放弃"
    return 1
  fi
  chmod 755 "$tmp" && mv "$tmp" "$dst"
}

ensure_dir_writable() {
  local d="$1"
  mkdir -p "$d" 2>/dev/null
  [ -d "$d" ] && [ -w "$d" ] && return 0
  ui_confirm "没有权限写入 ${d}，是否用 sudo 创建并把属主改为当前用户？" y || return 1
  as_root mkdir -p "$d" && as_root chown "$(id -u):$(id -g)" "$d"
}

# 对外访问地址的向导默认值：监听所有网卡时按第一个局域网 IP 推断，否则留空
public_url_default() {
  local ip=""
  case "${1:-}" in
    "" | 0.0.0.0) ip=$(lan_ips | head -n 1) ;;
  esac
  if [ -n "$ip" ]; then
    printf 'http://%s:%s' "$ip" "${2:-$KH_DEFAULT_PORT}"
  fi
  return 0
}

# KH_PUBLIC_URL 形如 http(s)://host[:port][/path]；空值合法（=服务按请求 Host 自动识别）
valid_public_url() {
  case "$1" in
    "") return 0 ;;
    *"'"* | *[[:space:]]*) return 1 ;;
    http://* | https://*) return 0 ;;
  esac
  return 1
}

# 设置 W_IMAGE、W_VERSION、W_IMAGE_SOURCE（hub|build）。
# 选项固定顺序：① Docker Hub 的脚本同名版本（本地已有该 tag 时标注，默认选中）
# ② 从当前仓库构建 kanban-hub:dev（仅当 $PWD 是 kanban-hub 仓库时出现）
choose_image() {
  local hub_ref
  local labels=() sources=()
  hub_ref="$KH_HUB_IMAGE:$KH_SCRIPT_VERSION"
  if image_local_exists "$hub_ref"; then
    labels+=("Docker Hub $KH_HUB_IMAGE:${KH_SCRIPT_VERSION}（本地已有，无需下载）")
  else
    labels+=("Docker Hub $KH_HUB_IMAGE:$KH_SCRIPT_VERSION")
  fi
  sources+=(hub)
  if repo_detect "$PWD"; then
    labels+=("从当前仓库构建 $KH_DEV_IMAGE:$KH_DEV_TAG")
    sources+=(build)
  fi
  UI_DEFAULT=0
  ui_menu "镜像来源" "${labels[@]}" || return 1
  if [ "${sources[$UI_CHOICE]}" = build ]; then
    W_IMAGE="$KH_DEV_IMAGE"
    W_VERSION="$KH_DEV_TAG"
    W_IMAGE_SOURCE=build
  else
    W_IMAGE=""
    W_VERSION="$KH_SCRIPT_VERSION"
    W_IMAGE_SOURCE=hub
  fi
  return 0
}

valid_port() {
  case "$1" in "" | *[!0-9]*) return 1 ;; esac
  [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

# 设置 W_PORT；可传入一个「允许占用」的端口（修改配置时容器自己正占着当前端口）
choose_port() {
  local allow="${1:-}" p
  while :; do
    ui_input "服务端口" "$W_PORT" || return 1
    p="$UI_VALUE"
    if ! valid_port "$p"; then
      warn "端口须是 1-65535 之间的数字"
      continue
    fi
    if [ "$p" != "$allow" ] && port_in_use "$p"; then
      warn "端口 $p 已被占用"
      continue
    fi
    W_PORT="$p"
    return 0
  done
}

valid_ipv4() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || return 1
  local IFS=. o
  # shellcheck disable=SC2086
  set -- $1
  for o in "$@"; do [ "$o" -le 255 ] || return 1; done
}

# 设置 W_BIND
choose_bind() {
  ui_menu "监听地址" \
    "0.0.0.0（所有网卡）" \
    "127.0.0.1（仅本机，放在 HTTPS 反代之后时推荐）" \
    "自定义…" || return 1
  case "$UI_CHOICE" in
    0) W_BIND=0.0.0.0 ;;
    1) W_BIND=127.0.0.1 ;;
    *)
      while :; do
        ui_input "IPv4 地址" "" || return 1
        valid_ipv4 "$UI_VALUE" && break
        warn "请输入合法的 IPv4 地址"
      done
      W_BIND="$UI_VALUE"
      ;;
  esac
}

# 设置 W_PASSWORD、W_PASSWORD_GENERATED
choose_password() {
  local a
  while :; do
    ui_password "管理员密码（留空则随机生成）" || return 1
    a="$UI_VALUE"
    if [ -z "$a" ]; then
      W_PASSWORD=$(gen_password 20)
      W_PASSWORD_GENERATED=1
      return 0
    fi
    if [ "${#a}" -lt 8 ]; then
      warn "密码至少 8 位"
      continue
    fi
    if ! env_valid_value "$a"; then
      warn "密码不能包含单引号"
      continue
    fi
    ui_password "再输入一次" || return 1
    if [ "$a" != "$UI_VALUE" ]; then
      warn "两次输入不一致"
      continue
    fi
    W_PASSWORD="$a"
    W_PASSWORD_GENERATED=0
    return 0
  done
}

# 设置 W_TZ
choose_timezone() {
  while :; do
    ui_input "时区" "$W_TZ" || return 1
    # 含单引号的值 env_set 会拒绝写入（单引号包裹表达不了），与空值、含空格一并在这里挡掉
    case "$UI_VALUE" in
      "" | *[[:space:]]* | *"'"*) warn "时区不能为空或包含空格" ;;
      *) W_TZ="$UI_VALUE"; return 0 ;;
    esac
  done
}

# 设置 W_PUID、W_PGID
choose_identity() {
  local cur v
  cur="$(id -u):$(id -g)"
  ui_menu "服务运行身份（需要写 data/ 与 backups/）" \
    "当前用户 ${cur}（推荐）" \
    "1000:1000" \
    "root 0:0" \
    "自定义…" || return 1
  case "$UI_CHOICE" in
    0) v="$cur" ;;
    1) v="1000:1000" ;;
    2) v="0:0" ;;
    *)
      while :; do
        ui_input "UID:GID" "$cur" || return 1
        v="$UI_VALUE"
        printf '%s' "$v" | grep -Eq '^[0-9]+:[0-9]+$' && break
        warn "格式应为 数字:数字，例如 1000:1000"
      done
      ;;
  esac
  W_PUID="${v%%:*}"
  W_PGID="${v#*:}"
}

# 设置 W_PUBLIC_URL。默认值优先取现值（config 修改时直接回车不丢已存地址）；
# 全新安装无现值时退回按局域网 IP 推断。输入 - 显式清空 = 服务按请求 Host 自动识别——
# 直接回车只会接受默认值，没有这个入口就永远无法置空
choose_public_url() {
  while :; do
    ui_input "对外访问地址（接入引导展示给 agent 用；输入 - 清空，留空确认则由服务按请求 Host 自动识别）" \
      "${W_PUBLIC_URL:-$(public_url_default "$W_BIND" "$W_PORT")}" || return 1
    if [ "$UI_VALUE" = "-" ]; then
      W_PUBLIC_URL=""
      return 0
    fi
    if valid_public_url "$UI_VALUE"; then
      W_PUBLIC_URL="$UI_VALUE"
      return 0
    fi
    warn "地址须以 http:// 或 https:// 开头，且不含空格或单引号"
  done
}

# 汇总页：0 确认、1-7 回头修改对应项、8 取消；确认返回 0，取消返回 1
wizard_summary() {
  local pw img
  while :; do
    if [ "$W_PASSWORD_GENERATED" = 1 ]; then pw="********（随机生成）"; else pw="********"; fi
    if [ -n "$W_IMAGE" ]; then img="$W_IMAGE:$W_VERSION"; else img="$KH_HUB_IMAGE:$W_VERSION"; fi
    UI_DEFAULT=0
    ui_menu "确认配置（选中某项可修改）" \
      "✔ 确认并写入" \
      "镜像：$img" \
      "运行身份：$W_PUID:$W_PGID" \
      "端口：$W_PORT" \
      "监听地址：$W_BIND" \
      "管理员密码：$pw" \
      "时区：$W_TZ" \
      "对外访问地址：${W_PUBLIC_URL:-（自动识别）}" \
      "✘ 取消安装" || return 1
    case "$UI_CHOICE" in
      0) return 0 ;;
      1) choose_image ;;
      2) choose_identity ;;
      3) choose_port ;;
      4) choose_bind ;;
      5) choose_password ;;
      6) choose_timezone ;;
      7) choose_public_url ;;
      *) return 1 ;;
    esac
  done
}

install_final_page() {
  local url
  printf '\n' >&2
  ok "安装完成"
  info "访问地址："
  while IFS= read -r url; do
    [ -n "$url" ] && info "  $url"
  done <<EOF
$(access_urls "$W_BIND" "$W_PORT")
EOF
  if [ "$W_PASSWORD_GENERATED" = 1 ]; then
    warn "管理员密码（随机生成，只显示这一次，已写入 .env）：$W_PASSWORD"
  fi
  info "配置文件：$KH_HOME/.env（改密码、端口等可运行 bash kanban-hub.sh config）"
  info "常用命令（在 $KH_HOME 里执行）：bash kanban-hub.sh start · status · logs -f"
}

wizard_run() {
  wizard_defaults
  W_TZ=$(detect_timezone)
  info "接下来依次确认以下事项，每项都有默认值，直接回车即可采用：
  · 镜像来源 · 端口与监听地址 · 管理员密码 · 时区 · 运行身份 · 对外访问地址
最后是汇总页，可选中任意一项回头修改；确认之前不会写入任何配置与数据（最多创建空的安装目录）"
  if ! { choose_image && choose_port && choose_bind && choose_password && choose_timezone &&
    choose_identity && choose_public_url && wizard_summary; }; then
    warn "已取消，未写入任何配置"
    return 1
  fi
  # 确认之后才落任何文件：脚本本体、compose/.env 与数据目录都在这一刻之后出现
  place_self "$KH_HOME" || return 1
  if [ "$W_IMAGE_SOURCE" = build ]; then
    image_build "$PWD" "$KH_DEV_IMAGE:$KH_DEV_TAG" || return 1
  fi
  if ! apply_install; then
    err "写入部署文件失败"
    return 1
  fi
  ok "部署文件已写入 $KH_HOME"
  if ui_confirm "现在拉取镜像并启动服务？" y; then
    if ! cmd_start; then
      err "配置已写入 ${KH_HOME}，但启动失败；排查后执行 bash kanban-hub.sh start（或 doctor）"
      if [ "$W_PASSWORD_GENERATED" = 1 ]; then
        warn "随机生成的管理员密码已写入 .env（只提示这一次），可在 $KH_HOME 里用 grep KH_ADMIN_PASSWORD .env 查看"
      fi
      return 1
    fi
  fi
  install_final_page
}

# cmd_install [默认目录]
cmd_install() {
  local target st n e
  if ! platform_ok; then
    err "本脚本只支持 Linux 宿主机"
    return 1
  fi
  if ! { : <&"$KH_TTY_FD"; } 2>/dev/null; then
    err "无法打开终端进行交互。请改为先下载再执行：curl -fsSLO <本脚本地址> && bash kanban-hub.sh"
    return 1
  fi
  info ""
  info "kanban-hub 部署管理脚本 v$KH_SCRIPT_VERSION —— 开始安装"
  info "安装目录将存放：脚本本体、compose 配置与 .env、看板数据 data/ 与备份 backups/"
  require_docker || return 1
  st=empty
  while :; do
    ui_input "安装目录" "${1:-$KH_DEFAULT_HOME}" || return 1
    target=$(abs_path "$UI_VALUE")
    case "$target" in
      *[[:space:]:]*) warn "目录路径不能包含空格或冒号"; continue ;;
    esac
    if path_forbidden "$target"; then
      err "$target 不能用作安装目录（系统目录或不安全的路径）"
      continue
    fi
    st=$(dir_state "$target")
    if [ "$st" = installed ]; then break; fi
    if [ -d "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
      warn "$target 已存在且不是空目录，以下是部分内容（最多 10 项）："
      n=0
      for e in "$target"/* "$target"/.[!.]*; do
        [ -e "$e" ] || [ -L "$e" ] || continue
        [ "$n" -lt 10 ] && printf '    %s\n' "$(basename "$e")" >&2
        n=$((n + 1))
      done
      if [ "$st" = adopt ]; then
        warn "目录里已有手工部署的 compose/.env，继续安装会按向导配置覆盖它们（data/ 不受影响）"
      else
        warn "建议改用一个空目录"
      fi
      ui_confirm "仍然安装到这个目录？" n || continue
    fi
    break
  done
  if [ "$st" = installed ]; then
    KH_HOME="$target"
    if ! home_access_ok; then
      err "当前用户无权读写安装目录 ${target}，请用 sudo 运行"
      return 1
    fi
    ok "$target 已经安装过，进入管理菜单"
    main_menu
    return
  fi
  ensure_dir_writable "$target" || return 1
  KH_HOME="$target"
  # 脚本本体在向导汇总页确认之后才落盘（wizard_run 内），取消安装不会残留文件
  wizard_run
}

# ===== 10. 运维命令 =====

compose() {
  (cd "$KH_HOME" && dk compose "$@")
}

service_running() {
  [ "$(dk inspect -f '{{.State.Running}}' "$KH_CONTAINER" 2>/dev/null)" = true ]
}

# 启动前检查：docker/compose、.env 必填项、对外地址、端口、数据目录及其属主
preflight_start() {
  local envf="$KH_HOME/.env" port owner puid pgid missing d
  [ -f "$envf" ] || { err "安装目录里没有 .env，请重新运行安装或 config"; return 1; }
  # shellcheck disable=SC2086  # 有意按空白拆出键名列表
  missing=$(env_missing_keys "$envf" $KH_ENV_REQUIRED) || {
    err ".env 缺少必填项：$(printf '%s' "$missing" | tr '\n' ' ')"
    info "    → 用 bash kanban-hub.sh config 补齐"
    return 1
  }
  if ! valid_public_url "$(env_get "$envf" KH_PUBLIC_URL)"; then
    err ".env 的 KH_PUBLIC_URL（$(env_get "$envf" KH_PUBLIC_URL)）不是合法的 http(s) 地址"
    info "    → 用 bash kanban-hub.sh config 修改"
    return 1
  fi
  if ! image_is_hub "$envf" && ! image_local_exists "$(image_ref "$envf")"; then
    err "本地镜像 $(image_ref "$envf") 不存在，请先在仓库里构建"
    return 1
  fi
  if ! service_running; then
    port=$(env_get "$envf" KH_PORT)
    port="${port:-$KH_DEFAULT_PORT}"
    if port_in_use "$port"; then
      err "端口 $port 已被占用"
      return 1
    fi
  fi
  for d in data backups; do
    if [ ! -d "$KH_HOME/$d" ]; then
      mkdir -p "$KH_HOME/$d" 2>/dev/null || as_root mkdir -p "$KH_HOME/$d" || return 1
      info "已创建 $KH_HOME/$d"
    fi
  done
  puid=$(env_get "$envf" PUID)
  pgid=$(env_get "$envf" PGID)
  puid="${puid:-1000}"
  pgid="${pgid:-1000}"
  owner=$(stat_owner "$KH_HOME/data")
  if [ "$owner" != "$puid:$pgid" ]; then
    warn "data/ 的属主（${owner}）与运行身份（$puid:${pgid}）不一致，服务将无法写入看板数据"
    if ui_confirm "现在修正 data/ 与 backups/ 的属主？" y; then
      fix_owner "$KH_HOME/data" "$puid" "$pgid" || return 1
      fix_owner "$KH_HOME/backups" "$puid" "$pgid" || return 1
    fi
  fi
}

# 就绪探测目标固定是本机（127.0.0.1 或 KH_BIND），走代理反而绕远、还可能被代理拦下来；
# 显式关代理，不依赖用户机器上没配 http_proxy/NO_PROXY
http_code() {
  if command -v curl >/dev/null 2>&1; then
    curl -s -o /dev/null -w '%{http_code}' --max-time 2 --noproxy '*' "$1" 2>/dev/null
  elif command -v wget >/dev/null 2>&1; then
    # busybox wget 不认识 --no-proxy，会直接报错退出、让就绪探测永远失败；改为清空代理
    # 环境变量后再调用，效果等价且两种 wget 实现都认
    # shellcheck disable=SC1007  # 有意为之：四个变量各自赋空串作为 wget 的临时环境，不是打错的赋值
    http_proxy= HTTP_PROXY= https_proxy= HTTPS_PROXY= wget -q --spider -T 2 "$1" 2>/dev/null && printf 200
  fi
}

# 轮询 /api/health 至 200；上限 KH_READY_TIMEOUT 秒（默认 60，非数字时同样用默认值）
wait_ready() {
  local envf="$KH_HOME/.env" port bind host i=0 limit="$KH_READY_TIMEOUT"
  case "$limit" in
    "" | *[!0-9]*) limit=60 ;;
  esac
  port=$(env_get "$envf" KH_PORT)
  bind=$(env_get "$envf" KH_BIND)
  case "$bind" in
    "" | 0.0.0.0) host=127.0.0.1 ;;
    *) host="$bind" ;;
  esac
  while [ "$i" -lt "$limit" ]; do
    if [ "$(http_code "http://$host:${port:-$KH_DEFAULT_PORT}/api/health")" = 200 ]; then
      return 0
    fi
    sleep 1
    i=$((i + 1))
  done
  return 1
}

print_access() {
  local url
  info "访问地址："
  while IFS= read -r url; do
    [ -n "$url" ] && info "  $url"
  done <<EOF
$(access_urls "$(env_get "$KH_HOME/.env" KH_BIND)" "$(env_get "$KH_HOME/.env" KH_PORT)")
EOF
}

# _compose_up [额外参数...]：公共的 up + 等待就绪 + 打印地址
_compose_up() {
  if ! compose up -d "$@"; then
    err "docker compose 执行失败"
    info "    → 拉取镜像失败时，请为 Docker 配置 registry-mirrors 或代理"
    return 1
  fi
  if ! wait_ready; then
    err "服务在 $KH_READY_TIMEOUT 秒内未就绪，请用 bash kanban-hub.sh logs 查看日志"
    return 1
  fi
  ok "服务已就绪"
  print_access
}

cmd_start() {
  preflight_start || return 1
  info "正在启动服务…"
  _compose_up
}

# 强制重建：compose 只在编排变化时才重建，改 .env 里被插值的值也要确保生效
cmd_restart() {
  preflight_start || return 1
  info "正在重建并重启服务…"
  _compose_up --force-recreate
}

cmd_stop() {
  if ! compose stop; then
    err "停止失败"
    return 1
  fi
  ok "服务已停止"
}

service_status_text() {
  local s
  s=$(dk ps -a --filter "name=^${KH_CONTAINER}$" --format '{{.Status}}' 2>/dev/null | head -n 1)
  printf '%s' "${s:-未创建}"
}

cmd_status() {
  local envf="$KH_HOME/.env"
  info "容器：$(service_status_text)"
  info "镜像：$(image_ref "$envf")"
  info "监听：$(env_get "$envf" KH_BIND):$(env_get "$envf" KH_PORT)"
  info "$KH_HOME/data 所在磁盘剩余 $(fmt_kb "$(df_avail_kb "$KH_HOME/data")")"
  return 0
}

cmd_logs() {
  if [ "$OPT_FOLLOW" = 1 ]; then
    compose logs --tail 200 -f
  else
    compose logs --tail 200
  fi
}

# 把 .env 读回 W_*，供修改配置复用安装向导的 choose_* 函数
config_load_env() {
  local envf="$KH_HOME/.env" v
  wizard_defaults
  v=$(env_get "$envf" KH_VERSION) && [ -n "$v" ] && W_VERSION="$v"
  v=$(env_get "$envf" KH_IMAGE) && W_IMAGE="$v"
  v=$(env_get "$envf" PUID) && [ -n "$v" ] && W_PUID="$v"
  v=$(env_get "$envf" PGID) && [ -n "$v" ] && W_PGID="$v"
  v=$(env_get "$envf" KH_PORT) && [ -n "$v" ] && W_PORT="$v"
  v=$(env_get "$envf" KH_BIND) && [ -n "$v" ] && W_BIND="$v"
  v=$(env_get "$envf" KH_ADMIN_PASSWORD) && W_PASSWORD="$v"
  v=$(env_get "$envf" TZ) && [ -n "$v" ] && W_TZ="$v"
  W_PUBLIC_URL=$(env_get "$envf" KH_PUBLIC_URL)
  W_PASSWORD_GENERATED=0
  return 0
}

cmd_config() {
  local envf="$KH_HOME/.env" changed=0 allow pw
  while :; do
    config_load_env
    if [ "$W_PASSWORD_GENERATED" = 1 ]; then pw="********（随机生成）"; else pw="********"; fi
    ui_menu "修改配置（改完返回时可选择立即生效）" \
      "端口：$W_PORT" \
      "监听地址：$W_BIND" \
      "时区：$W_TZ" \
      "管理员密码：$pw" \
      "对外访问地址：${W_PUBLIC_URL:-（自动识别）}" \
      "返回" || break
    case "$UI_CHOICE" in
      0)
        # 容器正在运行时它自己占着当前端口，不能因此判为「被占用」
        allow=""
        if [ "$DK_STATE" = ok ] && service_running; then allow="$W_PORT"; fi
        choose_port "$allow" && env_set "$envf" KH_PORT "$W_PORT" && changed=1
        ;;
      1) choose_bind && env_set "$envf" KH_BIND "$W_BIND" && changed=1 ;;
      2) choose_timezone && env_set "$envf" TZ "$W_TZ" && changed=1 ;;
      3)
        if choose_password && env_set "$envf" KH_ADMIN_PASSWORD "$W_PASSWORD"; then
          [ "$W_PASSWORD_GENERATED" = 1 ] && warn "新的管理员密码：$W_PASSWORD"
          info "重启服务后新密码生效，所有已登录的浏览器需要重新登录（API Token 不受影响）"
          changed=1
        fi
        ;;
      4) choose_public_url && env_set "$envf" KH_PUBLIC_URL "$W_PUBLIC_URL" && changed=1 ;;
      *) break ;;
    esac
  done
  [ "$changed" = 1 ] || return 0
  if ui_confirm "配置已修改，现在重建容器使其生效？" y; then
    cmd_restart
  else
    info "稍后运行 bash kanban-hub.sh restart 使修改生效"
  fi
}

main_menu() {
  local start_label url
  require_docker || return 1
  while :; do
    printf '\n' >&2
    info "  kanban-hub 部署管理   脚本 v$KH_SCRIPT_VERSION · 镜像 $(image_ref)"
    info "  目录 $KH_HOME   容器：$(service_status_text)"
    url=$(access_urls "$(env_get "$KH_HOME/.env" KH_BIND)" "$(env_get "$KH_HOME/.env" KH_PORT)" | head -n 1)
    [ -n "$url" ] && info "  $url"
    printf '\n' >&2
    if service_running; then start_label="重启"; else start_label="启动"; fi
    ui_menu "" "$start_label" "停止" "查看状态" "查看日志（最近 200 行）" "修改配置" "升级" "从备份恢复" "环境自检" "卸载" "退出" || return 0
    case "$UI_CHOICE" in
      0) if service_running; then cmd_restart; else cmd_start; fi ;;
      1) cmd_stop ;;
      2) cmd_status ;;
      3) OPT_FOLLOW=0; cmd_logs ;;
      4) cmd_config ;;
      5) cmd_upgrade ;;
      6)
        ui_input "备份文件名（backups/ 下，形如 kanban-hub-20260929-120000.zip）" "" && cmd_restore "$UI_VALUE"
        ;;
      7) cmd_doctor ;;
      8) cmd_uninstall && [ ! -d "$KH_HOME" ] && return 0 ;;
      *) return 0 ;;
    esac
    ui_pause
  done
}

# ===== 11. 自检与卸载 =====

# doctor_line ok|warn|fail 信息 [建议]
doctor_line() {
  case "$1" in
    ok) ok "$2" ;;
    warn) warn "$2" ;;
    *) err "$2" ;;
  esac
  if [ -n "${3:-}" ]; then info "    → $3"; fi
  return 0
}

cmd_doctor() {
  local envf="$KH_HOME/.env" fails=0 k port owner puid pgid cur recorded ref
  if platform_ok; then
    doctor_line ok "宿主机系统：$(uname -s)"
  else
    doctor_line fail "本脚本只支持 Linux 宿主机"
    fails=$((fails + 1))
  fi
  if docker_probe; then
    doctor_line ok "Docker 可用（服务端 $(dk version --format '{{.Server.Version}}' 2>/dev/null)），compose v2 可用"
    if [ "$DK_SUDO" = 1 ]; then
      doctor_line warn "当前用户需经 sudo 访问 Docker" "可把用户加入 docker 组：sudo usermod -aG docker ${USER}（重新登录生效）"
    fi
  else
    doctor_line fail "$(docker_probe_message)"
    fails=$((fails + 1))
  fi
  if [ -f "$envf" ]; then
    # shellcheck disable=SC2086  # 有意按空白拆出键名列表
    for k in $(env_missing_keys "$envf" $KH_ENV_REQUIRED); do
      doctor_line fail ".env 缺少必填项 $k" "用 bash kanban-hub.sh config 补齐"
      fails=$((fails + 1))
    done
  else
    doctor_line fail "安装目录里没有 .env" "重新运行安装"
    fails=$((fails + 1))
  fi
  # docker 不可用时 image_local_exists 无从判断（会误报缺失）；.env 没有 KH_VERSION
  # 时 image_ref 拼出的引用本就不完整——两种情况都跳过这项检查，不计入失败、不误导用户
  if [ "$DK_STATE" = ok ] && [ -n "$(env_get "$envf" KH_VERSION)" ]; then
    ref="$(image_ref "$envf")"
    if image_local_exists "$ref"; then
      doctor_line ok "镜像 $ref 已就绪"
    elif image_is_hub "$envf"; then
      doctor_line warn "镜像 $ref 尚未拉取，首次启动会从 Docker Hub 拉取"
    else
      doctor_line fail "本地镜像 $ref 不存在" "在仓库根目录重新运行安装向导，选「从当前仓库构建」"
      fails=$((fails + 1))
    fi
  fi
  port=$(env_get "$envf" KH_PORT)
  port="${port:-$KH_DEFAULT_PORT}"
  if [ "$DK_STATE" = ok ] && service_running; then
    doctor_line ok "端口 $port 由本服务占用（正在运行）"
  elif port_in_use "$port"; then
    doctor_line fail "端口 $port 已被占用" "用 bash kanban-hub.sh config 换一个端口"
    fails=$((fails + 1))
  else
    doctor_line ok "端口 $port 空闲"
  fi
  puid=$(env_get "$envf" PUID)
  pgid=$(env_get "$envf" PGID)
  if [ ! -d "$KH_HOME/data" ]; then
    doctor_line fail "数据目录 $KH_HOME/data 不存在" "bash kanban-hub.sh start 会自动创建"
    fails=$((fails + 1))
  else
    owner=$(stat_owner "$KH_HOME/data")
    if [ "$owner" = "${puid:-1000}:${pgid:-1000}" ]; then
      doctor_line ok "data/ 属主正确（${owner}）"
    else
      doctor_line fail "data/ 的属主（${owner}）与运行身份（${puid:-1000}:${pgid:-1000}）不一致" "bash kanban-hub.sh start 时会提示修正"
      fails=$((fails + 1))
    fi
  fi
  cur=$(sha256_file "$KH_HOME/docker-compose.yml" 2>/dev/null)
  recorded=$(state_get compose_sha256)
  if [ -n "$recorded" ] && [ "$cur" != "$recorded" ]; then
    doctor_line warn "docker-compose.yml 被手动修改过（与安装时记录的校验和不一致）"
  fi
  if [ "$fails" = 0 ]; then
    ok "自检全部通过"
    return 0
  fi
  err "自检发现 $fails 项问题"
  return 1
}

# 只删确实是本脚本安装的目录（有 state 文件）且不是系统目录的路径
safe_remove_home() {
  if path_forbidden "$KH_HOME"; then
    err "拒绝删除 ${KH_HOME}（系统目录或不安全的路径）"
    return 1
  fi
  if [ ! -f "$KH_HOME/.kanban-hub-state" ]; then
    err "拒绝删除 ${KH_HOME}（不是本脚本安装的目录）"
    return 1
  fi
  rm -rf "$KH_HOME" 2>/dev/null || as_root rm -rf "$KH_HOME"
  if [ ! -e "$KH_HOME" ]; then
    ok "已删除 $KH_HOME"
  fi
}

# uninstall_foreign_entries：安装目录下顶层条目里，不属于本脚本产物的那些。
# env_set/state_set 的残留临时文件前缀 .env.tmp.*、.kanban-hub-state.tmp.* 直接跳过——
# 它们本就是应该被静默清理的运行期垃圾，不是用户需要知晓的「无关内容」
uninstall_foreign_entries() {
  local e base known
  for e in "$KH_HOME"/* "$KH_HOME"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    base=$(basename "$e")
    case "$base" in
      .env.tmp.* | .kanban-hub-state.tmp.* | .kanban-hub.sh.tmp) continue ;;
    esac
    known=0
    for k in data backups .env docker-compose.yml .kanban-hub-state kanban-hub.sh; do
      [ "$base" = "$k" ] && { known=1; break; }
    done
    [ "$known" = 1 ] || printf '%s\n' "$base"
  done
}

cmd_uninstall() {
  local name foreign
  ui_confirm "停止并删除服务容器？（看板数据与备份文件不受影响）" n || return 1
  compose down || warn "docker compose down 失败，继续后续步骤"
  info "容器已移除；安装目录 ${KH_HOME}（含 data/、backups/ 与配置）仍保留"
  ui_confirm "同时删除安装目录？（看板数据、备份与配置将永久删除）" n || return 0
  warn "data/ 里的看板数据与 backups/ 里的备份会一并删除，脚本不会自动备份它们"
  foreign=$(uninstall_foreign_entries)
  if [ -n "$foreign" ]; then
    warn "安装目录里还有以下不属于本脚本的内容，也会被一并删除："
    printf '%s\n' "$foreign" | sed 's/^/    /' >&2
  fi
  name=$(basename "$KH_HOME")
  ui_input "输入目录名 $name 确认删除" "" || return 0
  if [ "$UI_VALUE" != "$name" ]; then
    info "目录名不符，已放弃删除"
    return 0
  fi
  safe_remove_home
}

# ===== 12. 升级与恢复 =====

# 备份文件名（与服务端生成规则一致）：kanban-hub-YYYYMMDD-HHmmss.zip，同秒冲突时在 .zip 前加 -N。
# restore 只认这个形状的名字，路径固定取安装目录 backups/ 下，不接受路径参数
KH_BACKUP_NAME_RE='^kanban-hub-[0-9]{8}-[0-9]{6}(-[0-9]+)?\.zip$'

# self_update 失败原因（SELF_UPDATE_REASON）→ 展示文案
self_update_reason_text() {
  case "$1" in
    self_download_failed) printf '下载失败（可设置 KH_RAW_BASE 指向可访问的镜像地址）' ;;
    self_syntax_failed) printf '下载的内容未通过语法检查' ;;
    self_version_mismatch) printf '下载的内容与目标版本不符' ;;
    *) printf '未知原因' ;;
  esac
}

# _self_update_run 目标版本 临时文件：下载 → bash -n → 版本行精确匹配 → 备份旧脚本 → 原子替换。
# 失败原因记在 SELF_UPDATE_REASON，由调用方按上下文分级展示（镜像已是目标版本时自更新失败
# 不算升级失败）；成功与否之外的中间状态不留盘
_self_update_run() {
  local target="$1" tmp="$2" want_line
  if ! download_to "$(raw_url "v$target")" "$tmp"; then
    rm -f "$tmp"
    SELF_UPDATE_REASON=self_download_failed
    return 1
  fi
  if ! bash -n "$tmp" 2>/dev/null; then
    rm -f "$tmp"
    SELF_UPDATE_REASON=self_syntax_failed
    return 1
  fi
  # 语法合法不代表内容就是目标版本（可能拿到别的 ref 或旧缓存）；精确匹配整个版本行
  #（脚本头部的 KH_SCRIPT_VERSION="…" 行）比 grep 版本号更不容易被误判。
  # 这一行的格式是跨版本接口，不得加尾注释或改动写法
  want_line="KH_SCRIPT_VERSION=\"$target\""
  if ! grep -qxF "$want_line" "$tmp"; then
    rm -f "$tmp"
    SELF_UPDATE_REASON=self_version_mismatch
    return 1
  fi
  if ! mkdir -p "$KH_HOME/backups"; then
    rm -f "$tmp"
    return 1
  fi
  chmod 700 "$KH_HOME/backups" 2>/dev/null
  if ! cp -p "$KH_HOME/kanban-hub.sh" "$KH_HOME/backups/kanban-hub.sh.$(date +%Y%m%d-%H%M%S)"; then
    rm -f "$tmp"
    return 1
  fi
  if ! { chmod 755 "$tmp" && mv "$tmp" "$KH_HOME/kanban-hub.sh"; }; then
    rm -f "$tmp"
    return 1
  fi
}

# self_update 目标版本：包装 _self_update_run，下载/校验途中被 Ctrl-C 或 kill 时清掉半截
# 临时文件（trap 体读全局变量，不把路径拼进 trap 字符串）；结束后恢复 main 设置的默认 trap
self_update() {
  local target="$1" tmp="$KH_HOME/.kanban-hub.sh.upgrade" rc
  SELF_UPDATE_REASON=""
  KH_UPGRADE_TMP="$tmp"
  trap 'rm -f "$KH_UPGRADE_TMP"; ui_restore; exit 130' INT TERM
  _self_update_run "$target" "$tmp"
  rc=$?
  trap 'ui_restore; exit 130' INT TERM
  return "$rc"
}

# 本次 template_sync 的回滚信息：替换过的文件记「state 键<TAB>替换前校验和<TAB>备份路径」；
# 是否推进过模板版本与推进前的旧值。都只供 template_sync_rollback 使用
TEMPLATE_SYNC_LOG=""
TEMPLATE_SYNC_BUMPED=0
TEMPLATE_SYNC_OLD_TVER=""

# 内嵌模板版本比已安装的新时才处理：没变就跳过已存在的文件（不比对、不弹 diff，避免同一
# 版本反复纠缠用户）；文件缺失一律直接写入。版本变大时：未被手改（校验和等于 state 记录）
# 静默替换；手改过则展示 diff 由用户决定（默认保留），替换前一律备份
template_sync() {
  local tmp cur recorded="" ts old_tver need_check=0
  ts=$(date +%Y%m%d-%H%M%S)
  TEMPLATE_SYNC_LOG=""
  TEMPLATE_SYNC_BUMPED=0
  old_tver=$(state_get template_version 2>/dev/null)
  case "$old_tver" in "" | *[!0-9]*) old_tver=0 ;; esac
  TEMPLATE_SYNC_OLD_TVER="$old_tver"
  [ "$old_tver" -lt "$KH_TEMPLATE_VERSION" ] && need_check=1
  if [ -f "$KH_HOME/docker-compose.yml" ] && [ "$need_check" != 1 ]; then
    return 0
  fi
  tmp="$KH_HOME/.docker-compose.yml.new"
  if ! tpl_compose >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  cur=""
  [ -f "$KH_HOME/docker-compose.yml" ] && cur=$(sha256_file "$KH_HOME/docker-compose.yml")
  if [ "$cur" = "$(sha256_file "$tmp")" ]; then
    rm -f "$tmp"
    state_set compose_sha256 "$cur"
  else
    if [ -n "$cur" ]; then
      recorded=$(state_get compose_sha256)
      if [ "$cur" != "$recorded" ]; then
        warn "docker-compose.yml 被手动修改过，与新模板的差异如下："
        diff -u "$KH_HOME/docker-compose.yml" "$tmp" >&2
        if ! ui_confirm "仍要替换为新模板吗？（选否保留你的修改）" n; then
          rm -f "$tmp"
          warn "已保留手动修改过的 docker-compose.yml（新模板未应用）"
          if [ "$need_check" = 1 ]; then
            state_set template_version "$KH_TEMPLATE_VERSION"
            TEMPLATE_SYNC_BUMPED=1
          fi
          return 0
        fi
      fi
    fi
    if ! mkdir -p "$KH_HOME/backups"; then
      rm -f "$tmp"
      err "创建 $KH_HOME/backups 失败，无法备份旧模板"
      return 1
    fi
    chmod 700 "$KH_HOME/backups" 2>/dev/null
    if [ -f "$KH_HOME/docker-compose.yml" ]; then
      if ! cp -p "$KH_HOME/docker-compose.yml" "$KH_HOME/backups/docker-compose.yml.$ts"; then
        rm -f "$tmp"
        err "备份 docker-compose.yml 失败，已放弃替换"
        return 1
      fi
      # 记录 state 里替换前的值（不是磁盘上手改文件的 sha）：回滚要撤销的是这次调用对
      # state 做的改动，state 在这次调用前的值就是 recorded
      TEMPLATE_SYNC_LOG="compose_sha256"$'\t'"${recorded}"$'\t'"$KH_HOME/backups/docker-compose.yml.$ts"$'\n'
    fi
    if ! { mv "$tmp" "$KH_HOME/docker-compose.yml" &&
      state_set compose_sha256 "$(sha256_file "$KH_HOME/docker-compose.yml")"; }; then
      rm -f "$tmp"
      return 1
    fi
    info "docker-compose.yml 已更新（模板 v${KH_TEMPLATE_VERSION}）"
  fi
  if [ "$need_check" = 1 ]; then
    state_set template_version "$KH_TEMPLATE_VERSION"
    TEMPLATE_SYNC_BUMPED=1
  fi
  return 0
}

# 回滚本次 template_sync 实际做出的改动（升级流程自身失败时调用）：把备份 cp 回去、state
# 复原；备份缺失只 warn 给出备份路径，不中止流程——调用方本就在处理另一个失败，不应该在
# 回滚上再报错卡住
template_sync_rollback() {
  local key oldsha backup
  while IFS=$'\t' read -r key oldsha backup; do
    [ -n "$key" ] || continue
    if [ -f "$backup" ] && cp -p "$backup" "$KH_HOME/docker-compose.yml"; then
      state_set "$key" "$oldsha"
    else
      warn "未能自动恢复 docker-compose.yml 原状，备份文件还在：$backup"
    fi
  done <<EOF
$TEMPLATE_SYNC_LOG
EOF
  if [ "$TEMPLATE_SYNC_BUMPED" = 1 ]; then
    state_set template_version "$TEMPLATE_SYNC_OLD_TVER"
  fi
  return 0
}

# 回滚本次升级写入的镜像名（只有本地镜像切回 Hub 时写过，其余情况是无害 no-op）；
# env_set 失败不吞掉——报错请用户手动检查，不能假装已经恢复
_upgrade_rollback_image() {
  local from_local="$1" orig="$2"
  [ "$from_local" = 1 ] || return 0
  if ! env_set "$KH_HOME/.env" KH_IMAGE "$orig"; then
    err "恢复 .env 的 KH_IMAGE 失败，请手动检查（原值：${orig}）"
  fi
}

# 把 .env 升到目标版本并重建容器。
#   $1 = from_local（1 表示从本地镜像切回 Hub，要把 KH_IMAGE 写回空 = 模板默认）
#   $2 = want_image（from_local=1 时要写入的镜像名，固定为空）
#   $3 = orig_image（from_local=1 的原镜像名，失败时回滚用）
# 结果记在全局 UPGRADE_OUTCOME 而不是返回码里：declined（拒绝确认，未做任何改动）/
# rolled_back（已改动但整体失败，已撤销）/ applied（完整应用，含无需改动的情形）/
# restart_failed（pull 已成功但重建容器失败——保留新版本号，与既有行为一致）
_upgrade_apply() {
  local from_local="${1:-0}" want_image="${2:-}" orig_image="${3:-}" envf="$KH_HOME/.env" target cur cmp def
  [ -n "$orig_image" ] || orig_image=$(env_get "$envf" KH_IMAGE)
  target="${OPT_TO#v}"
  if [ -n "$target" ] && ! valid_version "$target"; then
    err "--to 的版本格式应为 X.Y.Z 或 X.Y.Z-预发布（如 1.2.3、1.2.3-rc.1），收到：${OPT_TO}"
    UPGRADE_OUTCOME=rolled_back
    return 2
  fi
  if [ -z "$target" ]; then
    info "正在查询最新版本…"
    target=$(fetch_latest_version)
    if [ -z "$target" ]; then
      err "查询最新版本失败（可离线指定：bash kanban-hub.sh upgrade --to <版本号>）"
      UPGRADE_OUTCOME=rolled_back
      return 1
    fi
  fi
  cur=$(env_get "$envf" KH_VERSION)
  if [ "$from_local" = 1 ]; then cmp=1; else cmp=$(ver_cmp "$target" "$cur"); fi

  if [ "$cmp" = 0 ] && image_local_exists "$(image_ref "$envf")"; then
    info "镜像已经是 ${cur}，无需升级"
    if [ "$target" = "$KH_SCRIPT_VERSION" ]; then
      if ! template_sync; then
        UPGRADE_OUTCOME=rolled_back
        return 1
      fi
      UPGRADE_OUTCOME=applied
      return 0
    fi
  elif [ "$cmp" = 0 ]; then
    # .env 已是目标版本但目标镜像不在本地：上次升级在版本号落盘后、compose pull 前被打断
    #（模板确认处 Ctrl-C、kill、断电）。这里跳过确认（目标早已选定）继续走完下面的模板
    # 同步、拉取与重建，让半途状态重跑 upgrade 即可收敛，而不是误报"无需升级"
    info ".env 已是 $target，但镜像尚未拉取——继续完成上次未完成的升级"
  elif [ "${KH_UPGRADE_CONFIRMED:-}" != 1 ]; then
    [ "$cmp" = -1 ] && warn "目标版本 $target 低于当前版本 ${cur}，这是降级操作"
    if [ "$cmp" = 1 ]; then def=y; else def=n; fi
    if ! ui_confirm "把镜像从 $cur 切换到 ${target}？" "$def"; then
      UPGRADE_OUTCOME=declined
      return 0
    fi
  fi

  # 升级已确认（或第二阶段本就带着确认标记进来）。在真正落盘之前 .env 不会被本函数改过
  # 一个字节——镜像名与版本号到下面那一步才一起写，确认之后、落盘之前的任何失败或中断
  #（Ctrl-C、下载卡住被杀、exec 到的新进程半路退出）都不会留下半新半旧的 .env
  if [ "$target" != "$KH_SCRIPT_VERSION" ] && [ "${KH_UPGRADE_STAGE:-}" != 2 ]; then
    if self_update "$target"; then
      # 跨版本接口：旧脚本 exec 新脚本续跑第二阶段。这些变量与参数只增不改，否则装着
      # 旧脚本的机器升级时会向新脚本传出它读不懂的东西。原镜像名只在这时才导出，第二
      # 阶段读到后立即 unset，避免残留污染同一 shell 里下一次 upgrade 调用
      export KH_UPGRADE_STAGE=2 KH_UPGRADE_CONFIRMED=1
      if [ "$from_local" = 1 ]; then
        export KH_UPGRADE_REVERT_IMAGE="$orig_image"
      fi
      exec "$KH_HOME/kanban-hub.sh" upgrade --to "$target" --dir "$KH_HOME"
    fi
    # self_update 只返回成功与否，原因在 SELF_UPDATE_REASON；cmp=0 时镜像本就是目标版本，
    # 自更新没做成不算升级失败，用 warn 并继续更新模板
    if [ "$cmp" = 0 ]; then
      warn "脚本自更新失败（$(self_update_reason_text "$SELF_UPDATE_REASON")），部署脚本仍是 v$KH_SCRIPT_VERSION"
      if ! template_sync; then
        UPGRADE_OUTCOME=rolled_back
        return 1
      fi
      UPGRADE_OUTCOME=applied
      return 0
    fi
    err "脚本自更新失败（$(self_update_reason_text "$SELF_UPDATE_REASON")），部署脚本仍是 v$KH_SCRIPT_VERSION"
    if ! ui_confirm "是否只把镜像更新到 ${target}（脚本保持当前版本，下次再更新脚本）？" n; then
      # .env 到这里还没被这次调用改过，无需回滚
      UPGRADE_OUTCOME=rolled_back
      return 1
    fi
    # 同意仅更新镜像：脚本版本不变，在本进程内继续完成镜像切换
  fi

  # 镜像名与版本号在这里一起写：要么都成功、要么都不改，不存在只改了一半的中间态
  if [ "$from_local" = 1 ]; then
    if ! env_set "$envf" KH_IMAGE "$want_image"; then
      UPGRADE_OUTCOME=rolled_back
      return 1
    fi
  fi
  if ! env_set "$envf" KH_VERSION "$target"; then
    _upgrade_rollback_image "$from_local" "$orig_image"
    UPGRADE_OUTCOME=rolled_back
    return 1
  fi
  if ! template_sync; then
    [ "$target" = "$cur" ] || env_set "$envf" KH_VERSION "$cur"
    template_sync_rollback
    _upgrade_rollback_image "$from_local" "$orig_image"
    UPGRADE_OUTCOME=rolled_back
    return 1
  fi
  if ! compose pull; then
    [ "$target" = "$cur" ] || env_set "$envf" KH_VERSION "$cur"
    template_sync_rollback
    _upgrade_rollback_image "$from_local" "$orig_image"
    err "拉取镜像 $KH_HUB_IMAGE:$target 失败，版本号已回退为 $cur"
    info "    → 请为 Docker 配置 registry-mirrors 或代理后重试"
    UPGRADE_OUTCOME=rolled_back
    return 1
  fi
  # pull 已成功：版本号保留新值，重建失败也不回滚（与 Hub 升级重建失败不回滚的行为一致）
  if [ "$from_local" = 1 ]; then
    state_set image_source hub
  fi
  if ! cmd_restart; then
    err "镜像已更新到 ${target}，但重建容器失败"
    info "    → 排查后执行 bash kanban-hub.sh start"
    UPGRADE_OUTCOME=restart_failed
    return 1
  fi
  UPGRADE_OUTCOME=applied
  return 0
}

# 本地镜像的「升级」= 从仓库重新构建并重建容器。--repo 可指定仓库路径（默认当前目录）
cmd_upgrade_rebuild() {
  local repo="$1" envf="$KH_HOME/.env" orig_image
  if ! repo_detect "$repo"; then
    err "$repo 不是 kanban-hub 仓库（缺 Dockerfile 或 package.json 不符）"
    info "    → 请在仓库目录运行，或用 --repo 指定仓库路径"
    return 1
  fi
  info "正在从 $repo 构建镜像 $KH_DEV_IMAGE:${KH_DEV_TAG}…"
  if ! image_build "$repo" "$KH_DEV_IMAGE:$KH_DEV_TAG"; then
    return 1
  fi
  # 构建成功后才动 .env。镜像名与版本号分两步写，后者失败回滚前者（同 _upgrade_apply 的
  # 回滚模式），不让半新 .env 留盘；重建失败保留新镜像名，提示手动 start（与 Hub 升级一致）
  orig_image=$(env_get "$envf" KH_IMAGE)
  if ! env_set "$envf" KH_IMAGE "$KH_DEV_IMAGE"; then
    err "写入 .env 失败"
    return 1
  fi
  if ! env_set "$envf" KH_VERSION "$KH_DEV_TAG"; then
    if ! env_set "$envf" KH_IMAGE "$orig_image"; then
      err "回滚 .env 的 KH_IMAGE 失败，请手动检查（原值：${orig_image}）"
    fi
    err "写入 .env 失败"
    return 1
  fi
  state_set image_source build
  if ! cmd_restart; then
    err "镜像已构建为 $KH_DEV_IMAGE:${KH_DEV_TAG}，但重建容器失败"
    info "    → 排查后执行 bash kanban-hub.sh start"
    return 1
  fi
  ok "已切换到本地构建的镜像 $KH_DEV_IMAGE:$KH_DEV_TAG"
  return 0
}

# cmd_upgrade：Hub 镜像直接走 _upgrade_apply；本地镜像先问怎么升级（重建 / 切回 Hub / 取消）。
# 第二阶段（自更新 exec 过来）从 KH_UPGRADE_REVERT_IMAGE 拿到原镜像名，不再出菜单——
# 这个变量只信一次：要求 KH_UPGRADE_STAGE=2 同时成立，读到后立即 unset，防止残留环境变量
# 把同一 shell 里下一次 upgrade 调用误判成第二阶段
cmd_upgrade() {
  local envf="$KH_HOME/.env" opts=() acts=() from_local=0 saved_image="" want_image="" repo
  UPGRADE_OUTCOME=""
  if [ "${KH_UPGRADE_STAGE:-}" = 2 ] && [ -n "${KH_UPGRADE_REVERT_IMAGE:-}" ]; then
    # 第一阶段没写 .env 的镜像名（只导出了原镜像名供回滚）；第二阶段自己认定目标是 Hub
    from_local=1
    saved_image="$KH_UPGRADE_REVERT_IMAGE"
    want_image=""
    unset KH_UPGRADE_REVERT_IMAGE
  elif ! image_is_hub "$envf"; then
    repo="${OPT_REPO:-$PWD}"
    if repo_detect "$repo"; then
      opts+=("从仓库重新构建 $KH_DEV_IMAGE:${KH_DEV_TAG}（仓库：${repo}）")
      acts+=(rebuild)
    fi
    opts+=("切回 Docker Hub 正式版")
    acts+=(hub)
    opts+=("取消")
    acts+=(cancel)
    ui_menu "当前使用本地构建的镜像，请选择升级方式" "${opts[@]}" || return 0
    case "${acts[$UI_CHOICE]:-cancel}" in
      rebuild) cmd_upgrade_rebuild "$repo"; return $? ;;
      hub)
        saved_image=$(env_get "$envf" KH_IMAGE)
        want_image=""
        from_local=1
        ;;
      *) return 0 ;;
    esac
  fi
  _upgrade_apply "$from_local" "$want_image" "$saved_image"
  case "$UPGRADE_OUTCOME" in
    rolled_back | restart_failed) return 1 ;;
    *) return 0 ;;
  esac
}

# cmd_restore <备份文件名>：停容器 → data/ 改名保留 → 新建空 data/ 并对齐属主 → 容器内
# 执行恢复 → 询问是否启动。文件名只认安装目录 backups/ 下的约定形状，不接受路径参数
#（防误指到别处的文件）；备份有密码时交互输入，或先 export KH_RESTORE_PASSWORD 跳过交互
cmd_restore() {
  local name="${1:-$OPT_RESTORE_NAME}" file bak ts n puid pgid
  if [ -z "$name" ] || [ -n "${2:-}" ]; then
    err "用法：bash kanban-hub.sh restore <备份文件名>（backups/ 下的文件名，不带路径）"
    return 2
  fi
  case "$name" in
    */*)
      err "只接受 backups/ 下的备份文件名，不接受路径"
      return 2
      ;;
  esac
  if ! printf '%s' "$name" | grep -Eq "$KH_BACKUP_NAME_RE"; then
    err "$name 不是本服务生成的备份文件名（应为 kanban-hub-日期-时间.zip）"
    return 2
  fi
  file="$KH_HOME/backups/$name"
  if [ ! -f "$file" ]; then
    err "backups/ 里没有 $name"
    info "    → 可用的备份见 $KH_HOME/backups/（或网页端设置页的备份列表）"
    return 1
  fi
  if ! ui_confirm "恢复将停止服务，并用该备份覆盖当前看板数据；当前 data/ 会先改名保留，继续？" y; then
    return 1
  fi
  if ! compose stop; then
    err "停止容器失败，已中止恢复（数据未动）"
    return 1
  fi
  puid=$(env_get "$KH_HOME/.env" PUID)
  pgid=$(env_get "$KH_HOME/.env" PGID)
  puid="${puid:-1000}"
  pgid="${pgid:-1000}"
  # 备份目录名带时间戳；同一秒内再次恢复时加序号，绝不能 mv 进已存在的旧备份目录里
  ts=$(date +%Y%m%d-%H%M%S)
  bak="data.bak-$ts"
  n=0
  while [ -e "$KH_HOME/$bak" ]; do
    n=$((n + 1))
    bak="data.bak-$ts-$n"
  done
  if ! { mv "$KH_HOME/data" "$KH_HOME/$bak" 2>/dev/null || as_root mv "$KH_HOME/data" "$KH_HOME/$bak"; }; then
    err "改名 data/ 失败，已中止恢复（数据未动）"
    return 1
  fi
  info "原数据已保留为 $KH_HOME/${bak}（确认恢复无误后可手动删除）"
  if ! mkdir "$KH_HOME/data" 2>/dev/null; then
    if ! as_root mkdir "$KH_HOME/data"; then
      err "新建 data/ 失败；原数据在 $KH_HOME/${bak}，可改回原名后重试"
      return 1
    fi
  fi
  if ! fix_owner "$KH_HOME/data" "$puid" "$pgid"; then
    err "对齐 data/ 属主失败；原数据在 $KH_HOME/${bak}，可改回原名后重试"
    return 1
  fi
  info "正在从备份恢复（备份有密码时按提示输入，或先用环境变量 KH_RESTORE_PASSWORD 提供）…"
  # -e 不带值：从当前 shell 继承 KH_RESTORE_PASSWORD，导出过才透传（密码不进命令行参数，
  # 也不进进程列表）；没导出时容器里同样没有这个变量，restore 会照常交互询问
  if compose run --rm -e KH_RESTORE_PASSWORD kanban-hub restore "/backups/$name"; then
    ok "恢复完成"
    if ui_confirm "现在启动服务？" y; then
      cmd_start
    else
      info "稍后运行 bash kanban-hub.sh start 启动服务"
    fi
    return 0
  fi
  err "恢复失败，看板数据未恢复；原数据完整保留在 $KH_HOME/$bak"
  info "    → 回退方法：删除新建的空 data/，再把 $bak 改名为 data，然后排查备份密码后重试"
  return 1
}

# ===== 13. 入口 =====

cmd_help() {
  cat <<'KH_HELP_EOF'
用法：bash kanban-hub.sh [命令] [--dir 目录]

命令：
  install     安装并初始化（未安装时直接运行脚本即进入）
  start       启动服务
  stop        停止服务
  restart     重建并重启服务（配置变更后用它生效）
  status      查看运行状态
  logs        查看服务日志（-f 持续跟随）
  config      修改配置
  upgrade     升级脚本与镜像（--to 指定版本；本地镜像模式提供重建/切回选择）
  restore     从备份恢复数据（restore <备份文件名>，原数据改名保留）
  doctor      环境自检
  uninstall   卸载
  version     显示脚本版本
  help        显示本帮助

选项：
  --dir DIR     指定安装目录
  --to 版本     upgrade 的目标版本（不传则查询最新正式版）
  --repo 目录   upgrade 本地重建时的仓库路径（默认当前目录）
  -f, --follow  logs 持续跟随输出
  -h, --help    显示本帮助
KH_HELP_EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --dir) OPT_DIR="${2:-}"; shift ;;
      --dir=*) OPT_DIR="${1#--dir=}" ;;
      --to) OPT_TO="${2:-}"; shift ;;
      --to=*) OPT_TO="${1#--to=}" ;;
      --repo) OPT_REPO="${2:-}"; shift ;;
      --repo=*) OPT_REPO="${1#--repo=}" ;;
      -f | --follow) OPT_FOLLOW=1 ;;
      -h | --help) CMD=help ;;
      -*) err "未知选项：$1"; return 2 ;;
      *)
        # restore 额外接受一个位置参数：备份文件名
        if [ -z "$CMD" ]; then
          CMD="$1"
        elif [ "$CMD" = restore ] && [ -z "$OPT_RESTORE_NAME" ]; then
          OPT_RESTORE_NAME="$1"
        else
          err "多余的参数：$1"
          return 2
        fi
        ;;
    esac
    shift
  done
}

# 管理模式（菜单与所有管理命令）前置检查：安装目录必须可写，其中的 .env 若存在必须可读可写——
# 否则大概率是别的用户（sudo 装的、或别的 uid）在管理这份部署，贸然继续要么改不动、要么写出
# 当前用户能读但目标进程读不到的文件，不如直接提示换用 sudo
home_access_ok() {
  [ -w "$KH_HOME" ] || return 1
  [ -f "$KH_HOME/.env" ] || return 0
  [ -r "$KH_HOME/.env" ] && [ -w "$KH_HOME/.env" ]
}

main() {
  local home
  parse_args "$@" || exit 2
  case "$CMD" in
    help) cmd_help; return 0 ;;
    version) printf '%s\n' "$KH_SCRIPT_VERSION"; return 0 ;;
  esac
  trap ui_restore EXIT
  trap 'ui_restore; exit 130' INT TERM

  home=$(home_candidate)
  if [ -n "$home" ] && [ "$(dir_state "$home")" = installed ]; then
    KH_HOME="$home"
    if ! home_access_ok; then
      err "当前用户无权读写安装目录 ${KH_HOME}，请用 sudo 运行"
      return 1
    fi
    case "$CMD" in
      "" | install) main_menu ;;
      doctor) cmd_doctor ;;
      start | stop | restart | status | logs | config | uninstall | upgrade | restore) require_docker && "cmd_$CMD" ;;
      *) err "未知命令：$CMD"; return 2 ;;
    esac
    return
  fi

  case "$CMD" in
    # 默认安装目录只取显式给出的（--dir / KH_HOME），不取脚本所在目录——在仓库里跑时那是 deploy/
    "" | install) cmd_install "${OPT_DIR:-${KH_HOME:-}}" ;;
    start | stop | restart | status | logs | config | doctor | uninstall | upgrade | restore)
      err "kanban-hub 尚未安装（或未找到安装目录），请先运行本脚本安装，或用 --dir 指定安装目录"
      return 1
      ;;
    *) err "未知命令：$CMD"; return 2 ;;
  esac
}

if [ "${KH_SOURCE_ONLY:-}" != "1" ]; then
  main "$@"
fi
