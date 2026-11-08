#!/usr/bin/env python3
"""在明确项目根 clone，或在干净的 origin 工作副本中仅快进同步。"""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit


class SyncError(Exception):
    """需要先处理仓库状态或本机环境的问题。"""


def git(project, *args, check=True):
    """不经过 shell 执行 Git，避免在异常信息中输出认证地址。"""
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    try:
        result = subprocess.run(
            ["git", "-C", str(project), *args],
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            check=False,
        )
    except OSError as exc:
        raise SyncError("无法启动 Git；请确认本机已安装并可执行 git。") from exc
    if check and result.returncode:
        raise SyncError(
            "Git %s 失败（退出码 %s）；请在本机检查仓库状态、网络和认证。"
            % (args[0], result.returncode)
        )
    return result


def validate_address(address):
    """限制可自动使用的传输方式，并拒绝带密码或 HTTP 凭证的地址。"""
    if not address or address.startswith("-") or "\n" in address or "\r" in address:
        raise SyncError("Git 地址为空或格式不适合自动同步。")
    if "::" in address:
        raise SyncError("自动同步不支持外部 Git transport helper 地址。")
    if "://" in address:
        parsed = urlsplit(address)
        if parsed.scheme not in {"https", "http", "ssh", "git", "file"}:
            raise SyncError("不支持此 Git 地址传输协议。")
        if parsed.password or (parsed.scheme in {"https", "http"} and parsed.username):
            raise SyncError("Git 地址不能包含密码或 HTTP 凭证；请用本机凭证管理器。")
    return address


def normalized(address):
    """只归一化末尾斜杠与 .git；不自动替换 HTTPS/SSH 身份。"""
    value = address.rstrip("/\\")
    return value[:-4] if value.endswith(".git") else value


def inspect(project, supplied_address):
    """同步前核对工作副本、分支、origin、upstream 与未提交改动。"""
    root = git(project, "rev-parse", "--show-toplevel", check=False)
    if root.returncode:
        raise SyncError("目标不是 Git 工作副本；首次接手必须提供 --git-url。")
    if Path(root.stdout.strip()).resolve() != project:
        raise SyncError("目标不是 Git 根目录；请明确项目根，避免操作父仓库。")
    branch = git(project, "symbolic-ref", "--quiet", "--short", "HEAD", check=False)
    if branch.returncode:
        raise SyncError("当前是 detached HEAD；先明确要接续的分支。")
    if git(project, "rev-parse", "--verify", "HEAD", check=False).returncode:
        raise SyncError("仓库还没有提交；不能按既有项目执行 pull。")
    origin = git(project, "remote", "get-url", "origin", check=False)
    if origin.returncode:
        raise SyncError("仓库没有 origin；请先明确需要同步的 remote。")
    address = validate_address(origin.stdout.strip())
    if supplied_address and normalized(address) != normalized(supplied_address):
        raise SyncError("提供的 Git 地址与 origin 不符；未修改 remote。")
    branch_name = branch.stdout.strip()
    upstream = git(project, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}", check=False)
    if upstream.returncode:
        raise SyncError("当前分支没有可解析的 upstream；先确认远端跟踪分支。")
    tracking_remote = git(project, "config", "--get", "branch.%s.remote" % branch_name, check=False)
    if tracking_remote.stdout.strip() != "origin":
        raise SyncError("当前分支未跟踪 origin；请人工确认同步目标。")
    if git(project, "status", "--porcelain", "--untracked-files=normal").stdout:
        raise SyncError("工作区存在未提交或未跟踪修改；未 stash/reset/覆盖，请先审查。")
    worktrees = git(project, "worktree", "list", "--porcelain").stdout
    return branch_name, upstream.stdout.strip(), worktrees.count("worktree ")


def sync(project, supplied_address=None):
    project = project.expanduser().resolve()
    if supplied_address:
        validate_address(supplied_address)
    exists = project.exists()
    if exists and not project.is_dir():
        raise SyncError("项目目标已经存在且不是目录。")
    is_repo = exists and not git(project, "rev-parse", "--show-toplevel", check=False).returncode
    cloned = False
    if not is_repo:
        if not supplied_address:
            raise SyncError("首次接手必须提供 --git-url；已有项目请指定 Git 根目录。")
        if exists and any(project.iterdir()):
            raise SyncError("目标目录非空；不会覆盖或清空已有文件。")
        if not project.parent.is_dir():
            raise SyncError("父目录不存在；先检查父目录布局并建立明确的项目位置。")
        parent_repo = git(project.parent, "rev-parse", "--show-toplevel", check=False)
        if not parent_repo.returncode:
            raise SyncError("父目录位于另一个 Git 仓库内；请先明确独立项目根。")
        git(project.parent, "clone", "--origin", "origin", "--", supplied_address, str(project))
        cloned = True
    branch, upstream, worktree_count = inspect(project, supplied_address)
    before = git(project, "rev-parse", "HEAD").stdout.strip()
    git(project, "fetch", "--prune", "origin")
    inspect(project, supplied_address)
    counts = git(project, "rev-list", "--left-right", "--count", "HEAD...@{upstream}").stdout.split()
    ahead, behind = map(int, counts)
    if ahead and behind:
        raise SyncError("本地与 upstream 已分叉；只完成 fetch，未合并、rebase 或覆盖。")
    git(project, "pull", "--ff-only")
    after = git(project, "rev-parse", "HEAD").stdout.strip()
    inspect(project, supplied_address)
    return {
        "action": "cloned" if cloned else "pulled",
        "project": str(project),
        "branch": branch,
        "upstream": upstream,
        "before": before,
        "head": after,
        "local_commits_ahead": ahead,
        "worktree_count": worktree_count,
    }


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=Path, default=Path.cwd(), help="明确的项目 Git 根；默认当前目录")
    parser.add_argument("--git-url", help="首次必传；后续省略则使用 origin，传入则核对一致性")
    args = parser.parse_args()
    try:
        print(json.dumps(sync(args.project, args.git_url), ensure_ascii=False, indent=2))
    except (SyncError, ValueError) as exc:
        print("同步停止：%s" % exc, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
