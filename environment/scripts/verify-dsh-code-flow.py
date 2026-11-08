"""Explicit, bounded live DSH acceptance in a clean isolated checkout of this repository."""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys

import httpx

ROOT = Path(__file__).resolve().parents[2]


def run(args):
    if not args.live:
        raise SystemExit('This invokes the configured real DSH model. Pass --live explicitly with a clean --worktree.')
    worktree = args.worktree.resolve()
    root = subprocess.check_output(['git', '-C', str(worktree), 'rev-parse', '--show-toplevel'], text=True).strip()
    if Path(root).resolve() != worktree or worktree == ROOT:
        raise SystemExit('Use the root of an isolated Git worktree, never the active development checkout.')
    status = subprocess.check_output(['git', '-C', str(worktree), 'status', '--porcelain'], text=True)
    if status:
        raise SystemExit('Acceptance worktree has changes; preserving them. Prepare a new clean worktree.')
    initial_head = subprocess.check_output(['git', '-C', str(worktree), 'rev-parse', 'HEAD'], text=True).strip()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    if (output / 'live-config.json').exists():
        raise SystemExit('This output already belongs to a run; preserve it and choose another directory.')
    fixture = worktree / 'workspace/automation_acceptance'
    if fixture.exists():
        raise SystemExit('Acceptance fixture path already exists; preserving it.')
    fixture.mkdir()
    code = fixture / 'counter.py'
    code.write_text('def active_member_count(members):\n    return sum(1 for member in members if member.get("active", False)) - 1\n', encoding='utf-8')
    test = fixture / 'test_counter.py'
    test.write_text('from counter import active_member_count\n\ndef test_counts_active_members():\n    assert active_member_count([]) == 0\n    assert active_member_count([{ "active": True }]) == 1\n    assert active_member_count([{ "active": True }, { "active": False }, { "active": True }]) == 2\n', encoding='utf-8')
    baseline = subprocess.run([sys.executable, '-m', 'pytest', str(test), '-q'], cwd=worktree, capture_output=True, text=True)
    if baseline.returncode != 1:
        raise RuntimeError('The intentionally broken acceptance fixture did not fail as expected.')
    before = code.read_text(encoding='utf-8')
    spec = importlib.util.spec_from_file_location('team_relay_ui_fixture', ROOT / 'environment/scripts/verify-ui-v0.1.2.py')
    fixture_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fixture_module)
    with fixture_module.isolated_server() as (base, accounts, store):
        with httpx.Client(base_url=base, trust_env=False, timeout=20) as api:
            login = api.post('/api/login', json={'username': 'admin', 'password': accounts['admin']['password']})
            login.raise_for_status()
            api.headers['Authorization'] = 'Bearer ' + login.json()['token']
            group = api.post('/api/conversations', json={'title': 'DSH自动代码验收（合成）', 'member_ids': [accounts['dsh']['user']['id']], 'is_direct': False})
            group.raise_for_status()
            cid = group.json()['id']
            background = api.post(f'/api/conversations/{cid}/messages', json={'text': '这轮只验收当前项目的隔离副本，只处理 workspace/automation_acceptance/counter.py，不要修改其他文件，不要提交、推送或部署。', 'client_id': 'acceptance-context'})
            background.raise_for_status()
            command = f'& "{sys.executable}" -m pytest workspace/automation_acceptance/test_counter.py -q'
            task = api.post(f'/api/conversations/{cid}/messages', json={'text': f'这个文件的在线成员计数总是少一个，空列表还变成负数，需要修复。请保持测试文件不变，修好后在项目根运行这个 PowerShell 命令验证：{command}。不要提交或推送，只回报真实修改和测试。', 'client_id': 'acceptance-task'})
            task.raise_for_status()
            token = store.issue_session(accounts['dsh']['user']['id'], 900)
            setup = dict(baseUrl=base, bot=accounts['dsh']['user'], conversationId=cid, senderId=accounts['admin']['user']['id'], priorMessageId=background.json()['id'], eventId=task.json()['id'], cwd=str(worktree), output=str(output), cliPath=str(args.cli.resolve()))
            config = output / 'live-config.json'
            config.write_text(json.dumps(setup, ensure_ascii=False, indent=2), encoding='utf-8')
            environment = {**os.environ, 'TEAM_RELAY_BOT_TOKEN': token}
            result = subprocess.run(['node', str(ROOT / 'workspace/bridge/verify-live-flow.mjs'), str(config)], cwd=ROOT, env=environment, capture_output=True, text=True, encoding='utf-8', timeout=400)
            (output / 'driver.log').write_text(result.stdout + result.stderr, encoding='utf-8')
            if result.returncode:
                raise RuntimeError('Live flow did not complete. Inspect the ignored acceptance logs; no automatic retry.')
    check = subprocess.run([sys.executable, '-m', 'pytest', str(test), '-q'], cwd=worktree, capture_output=True, text=True)
    (output / 'pytest.log').write_text(check.stdout + check.stderr, encoding='utf-8')
    if check.returncode or code.read_text(encoding='utf-8') == before:
        raise RuntimeError('Real code diff and independent tests did not both pass.')
    expected_test = 'from counter import active_member_count\n\ndef test_counts_active_members():\n    assert active_member_count([]) == 0\n    assert active_member_count([{ "active": True }]) == 1\n    assert active_member_count([{ "active": True }, { "active": False }, { "active": True }]) == 2\n'
    if test.read_text(encoding='utf-8') != expected_test:
        raise RuntimeError('The worker altered the acceptance test.')
    final_head = subprocess.check_output(['git', '-C', str(worktree), 'rev-parse', 'HEAD'], text=True).strip()
    tracked = subprocess.check_output(['git', '-C', str(worktree), 'diff', '--name-only', 'HEAD'], text=True).strip()
    staged = subprocess.check_output(['git', '-C', str(worktree), 'diff', '--cached', '--name-only'], text=True).strip()
    untracked = set(subprocess.check_output(['git', '-C', str(worktree), 'ls-files', '--others', '--exclude-standard'], text=True).splitlines())
    expected = {'workspace/automation_acceptance/counter.py', 'workspace/automation_acceptance/test_counter.py'}
    if final_head != initial_head or tracked or staged or untracked != expected:
        raise RuntimeError('The worker changed files or Git history outside the declared fixture.')
    (output / 'code-before.py').write_text(before, encoding='utf-8')
    (output / 'code-after.py').write_text(code.read_text(encoding='utf-8'), encoding='utf-8')
    summary = json.loads((output / 'flow-result.json').read_text(encoding='utf-8'))
    summary.update(independentPytestExitCode=check.returncode, fixtureTestUnchanged=True, fixtureOnly=True, productionCodeMerged=False, unrelatedFilesOrHistoryChanged=False)
    (output / 'summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
    print(json.dumps(summary, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--worktree', type=Path, required=True)
    parser.add_argument('--cli', type=Path, default=Path('D:/Work/ai/deepseek-harness/resources/runtime/cli/bin/dsh.cmd'))
    parser.add_argument('--output', type=Path, default=ROOT / 'environment/verification/dsh-auto-v0.2.0/live')
    run(parser.parse_args())
