"""Focused blue-theme and contrast acceptance on a temporary local server; no production data or model calls."""
from __future__ import annotations

import argparse
import colorsys
import importlib.util
import json
import math
from pathlib import Path
import re
import sys

import httpx
from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "environment/verification/ui-blue-theme"
UI_RUNNER = ROOT / "environment/scripts/verify-ui-v0.1.2.py"

# Values from the retired green theme. The check is deliberately literal so a
# renamed token cannot hide an old color behind a new name.
OLD_GREEN_HEX = {
    "#294035", "#5d6c5d", "#247e64", "#173e33", "#207a62", "#19664f",
    "#e3e9df", "#fcfdfb", "#f5f7f2", "#fbfcf9", "#eef2e9", "#e8efe2",
    "#e5eee0", "#dce9d4", "#afc6b8", "#315c49", "#f0fff5", "#c4e5d5",
    "#1c4a39", "#e3e9dc", "#4e683c", "#dcece2", "#cfdfcc", "#375c42",
    "#e1efd9", "#d6e5cb", "#e9eee2", "#25372c", "#ede8dc", "#715f38",
    "#7a8b7a", "#1b654e", "#eff8ec", "#81a982", "#1c3a2b", "#193c31",
    "#132e24", "#234c3f", "#43b998", "#25866c",
}


def load_ui_runner():
    spec = importlib.util.spec_from_file_location("verify_ui_v012", UI_RUNNER)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def parse_rgb(value):
    value = value.strip()
    if value.startswith("#"):
        digits = value[1:]
        if len(digits) == 3:
            digits = "".join(character * 2 for character in digits)
        if len(digits) == 8:
            digits = digits[:6]
        if len(digits) == 6:
            return tuple(int(digits[index:index + 2], 16) for index in (0, 2, 4))
        return None
    match = re.match(r"rgba?\(([\d.]+)[, ]+([\d.]+)[, ]+([\d.]+)", value)
    if not match:
        return None
    return tuple(round(float(part)) for part in match.groups())


def to_hex(value):
    rgb = parse_rgb(value)
    return "#%02x%02x%02x" % rgb if rgb else None


def luminance(value):
    rgb = parse_rgb(value)
    if not rgb:
        return None
    channels = [component / 255 for component in rgb]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def contrast(foreground, background):
    first, second = luminance(foreground), luminance(background)
    if first is None or second is None:
        raise ValueError(f"Unsupported color pair: {foreground!r}, {background!r}")
    return (max(first, second) + 0.05) / (min(first, second) + 0.05)


def hsv(value):
    rgb = parse_rgb(value)
    if not rgb:
        return None
    return colorsys.rgb_to_hsv(*(component / 255 for component in rgb))


def add_contrast(results, name, foreground, background, minimum):
    ratio = contrast(foreground, background)
    passed = ratio >= minimum
    results["contrast"].append({
        "pair": name,
        "foreground": to_hex(foreground),
        "background": to_hex(background),
        "ratio": round(ratio, 2),
        "minimum": minimum,
        "passed": passed,
    })
    assert passed, f"{name} contrast {ratio:.2f} is below {minimum}:1"


def add_blue(results, name, value, minimum_saturation=0.35):
    h, s, v = hsv(value)
    hue = round(h * 360, 1)
    passed = 205 <= hue <= 250 and s >= minimum_saturation and v >= 0.2
    results["theme"].append({
        "role": name,
        "value": to_hex(value),
        "hue": hue,
        "saturation": round(s, 2),
        "brightness": round(v, 2),
        "passed": passed,
    })
    assert passed, f"{name} is not a blue role: {to_hex(value)} hue={hue} saturation={s:.2f}"


def css(page, selector, prop):
    value = page.locator(selector).first.evaluate(
        "(element, property) => getComputedStyle(element).getPropertyValue(property)", prop
    )
    return value.strip()


def root_tokens(page):
    return page.evaluate("""() => {
        const style = getComputedStyle(document.documentElement);
        return {
            primary: style.getPropertyValue('--primary').trim(),
            primaryDeep: style.getPropertyValue('--primary-deep').trim(),
            primaryHover: style.getPropertyValue('--primary-hover').trim(),
            primaryPressed: style.getPropertyValue('--primary-pressed').trim(),
            accent: style.getPropertyValue('--accent').trim(),
            ink: style.getPropertyValue('--ink').trim(),
            muted: style.getPropertyValue('--muted').trim(),
            paper: style.getPropertyValue('--paper').trim(),
            surface: style.getPropertyValue('--surface').trim(),
            fieldLine: style.getPropertyValue('--field-line').trim(),
            focus: style.getPropertyValue('--focus').trim(),
            warning: style.getPropertyValue('--warning').trim(),
            red: style.getPropertyValue('--red').trim(),
            errorSurface: style.getPropertyValue('--error-surface').trim(),
            selectionSurface: style.getPropertyValue('--selection-surface').trim(),
            selectionInk: style.getPropertyValue('--selection-ink').trim(),
            railInk: style.getPropertyValue('--rail-ink').trim(),
            railActive: style.getPropertyValue('--rail-active').trim(),
            inverseInk: style.getPropertyValue('--inverse-ink').trim(),
        };
    }""")


def visible_colors(page):
    return page.evaluate("""() => {
        const values = [];
        for (const element of document.querySelectorAll('*')) {
            const style = getComputedStyle(element);
            for (const property of ['color', 'backgroundColor', 'borderTopColor',
                                    'borderRightColor', 'borderBottomColor', 'borderLeftColor',
                                    'outlineColor']) {
                const value = style.getPropertyValue(property);
                if (value && value !== 'rgba(0, 0, 0, 0)') {
                    values.push({property, value});
                }
            }
        }
        return values;
    }""")


def check_old_residue(results):
    source_text = "\n".join(
        path.read_text(encoding="utf-8")
        for path in sorted((ROOT / "workspace/client").glob("*"))
        if path.suffix.lower() in {".css", ".js", ".html", ".svg"}
    )
    lowered = source_text.lower()
    found = [value for value in sorted(OLD_GREEN_HEX) if value in lowered]
    legacy_names = [name for name in ["--green", "--avatar-olive", "accent-hover", "accent-pressed"] if name in source_text]
    results["old_palette"] = {"hex_found": found, "legacy_names_found": legacy_names}
    assert not found, f"Old green palette values remain in client source: {found}"
    assert not legacy_names, f"Old green token names remain in client source: {legacy_names}"


def check_visible_greens(results, page):
    greens = []
    for item in visible_colors(page):
        h, s, v = hsv(item["value"])
        if s >= 0.12 and v >= 0.12 and 80 <= h * 360 <= 190:
            greens.append({"property": item["property"], "value": to_hex(item["value"]),
                           "hue": round(h * 360, 1), "saturation": round(s, 2)})
    results["visible_greens"] = greens
    assert not greens, f"Green-family colors remain visible: {greens[:5]}"


def run(output):
    output.mkdir(parents=True, exist_ok=True)
    results = {
        "version": "0.1.3",
        "status": "running",
        "scope": "Temporary isolated accounts, real Chrome/HTTP/SQLite; no Harness or model.",
        "screenshots": [],
        "checks": [],
        "theme": [],
        "contrast": [],
        "visible_greens": [],
        "old_palette": {},
    }
    runner = load_ui_runner()
    try:
        check_old_residue(results)
        with runner.isolated_server() as (base, accounts, store):
            with httpx.Client(base_url=base, timeout=30, trust_env=False) as api:
                token = runner.response_json(api.post("/api/login", json={
                    "username": accounts["admin"]["username"],
                    "password": accounts["admin"]["password"],
                }))["token"]
                api.headers["Authorization"] = f"Bearer {token}"
                alice_token = runner.response_json(api.post("/api/login", json={
                    "username": accounts["alice"]["username"],
                    "password": accounts["alice"]["password"],
                }))["token"]
                conversation = runner.response_json(api.post("/api/conversations", json={
                    "title": "蓝色主题验收",
                    "member_ids": [accounts["alice"]["user"]["id"]],
                    "is_direct": False,
                }))
                with httpx.Client(base_url=base, timeout=30, trust_env=False,
                                  headers={"Authorization": f"Bearer {alice_token}"}) as alice_api:
                    runner.response_json(alice_api.post(
                        f"/api/conversations/{conversation['id']}/messages",
                        json={"text": "蓝色主题下，文字和气泡仍然清楚。", "client_id": "blue-theme-alice"},
                    ))
                runner.response_json(api.post(
                    f"/api/conversations/{conversation['id']}/messages",
                    json={"text": "登录页和主界面使用同一套蓝色。", "client_id": "blue-theme-admin"},
                ))

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    context = browser.new_context(viewport={"width": 1280, "height": 860}, timezone_id="Asia/Shanghai")
                    page = context.new_page()
                    errors = []
                    page.on("pageerror", lambda error: errors.append(str(error)))

                    def shot(name):
                        page.screenshot(path=str(output / name))
                        results["screenshots"].append(name)

                    page.goto(base)
                    expect(page.locator("#login-view")).to_be_visible()
                    tokens = root_tokens(page)
                    for width, height in [(1280, 860), (960, 680)]:
                        page.set_viewport_size({"width": width, "height": height})
                        expect(page.locator("#login-submit")).to_be_in_viewport()
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                        shot(f"login-{width}.png")
                    page.set_viewport_size({"width": 1280, "height": 860})

                    add_blue(results, "登录按钮", css(page, "#login-submit", "background-color"))
                    add_blue(results, "品牌标题", css(page, ".brand", "color"))
                    assert to_hex(css(page, ".brand", "color")) == to_hex(tokens["primaryDeep"])
                    add_contrast(results, "登录按钮文字", css(page, "#login-submit", "color"),
                                 css(page, "#login-submit", "background-color"), 4.5)
                    add_contrast(results, "输入占位文字", page.locator("#username").evaluate(
                        "(element) => getComputedStyle(element, '::placeholder').color"),
                        css(page, ".input-icon", "background-color"), 4.5)
                    add_contrast(results, "输入框边界", css(page, ".input-icon", "border-top-color"),
                                 css(page, ".input-icon", "background-color"), 3.0)
                    results["checks"].append("Login is centered, blue-branded, readable and within 1280/960 viewports")

                    page.locator("#username").fill(accounts["admin"]["username"])
                    page.locator("#password").fill(accounts["admin"]["password"])
                    page.locator("#login-submit").click()
                    expect(page.locator("#app-view")).to_be_visible()
                    expect(page.locator("#connection-dot")).to_have_attribute("aria-label", "已连接", timeout=15000)
                    expect(page.locator("#conversation-list .conversation")).to_have_count(1, timeout=15000)

                    unread = page.locator("#conversation-list .unread").first
                    if unread.count() == 0:
                        with httpx.Client(base_url=base, timeout=30, trust_env=False,
                                          headers={"Authorization": f"Bearer {alice_token}"}) as alice_api:
                            runner.response_json(alice_api.post(
                                f"/api/conversations/{conversation['id']}/messages",
                                json={"text": "未读提醒也要保持清晰。", "client_id": "blue-theme-unread"},
                            ))
                    expect(unread).to_be_visible(timeout=15000)
                    add_blue(results, "未读强调", css(page, "#conversation-list .unread", "background-color"))
                    add_contrast(results, "未读数字", css(page, "#conversation-list .unread", "color"),
                                 css(page, "#conversation-list .unread", "background-color"), 4.5)
                    shot("conversations-1280.png")

                    page.locator("#conversation-list .conversation").first.click()
                    expect(page.locator("#active-chat")).to_be_visible()
                    expect(page.locator("#chat-title")).to_have_text("蓝色主题验收")
                    expect(page.locator("#message-items .message")).to_have_count(2, timeout=15000)
                    add_blue(results, "导航栏", css(page, ".rail", "background-color"))
                    add_blue(results, "会话背景", css(page, ".chat-area", "background-color"), 0.02)
                    add_blue(results, "自身消息气泡", css(page, ".message.own .bubble", "background-color"), 0.10)
                    add_contrast(results, "导航文字", css(page, ".rail-button", "color"),
                                 css(page, ".rail", "background-color"), 4.5)
                    add_contrast(results, "自身消息文字", css(page, ".message.own .bubble", "color"),
                                 css(page, ".message.own .bubble", "background-color"), 4.5)
                    add_contrast(results, "会话时间", css(page, ".conversation-time", "color"),
                                 css(page, ".conversation", "background-color"), 4.5)
                    results["checks"].append("Chat rail, own bubble, unread badge and conversation surfaces all use the blue roles")

                    for width, height in [(1280, 860), (960, 680)]:
                        page.set_viewport_size({"width": width, "height": height})
                        expect(page.locator("#send-message")).to_be_in_viewport()
                        expect(page.locator("#message-input")).to_be_in_viewport()
                        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
                        shot(f"chat-{width}.png")
                    page.set_viewport_size({"width": 1280, "height": 860})

                    page.locator("#nav-members").click()
                    expect(page.locator("#modal h2")).to_have_text("成员")
                    shot("members-1280.png")
                    page.get_by_role("button", name="关闭", exact=True).click()
                    page.locator("#nav-settings").click()
                    shot("settings-1280.png")
                    page.get_by_role("button", name="关闭", exact=True).click()

                    check_visible_greens(results, page)
                    add_contrast(results, "正文", css(page, "body", "color"), tokens["paper"], 4.5)
                    add_contrast(results, "次要文字", tokens["muted"], tokens["surface"], 4.5)
                    add_contrast(results, "焦点环", tokens["focus"], tokens["paper"], 3.0)
                    add_contrast(results, "选中文字", tokens["selectionInk"], tokens["selectionSurface"], 4.5)
                    add_contrast(results, "错误文字", tokens["red"], tokens["errorSurface"], 4.5)
                    add_contrast(results, "警告文字", tokens["warning"], tokens["surface"], 4.5)
                    add_contrast(results, "导航激活文字", tokens["inverseInk"], tokens["railActive"], 4.5)
                    add_contrast(results, "输入边界令牌", tokens["fieldLine"], tokens["surface"], 3.0)
                    assert not errors, f"Browser page errors: {errors}"
                    results["checks"].append("Visible computed colors contain no green-family surface, text or border")
                    results["checks"].append("Blue roles and WCAG AA contrast pass for text, controls and focus")
                finally:
                    browser.close()
        results["status"] = "passed"
        results["checks"].append("Owned server thread stopped and temporary data removed")
    except Exception as error:
        results["status"] = "failed"
        results["failure_type"] = type(error).__name__
        results["failure"] = str(error)
        raise
    finally:
        (output / "theme-report.json").write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps(results, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    arguments = parser.parse_args()
    run(arguments.output_dir.resolve())
