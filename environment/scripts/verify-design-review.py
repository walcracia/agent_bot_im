"""Capture the isolated design review, checking real DOM, keyboard access and contrast.

This verifier connects only to the local preview server. It never starts the IM,
reads a runtime database or uses a DSH/model session. Screens show the preview's
explicit synthetic fixture through the copied client rendering code.
"""
from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import sys
from urllib.parse import urlencode, urlsplit

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
THEMES = {"blue": "A 霁蓝", "sand": "B 暖砂", "graphite": "C 石墨", "dusk": "D 暮紫"}
SIZES = ((1280, 860), (960, 680))
PAIR_DEFINITIONS = (
    ("body", "--ink", "--surface-white", 4.5),
    ("secondary", "--muted", "--paper", 4.5),
    ("primary", "--primary-ink", "--primary", 4.5),
    ("field-edge", "--field-line", "--surface-white", 3.0),
    ("focus", "--focus", "--paper", 3.0),
    ("own-message", "--ink", "--own-bubble", 4.5),
)


def luminance(rgb):
    values = [number / 255 for number in rgb[:3]]
    channels = [value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4 for value in values]
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722


def contrast(first, second):
    a, b = luminance(first), luminance(second)
    return (max(a, b) + 0.05) / (min(a, b) + 0.05)


def check(case, name, condition, **evidence):
    case["checks"].append({"name": name, "passed": bool(condition), **evidence})


def colors(page):
    names = sorted({name for _, first, second, _ in PAIR_DEFINITIONS for name in (first, second)})
    return page.evaluate("""names => {
      const source = getComputedStyle(document.documentElement);
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', {willReadFrequently: true});
      return Object.fromEntries(names.map(name => {
        const value = source.getPropertyValue(name).trim();
        if (!value || !CSS.supports('color', value)) return [name, {value, valid: false}];
        context.clearRect(0, 0, 1, 1); context.fillStyle = value; context.fillRect(0, 0, 1, 1);
        return [name, {value, valid: true, rgb: [...context.getImageData(0, 0, 1, 1).data]}];
      }));
    }""", names)


def assert_contrasts(page, case):
    palette = colors(page)
    case["tokens"] = palette
    for name, foreground, background, minimum in PAIR_DEFINITIONS:
        first, second = palette[foreground], palette[background]
        valid = first["valid"] and second["valid"]
        ratio = contrast(first["rgb"], second["rgb"]) if valid else None
        check(case, "contrast-" + name, valid and ratio >= minimum,
              foreground=first, background=second,
              ratio=round(ratio, 3) if ratio is not None else None, minimum=minimum)
    selector = "#send-message" if case["screen"] == "chat" else "#login-submit"
    actual = page.locator(selector).evaluate("""element => {
      const style = getComputedStyle(element), canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1; const context = canvas.getContext('2d', {willReadFrequently: true});
      function rgba(value) {context.clearRect(0,0,1,1); context.fillStyle=value; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data];}
      return {foreground: rgba(style.color), background: rgba(style.backgroundColor), color:style.color, fill:style.backgroundColor};
    }""")
    ratio = contrast(actual["foreground"], actual["background"])
    check(case, "actual-primary-control-contrast", actual["background"][3] == 255 and ratio >= 4.5,
          **actual, ratio=round(ratio, 3), minimum=4.5)


def layout_checks(page, case):
    data = page.evaluate("""() => {
      const viewport = innerWidth;
      const rect = selector => { const e=document.querySelector(selector); if(!e || !e.getClientRects().length) return null;
        const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}; };
      return {viewport, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth,
        htmlOverflow: getComputedStyle(document.documentElement).overflowX, bodyOverflow:getComputedStyle(document.body).overflowX,
        login:rect('.login-panel'), composer:rect('#composer'), send:rect('#send-message'), sidebar:rect('.sidebar')};
    }""")
    case["layout"] = data
    check(case, "no-horizontal-overflow", max(data["documentWidth"], data["bodyWidth"]) <= data["viewport"] + 1, **data)
    check(case, "horizontal-clipping-contract", data["htmlOverflow"] == "clip" and data["bodyOverflow"] == "clip")
    if case["screen"] == "chat":
        for key in ("composer", "send"):
            rect = data[key]
            check(case, key + "-inside-viewport", rect is not None and rect["x"] >= -1 and rect["right"] <= data["viewport"] + 1 and rect["bottom"] <= case["height"] + 1, rect=rect)
    else:
        rect = data["login"]
        check(case, "compact-centered-login", rect is not None and rect["width"] <= 480 and abs(rect["x"] + rect["width"] / 2 - data["viewport"] / 2) <= 32, rect=rect)


def login_checks(page, case):
    expect(page.locator("#login-view")).to_be_visible()
    expect(page.locator("#app-view")).to_be_hidden()
    for name in ("username", "password"):
        expect(page.locator("#" + name)).to_be_visible()
    check(case, "login-fields-preserved", all(page.locator("#" + name).count() == 1 for name in ("server-url", "username", "password")))
    check(case, "no-marketing-slogan", not any(text in page.locator("#login-view").inner_text() for text in ("让想法相遇", "让协作发生", "Super-agent", "Watchdog")))
    summary = page.locator("#connection-settings > summary")
    summary.focus()
    check(case, "connection-settings-keyboard-focus", summary.evaluate("element => element === document.activeElement"))


def chat_checks(page, case, expected_messages):
    expect(page.locator("#app-view")).to_be_visible()
    expect(page.locator("#login-view")).to_be_hidden()
    messages = page.locator("#message-items .message")
    expect(messages).to_have_count(expected_messages)
    case["message_text"] = page.locator("#message-items .message-text").all_text_contents()
    check(case, "same-demo-message-count", messages.count() == expected_messages, count=messages.count())
    check(case, "details-initially-collapsed", page.locator("#details-panel").is_hidden())
    timestamps = page.locator("#message-items .message-time")
    check(case, "every-message-retains-time", timestamps.count() == expected_messages, count=timestamps.count())
    first = timestamps.first
    first.focus()
    ring = first.evaluate("element => {const style=getComputedStyle(element); return {focused:element===document.activeElement,width:parseFloat(style.outlineWidth),style:style.outlineStyle};}")
    page.keyboard.press("Enter")
    opened = first.evaluate("element => element.closest('details').open")
    page.keyboard.press("Enter")
    check(case, "timestamp-keyboard-open-close", opened and not first.evaluate("element => element.closest('details').open"), focus=ring)
    check(case, "instant-visible-focus-ring", ring["focused"] and ring["width"] >= 2 and ring["style"] not in ("none", "hidden"), **ring)
    # Use an actual Tab move to activate :focus-visible, then inspect the paint
    # of the focused rail control rather than inferring it from a generic token.
    page.locator("#nav-chats").focus()
    page.keyboard.press("Tab")
    rail_ring = page.locator("#nav-members").evaluate("""element => {
      const style=getComputedStyle(element), rail=getComputedStyle(element.closest('.rail'));
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
      const context=canvas.getContext('2d', {willReadFrequently:true});
      function rgba(value) {context.clearRect(0,0,1,1); context.fillStyle=value; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data];}
      const token=getComputedStyle(document.documentElement).getPropertyValue('--rail-bg').trim();
      return {focused:element===document.activeElement, focusVisible:element.matches(':focus-visible'),
        width:parseFloat(style.outlineWidth), style:style.outlineStyle,
        outlineColor:style.outlineColor, foreground:rgba(style.outlineColor),
        railColor:rail.backgroundColor, background:rgba(rail.backgroundColor),
        railToken:token, railTokenValid:Boolean(token)&&CSS.supports('color',token), railTokenColor:rgba(token)};
    }""")
    rail_ratio = contrast(rail_ring["foreground"], rail_ring["background"])
    token_ratio = contrast(rail_ring["foreground"], rail_ring["railTokenColor"])
    check(case, "actual-rail-keyboard-focus-contrast", rail_ring["focused"] and rail_ring["focusVisible"]
          and rail_ring["width"] >= 2 and rail_ring["style"] not in ("none", "hidden")
          and rail_ring["railTokenValid"] and rail_ratio >= 3 and token_ratio >= 3,
          **rail_ring, ratio=round(rail_ratio, 3), rail_token_ratio=round(token_ratio, 3), minimum=3)
    toggle = page.locator("#attachment-toggle")
    toggle.focus()
    page.keyboard.press("Enter")
    for name in ("attach-file", "attach-image", "attach-media"):
        expect(page.locator("#" + name)).to_be_visible()
    page.keyboard.press("ArrowDown")
    first_attachment_focused = page.locator("#attach-file").evaluate("element => element === document.activeElement")
    page.keyboard.press("Escape")
    check(case, "single-attachment-menu-keyboard", first_attachment_focused and not page.locator("#attachment-menu").evaluate("element => element.open"))
    for control, title in (("nav-members", "成员"), ("nav-settings", "设置")):
        page.locator("#" + control).click()
        expect(page.locator("#modal")).to_be_visible()
        expect(page.locator("#modal h2")).to_have_text(title)
        check(case, control + "-opens-dialog", True)
        page.locator('#modal button[aria-label="关闭"]').click()
        expect(page.locator("#modal")).to_be_hidden()


def comparison_image(browser, images, output):
    if not all((images / f"{theme}-chat-1280.png").exists() for theme in THEMES):
        return False
    page = browser.new_page(viewport={"width": 1280, "height": 940}, device_scale_factor=1)
    try:
        page.set_content('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body><canvas id="sheet" width="1280" height="940"></canvas></body></html>')
        entries = [{"title": title, "data": "data:image/png;base64," + base64.b64encode((images / f"{theme}-chat-1280.png").read_bytes()).decode("ascii")} for theme, title in THEMES.items()]
        encoded = page.evaluate("""async entries => {
          const canvas=document.querySelector('#sheet'), context=canvas.getContext('2d');
          context.fillStyle='#e9edf2'; context.fillRect(0,0,1280,940);
          for(let i=0;i<entries.length;i++) { const image=new Image(); image.src=entries[i].data; await image.decode();
            const x=(i%2)*640, y=Math.floor(i/2)*470;
            context.fillStyle='#203044'; context.font='600 22px "Microsoft YaHei", sans-serif'; context.fillText(entries[i].title,x+18,y+28);
            context.drawImage(image,x,y+40,640,430);
          }
          return canvas.toDataURL('image/png').split(',')[1];
        }""", entries)
        output.write_bytes(base64.b64decode(encoded))
        return True
    finally:
        page.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:18310")
    parser.add_argument("--preview", type=Path, default=ROOT / "outputs/design-review-2026-11-10")
    parser.add_argument("--out", type=Path, default=ROOT / "environment/verification/design-review-2026-11-10")
    parser.add_argument("--round", choices=("initial", "confirm"), default="initial")
    parser.add_argument("--expected-messages", type=int, default=5)
    args = parser.parse_args()
    base = args.base.rstrip("/")
    parsed = urlsplit(base)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost") or parsed.path or parsed.query or parsed.fragment or parsed.username:
        parser.error("--base must be a plain local HTTP preview origin")
    preview, out = args.preview.resolve(), (args.out / args.round).resolve()
    if not preview.is_relative_to(ROOT / "outputs") or not out.is_relative_to(ROOT / "environment/verification"):
        parser.error("outputs must stay inside this project's preview and verification directories")
    if not 1 <= args.expected_messages <= 100:
        parser.error("--expected-messages must be between 1 and 100")
    images = preview / "images"
    out.mkdir(parents=True, exist_ok=True)
    images.mkdir(parents=True, exist_ok=True)
    report = {"date": datetime.now(timezone.utc).isoformat(), "round": args.round, "base": base,
              "source": "Copied current client plus synthetic offline preview fixture", "cases": [], "errors": [], "external_requests_blocked": []}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
        try:
            for theme in THEMES:
                for screen in ("chat", "login"):
                    for width, height in SIZES:
                        case = {"theme": theme, "screen": screen, "width": width, "height": height, "checks": []}
                        report["cases"].append(case)
                        context = browser.new_context(viewport={"width": width, "height": height}, device_scale_factor=1,
                                                      reduced_motion="reduce", locale="zh-CN", timezone_id="Asia/Shanghai")
                        page = context.new_page()
                        errors = []
                        page.on("pageerror", lambda error: errors.append(str(error)))
                        def guard(route):
                            request = urlsplit(route.request.url)
                            if request.scheme in ("data", "blob") or (request.scheme == parsed.scheme and request.netloc == parsed.netloc):
                                route.continue_()
                            else:
                                report["external_requests_blocked"].append(route.request.url)
                                route.abort("blockedbyclient")
                        context.route("**/*", guard)
                        try:
                            page.goto(base + "/screen.html?" + urlencode({"theme": theme, "screen": screen}), wait_until="load")
                            page.wait_for_function("window.__previewReady === true", timeout=15000)
                            page.evaluate("document.fonts.ready")
                            page.evaluate("document.activeElement?.blur()")
                            layout_checks(page, case)
                            assert_contrasts(page, case)
                            name = f"{theme}-{screen}-{width}.png"
                            page.screenshot(path=str(out / name), full_page=False, animations="disabled")
                            shutil.copy2(out / name, images / name)
                            case["screenshot"] = "images/" + name
                            if screen == "chat":
                                chat_checks(page, case, args.expected_messages)
                            else:
                                login_checks(page, case)
                        except Exception as error:
                            case["error"] = str(error)
                            report["errors"].append({"theme": theme, "screen": screen, "width": width, "error": str(error)})
                            page.screenshot(path=str(out / f"failure-{theme}-{screen}-{width}.png"), full_page=False, animations="disabled")
                        finally:
                            check(case, "no-page-errors", not errors, errors=errors)
                            case["passed"] = not case.get("error") and all(item["passed"] for item in case["checks"])
                            context.close()
            baseline = next((case.get("message_text") for case in report["cases"] if case.get("message_text")), None)
            for case in report["cases"]:
                if case["screen"] == "chat":
                    check(case, "identical-message-content-across-themes", baseline is not None and case.get("message_text") == baseline)
                    case["passed"] = case["passed"] and case["checks"][-1]["passed"]
            signatures = {case["theme"]: case.get("tokens", {}).get("--primary", {}).get("value") for case in report["cases"] if case["screen"] == "chat" and case["width"] == 1280}
            report["distinct_primary_colors"] = len(set(signatures.values())) == len(THEMES) and None not in signatures.values()
            report["theme_primary_colors"] = signatures
            report["comparison_image"] = comparison_image(browser, images, images / "comparison.png")
        finally:
            browser.close()
    report["passed"] = len(report["cases"]) == 16 and all(case["passed"] for case in report["cases"]) and not report["external_requests_blocked"] and report.get("distinct_primary_colors", False)
    report["checks"] = sum(len(case["checks"]) for case in report["cases"])
    report["failed_checks"] = [{"theme": case["theme"], "screen": case["screen"], "width": case["width"], **item} for case in report["cases"] for item in case["checks"] if not item["passed"]]
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"passed": report["passed"], "screens": len(report["cases"]), "checks": report["checks"],
                      "failed_checks": report["failed_checks"], "errors": report["errors"], "report": str(out / "report.json")}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
