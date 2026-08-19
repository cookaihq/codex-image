#!/bin/bash
# check_update.sh — skill 自动检查更新（规范脚本 / canonical source）
#
# 规范来源：awesome-skills 外层仓 harness/skill-update-check/check_update.sh
# 约定文档：docs/adr/0010-skill-auto-update-check.md
#
# 本文件是唯一源。各 skill 把它**原样复制**为 <skill>/scripts/check_update.sh
# 随产物分发（产物自包含；多 skill 仓每 skill 一份是既定代价，先例是
# plugin-marketplace 每个 plugin 目录各带一份 LICENSE）。
#
# 用法：
#   scripts/check_update.sh            # 检查模式（默认）
#   scripts/check_update.sh --pull     # 用户确认后拉取（仅 ff-only，条件不满足即拒绝）
#   scripts/check_update.sh --help
#
# 退出码：
#   0   无事发生（已关闭 / 节流跳过 / 非 git 检出 / 网络失败 / 已是最新），或 --pull 成功
#   10  检查模式：检测到本地落后远端，报告已打印，等待用户决定是否 pull
#   1   --pull 前置条件不满足被拒绝，或 --pull 执行失败；参数错误
#
# 行为要点：
#   - 开关 AUTO_UPDATE_CHECK 只从 ~/.config/<skill-name>/.env 读，缺失或非 0 视为开启。
#     这是**非 Secret 的行为开关**，读取无副作用，故不走 ADR 0003 的四层分层
#     （无前缀 key 进入进程环境变量或项目 .env 会同时命中所有 skill）。
#   - 节流 6 小时，时间戳 ~/.config/<skill-name>/.update-check-stamp，**进入网络检查前**
#     就写新时间戳，断网时不会每次启动都空等。
#   - fetch 单次尝试、5 秒超时、失败静默跳过、不重试（ADR 0006：启动路径预算极小）。
#   - 本脚本任何情况下不 commit / push / reset / checkout，--pull 只做 merge --ff-only。
#
# 实现约束：兼容 macOS 自带 bash 3.2；无 GNU coreutils / python / jq 依赖
# （只用 git、awk、sed、grep、mktemp、date）。含中文文案，变量引用一律 ${VAR}
# 花括号形式——bash 3.2 下中文标点紧跟 $VAR 会把中文字节并进变量名。
#
# 刻意不开 `set -e`：脚本里大量 git 调用「预期可能失败」（非 git 目录、无 origin、
# 无 origin/main、无法 ff），一律显式判返回码，比靠 -e 中断更可控。
set -uo pipefail

readonly THROTTLE_SECONDS=21600   # 6 小时
readonly FETCH_TIMEOUT_SECONDS=5
readonly MAX_LIST=10
readonly EXIT_UPDATE_AVAILABLE=10

# 临时文件统一放一个自建目录，退出时整目录删除。
# （不用「每次 mktemp 追加到列表」的写法：那种登记发生在命令替换的子 shell 里，
#  父 shell 的列表根本不会更新，退出时清不掉。）
WORKDIR=""
cleanup() {
  [ -n "${WORKDIR}" ] && rm -rf "${WORKDIR}"
  return 0
}
trap cleanup EXIT

ensure_workdir() {
  [ -n "${WORKDIR}" ] && return 0
  WORKDIR=$(mktemp -d "${TMPDIR:-/tmp}/skill-update-check.XXXXXX") || return 1
  return 0
}

# ---------------------------------------------------------------- 基础工具

trim() {
  local s="$1"
  while :; do
    case "${s}" in
      [[:space:]]*) s="${s#?}" ;;
      *) break ;;
    esac
  done
  while :; do
    case "${s}" in
      *[[:space:]]) s="${s%?}" ;;
      *) break ;;
    esac
  done
  printf '%s' "${s}"
}

# 解析 symlink 得到脚本实体的绝对路径。
# macOS 无 `readlink -f`，且 skill 目录通常经 ~/.claude/skills/<skill> 这种
# symlink 挂载（symlink 出现在**父目录**上），所以除了逐跳跟 symlink，还必须
# 用 `cd -P` 把父路径解析成物理路径。
resolve_path() {
  local target="$1" dir base guard=0
  while [ -L "${target}" ]; do
    guard=$((guard + 1))
    if [ "${guard}" -gt 40 ]; then
      break
    fi
    dir=$(cd -P "$(dirname "${target}")" 2>/dev/null && pwd) || return 1
    base=$(readlink "${target}") || return 1
    case "${base}" in
      /*) target="${base}" ;;
      *)  target="${dir}/${base}" ;;
    esac
  done
  dir=$(cd -P "$(dirname "${target}")" 2>/dev/null && pwd) || return 1
  printf '%s/%s' "${dir}" "$(basename "${target}")"
}

# 极简 .env 解析（ADR 0003）：KEY=value / KEY="value" / KEY='value'、等号两侧空白、
# `#` 起首整行注释、空行；同名取最后一次；不做 shell 展开 / 命令替换 / 续行。
# 注意：按 ADR 0003 只支持**整行**注释，不支持行尾注释，值须裸写。
read_env_key() {
  local file="$1" key="$2"
  local line k v out="" found=0
  [ -f "${file}" ] || return 1
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    line=$(trim "${line}")
    case "${line}" in
      ''|'#'*) continue ;;
    esac
    case "${line}" in
      'export '*) line=$(trim "${line#export }") ;;
    esac
    case "${line}" in
      *=*) ;;
      *) continue ;;
    esac
    k=$(trim "${line%%=*}")
    [ "${k}" = "${key}" ] || continue
    v=$(trim "${line#*=}")
    case "${v}" in
      '"'*'"') v="${v#\"}"; v="${v%\"}" ;;
      "'"*"'") v="${v#\'}"; v="${v%\'}" ;;
    esac
    out="${v}"
    found=1
  done < "${file}"
  [ "${found}" -eq 1 ] || return 1
  printf '%s' "${out}"
}

# 从 stdin 的 SKILL.md 内容里取 frontmatter 的 version 字段；取不到返回 1。
parse_skill_version() {
  local line in_fm=0 value="" got=0
  while IFS= read -r line || [ -n "${line}" ]; do
    line="${line%$'\r'}"
    if [ "${in_fm}" -eq 0 ]; then
      case "$(trim "${line}")" in
        '---') in_fm=1; continue ;;
        '') continue ;;
        *) return 1 ;;
      esac
    fi
    case "$(trim "${line}")" in
      '---'|'...') break ;;
    esac
    case "${line}" in
      version:*)
        [ "${got}" -eq 1 ] && continue
        value=$(trim "${line#version:}")
        case "${value}" in
          '"'*'"') value="${value#\"}"; value="${value%\"}" ;;
          "'"*"'") value="${value#\'}"; value="${value%\'}" ;;
        esac
        got=1
        ;;
    esac
  done
  [ "${got}" -eq 1 ] && [ -n "${value}" ] || return 1
  printf '%s' "${value}"
}

# 单次 fetch + 硬超时。bash 3.2 没有 GNU timeout，用「后台进程 + watchdog kill」：
#   1. 子 shell 里 `exec` 掉自己，使后台 pid 就是 git 本身（否则 kill 只杀 subshell，
#      git 继续跑）。
#   2. 临时 `set -m` 打开 job control，让这个后台任务成为**独立进程组组长**，
#      超时时用 `kill -TERM -<pid>` 杀掉整个进程组。必须杀整组：实测 git fetch 的
#      `git-remote-https` 子进程卡在 connect() 时不会因父进程死亡而退出，只杀父
#      进程会留下要等 TCP 连接超时（macOS 约 75s）才消失的孤儿进程。
#   3. 先 TERM 后 KILL。
# 同时禁掉终端凭证交互，缺凭证要立刻失败而不是挂住等输入。
fetch_with_timeout() {
  local repo="$1"
  local log pid wpid rc had_monitor=0
  ensure_workdir || return 1
  log="${WORKDIR}/fetch.log"

  case "$-" in *m*) had_monitor=1 ;; esac
  set -m
  (
    exec env \
      GIT_TERMINAL_PROMPT=0 \
      GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=${FETCH_TIMEOUT_SECONDS}" \
      git -C "${repo}" fetch --quiet origin \
        "+refs/heads/main:refs/remotes/origin/main"
  ) >"${log}" 2>&1 &
  pid=$!
  (
    sleep "${FETCH_TIMEOUT_SECONDS}"
    kill -TERM "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null
    sleep 1
    kill -KILL "-${pid}" 2>/dev/null || kill -KILL "${pid}" 2>/dev/null
  ) >/dev/null 2>&1 &
  wpid=$!
  wait "${pid}" 2>/dev/null
  rc=$?
  kill -TERM "${wpid}" 2>/dev/null
  wait "${wpid}" 2>/dev/null
  [ "${had_monitor}" -eq 1 ] || set +m

  return ${rc}
}

# ---------------------------------------------------------------- 定位

SELF=$(resolve_path "$0") || {
  printf '[skill-update-check] 无法解析脚本自身路径，跳过更新检查\n'
  exit 0
}
SCRIPTS_DIR=$(dirname "${SELF}")
SKILL_DIR=$(dirname "${SCRIPTS_DIR}")
NAME=$(basename "${SKILL_DIR}")
CONFIG_DIR="${HOME}/.config/${NAME}"
STAMP_FILE="${CONFIG_DIR}/.update-check-stamp"
ENV_FILE="${CONFIG_DIR}/.env"

usage() {
  cat <<EOF
用法：
  $(basename "${SELF}")           检查是否有更新（默认）
  $(basename "${SELF}") --pull    用户确认后拉取（merge --ff-only，条件不满足即拒绝）
  $(basename "${SELF}") --help    显示本帮助

退出码：0 无事发生 / 拉取成功；10 检测到更新；1 拒绝或失败。
关闭自动检查：在 ${ENV_FILE} 写 AUTO_UPDATE_CHECK=0
EOF
}

# 仓根；非 git 检出返回 1
repo_root() {
  git -C "${SKILL_DIR}" rev-parse --show-toplevel 2>/dev/null
}

# skill 目录相对仓根的路径前缀（仓根本身则为空串）
skill_prefix() {
  local p
  p=$(git -C "${SKILL_DIR}" rev-parse --show-prefix 2>/dev/null) || return 1
  printf '%s' "${p%/}"
}

# ---------------------------------------------------------------- 检查模式

do_check() {
  local switch_value root prefix skill_md_rel
  local now last behind
  local local_ver remote_ver version_clause
  local all_file skill_hash_file mine_file others_file
  local mine_count others_count repo_name

  # 1) 开关
  switch_value=$(read_env_key "${ENV_FILE}" AUTO_UPDATE_CHECK) || switch_value=""
  if [ "${switch_value}" = "0" ]; then
    printf '[%s] 自动检查更新已关闭（%s 中 AUTO_UPDATE_CHECK=0）\n' "${NAME}" "${ENV_FILE}"
    return 0
  fi

  # 2) 仓根
  root=$(repo_root)
  if [ -z "${root}" ]; then
    printf '[%s] 非 git 检出，跳过更新检查\n' "${NAME}"
    return 0
  fi
  prefix=$(skill_prefix) || prefix=""

  # 3) 节流（无论后续网络成败，进入检查前就写新时间戳）
  now=$(date +%s)
  if [ -f "${STAMP_FILE}" ]; then
    last=$(head -n 1 "${STAMP_FILE}" 2>/dev/null | tr -cd '0-9')
    if [ -n "${last}" ] && [ $((now - last)) -lt "${THROTTLE_SECONDS}" ] \
       && [ $((now - last)) -ge 0 ]; then
      printf '[%s] 距上次检查不足 6 小时，跳过\n' "${NAME}"
      return 0
    fi
  fi
  mkdir -p "${CONFIG_DIR}" 2>/dev/null
  printf '%s\n' "${now}" > "${STAMP_FILE}" 2>/dev/null

  # 4) fetch（单次、5s 超时、失败静默跳过）
  if ! fetch_with_timeout "${root}"; then
    printf '[%s] 更新检查未完成（网络失败、超时或远端不可用）\n' "${NAME}"
    return 0
  fi

  # 5) 落后提交数
  behind=$(git -C "${root}" rev-list --count HEAD..origin/main 2>/dev/null) || behind=""
  if [ -z "${behind}" ]; then
    printf '[%s] 更新检查未完成（无法比对 origin/main）\n' "${NAME}"
    return 0
  fi
  if [ "${behind}" -eq 0 ]; then
    printf '[%s] 已是最新\n' "${NAME}"
    return 0
  fi

  # 6) 版本对比（任一侧解析失败则跳过版本子句，只报提交）
  if [ -n "${prefix}" ]; then
    skill_md_rel="${prefix}/SKILL.md"
  else
    skill_md_rel="SKILL.md"
  fi
  local_ver=""
  if [ -f "${SKILL_DIR}/SKILL.md" ]; then
    local_ver=$(parse_skill_version < "${SKILL_DIR}/SKILL.md") || local_ver=""
  fi
  remote_ver=$(git -C "${root}" show "origin/main:${skill_md_rel}" 2>/dev/null \
               | parse_skill_version) || remote_ver=""
  version_clause=""
  if [ -n "${local_ver}" ] && [ -n "${remote_ver}" ]; then
    if [ "${local_ver}" = "${remote_ver}" ]; then
      version_clause="，版本 v${local_ver}（未变）"
    else
      version_clause="，版本 v${local_ver} → v${remote_ver}"
    fi
  fi

  # 7) 提交摘要按路径分两段
  ensure_workdir || return 0
  all_file="${WORKDIR}/all"
  skill_hash_file="${WORKDIR}/skill-hashes"
  mine_file="${WORKDIR}/mine"
  others_file="${WORKDIR}/others"

  git -C "${root}" log --format='%h %s' HEAD..origin/main > "${all_file}" 2>/dev/null

  if [ -n "${prefix}" ]; then
    # 哨兵行：awk 的 NR==FNR 双文件写法在第一个文件为空时会误判，垫一行避免。
    printf '__sentinel__\n' > "${skill_hash_file}"
    git -C "${root}" log --format='%h' HEAD..origin/main -- "${prefix}" \
      >> "${skill_hash_file}" 2>/dev/null
    awk 'NR==FNR { keep[$1]=1; next } ($1 in keep)' \
      "${skill_hash_file}" "${all_file}" > "${mine_file}"
    awk 'NR==FNR { keep[$1]=1; next } !($1 in keep)' \
      "${skill_hash_file}" "${all_file}" > "${others_file}"
  else
    # skill 在仓根：所有提交都算「本 skill 的更新」，不输出第二段。
    cp "${all_file}" "${mine_file}"
    : > "${others_file}"
  fi

  mine_count=$(wc -l < "${mine_file}" | tr -d ' ')
  others_count=$(wc -l < "${others_file}" | tr -d ' ')
  repo_name=$(basename "${root}")

  printf '[%s] 检测到更新：本地落后远端 %s 个提交%s\n' \
    "${NAME}" "${behind}" "${version_clause}"

  if [ "${mine_count}" -gt 0 ]; then
    printf '本 skill 的更新：\n'
    sed -n "1,${MAX_LIST}p" "${mine_file}" | sed 's/^/  /'
    if [ "${mine_count}" -gt "${MAX_LIST}" ]; then
      printf '  另有 %s 条\n' "$((mine_count - MAX_LIST))"
    fi
  fi
  if [ "${others_count}" -gt 0 ]; then
    printf '同仓其他改动（pull 会一并带入）：\n'
    sed -n "1,${MAX_LIST}p" "${others_file}" | sed 's/^/  /'
    if [ "${others_count}" -gt "${MAX_LIST}" ]; then
      printf '  另有 %s 条\n' "$((others_count - MAX_LIST))"
    fi
  fi

  printf '是否拉取？（pull 单位是整个 %s 仓，需工作树干净且可 fast-forward）\n' "${repo_name}"
  return "${EXIT_UPDATE_AVAILABLE}"
}

# ---------------------------------------------------------------- 拉取模式

do_pull() {
  local root branch dirty ok=1 new_ver head_line

  root=$(repo_root)
  if [ -z "${root}" ]; then
    printf '[%s] 拒绝拉取：%s 不在任何 git 检出内\n' "${NAME}" "${SKILL_DIR}"
    return 1
  fi

  if ! git -C "${root}" rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
    printf '[%s] 拒绝拉取：本地没有 origin/main 引用，请先跑一次检查\n' "${NAME}"
    return 1
  fi

  branch=$(git -C "${root}" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "${branch}" != "main" ]; then
    printf '[%s] 拒绝拉取：当前分支不是 main（当前 %s）\n' "${NAME}" "${branch:-detached HEAD}"
    ok=0
  fi

  # 跟踪文件必须干净；untracked 不阻塞
  dirty=$(git -C "${root}" status --porcelain --untracked-files=no 2>/dev/null)
  if [ -n "${dirty}" ]; then
    printf '[%s] 拒绝拉取：工作树有未提交改动（%s 个跟踪文件）\n' \
      "${NAME}" "$(printf '%s\n' "${dirty}" | wc -l | tr -d ' ')"
    printf '%s\n' "${dirty}" | sed -n '1,10p' | sed 's/^/  /'
    if [ "$(printf '%s\n' "${dirty}" | wc -l | tr -d ' ')" -gt 10 ]; then
      printf '  ……（其余省略）\n'
    fi
    ok=0
  fi

  if ! git -C "${root}" merge-base --is-ancestor HEAD origin/main 2>/dev/null; then
    printf '[%s] 拒绝拉取：本地与 origin/main 已分叉，无法 fast-forward（本地领先 %s 个提交，落后 %s 个）\n' \
      "${NAME}" \
      "$(git -C "${root}" rev-list --count origin/main..HEAD 2>/dev/null)" \
      "$(git -C "${root}" rev-list --count HEAD..origin/main 2>/dev/null)"
    ok=0
  fi

  if [ "${ok}" -ne 1 ]; then
    printf '[%s] 未做任何改动。请自行处理上述问题后重试（本脚本不会 commit / reset / checkout）。\n' "${NAME}"
    return 1
  fi

  if ! git -C "${root}" merge --ff-only origin/main; then
    printf '[%s] 拉取失败：merge --ff-only 未成功，工作树未改变\n' "${NAME}"
    return 1
  fi

  new_ver=""
  if [ -f "${SKILL_DIR}/SKILL.md" ]; then
    new_ver=$(parse_skill_version < "${SKILL_DIR}/SKILL.md") || new_ver=""
  fi
  head_line=$(git -C "${root}" log -1 --format='%h %s' 2>/dev/null)
  if [ -n "${new_ver}" ]; then
    printf '[%s] 已更新到 v%s\n' "${NAME}" "${new_ver}"
  else
    printf '[%s] 已更新\n' "${NAME}"
  fi
  printf 'HEAD：%s\n' "${head_line}"
  return 0
}

# ---------------------------------------------------------------- 入口

case "${1:-}" in
  ''|--check|check)
    do_check
    exit $?
    ;;
  --pull|pull)
    do_pull
    exit $?
    ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    printf '未知参数：%s\n' "$1" >&2
    usage >&2
    exit 1
    ;;
esac
