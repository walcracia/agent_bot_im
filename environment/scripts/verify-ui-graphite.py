"""Verify the selected graphite UI against an isolated real IM server and Chrome.

Uses temporary users, HTTP, WebSocket and SQLite through the existing UI fixture.
It does not load a production configuration, connect DSH or call any model.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path

import httpx
from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT / "environment/verification/ui-graphite-v0.1.4"
SIZES = ((1280, 860), (960, 680))


def load_theme_helpers():
    path = ROOT / "environment/scripts/verify-ui-theme.py"
    spec = importlib.util.spec_from_file_location("graphite_color_helpers", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


COLORS = load_theme_helpers()


def css(page, selector, prop):
    return page.locator(selector).first.evaluate(
        "(element, property) => getComputedStyle(element).getPropertyValue(property).trim()", prop
    )


def effective_background(page, selector):
    return page.locator(selector).first.evaluate("""element => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', {willReadFrequently:true});
        const parents = []; for(let node=element;node;node=node.parentElement) parents.unshift(node);
        context.fillStyle='white'; context.fillRect(0,0,1,1);
        for(const node of parents) { context.fillStyle=getComputedStyle(node).backgroundColor; context.fillRect(0,0,1,1); }
        const rgba=context.getImageData(0,0,1,1).data;
        return `rgb(${rgba[0]}, ${rgba[1]}, ${rgba[2]})`;
    }""")


def check(report, name, passed, **details):
    report["checks"].append({"name": name, "passed": bool(passed), **details})
    assert passed, name


def pair(report, page, name, selector, minimum=4.5, foreground="color", background_selector=None):
    first = css(page, selector, foreground)
    second = effective_background(page, background_selector or selector)
    ratio = COLORS.contrast(first, second)
    report["contrast"].append({"pair": name, "foreground": COLORS.to_hex(first),
                               "background": COLORS.to_hex(second), "ratio": round(ratio, 3),
                               "minimum": minimum, "passed": ratio >= minimum})
    assert ratio >= minimum, f"{name}: {ratio:.3f}:1 is below {minimum}:1"


def dark_surfaces(report, page, name):
    # A saturated primary control is a signal. This checks bright neutral CSS
    # surfaces, not the pixels of user images, media or the existing brand mark.
    bright = page.evaluate("""() => {
      const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      const linear=c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4;
      const result=[];
      for(const element of document.querySelectorAll('body *')){
        if(element.closest('svg')||['IMG','VIDEO','CANVAS'].includes(element.tagName))continue;
        const r=element.getBoundingClientRect(),style=getComputedStyle(element);
        if(r.width*r.height<500||r.width<24||r.height<16||r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight||style.visibility==='hidden'||style.display==='none')continue;
        if(!element.checkVisibility({checkVisibilityCSS:true,checkOpacity:true}))continue;
        context.clearRect(0,0,1,1);context.fillStyle=style.backgroundColor;context.fillRect(0,0,1,1);
        const d=context.getImageData(0,0,1,1).data;if(d[3]<230)continue;
        const lum=.2126*linear(d[0]/255)+.7152*linear(d[1]/255)+.0722*linear(d[2]/255);
        if(lum>.8)result.push({tag:element.tagName,id:element.id,className:String(element.className),color:style.backgroundColor});
      }return result;
    }""")
    check(report, name + " has no bright-white neutral surface", not bright, findings=bright)


def icon_signature(page, selector):
    return page.locator(selector).evaluate("""svg => ({
      viewBox:svg.getAttribute('viewBox'),content:svg.innerHTML,
      strokeWidth:getComputedStyle(svg).strokeWidth,
      paths:[...svg.querySelectorAll('path,circle')].map(node=>{const b=node.getBBox();return {tag:node.tagName,x:b.x,y:b.y,width:b.width,height:b.height};})
    })""")


def run(output, round_name):
    directory = output / round_name
    directory.mkdir(parents=True, exist_ok=True)
    report = {"version": "0.1.4", "product_version": "0.3.1", "round": round_name,
              "scope": "Temporary real HTTP/WebSocket/SQLite accounts and Chrome; no production data or model calls",
              "status": "running", "checks": [], "contrast": [], "screenshots": [], "page_errors": []}
    runner = COLORS.load_ui_runner()
    try:
        with runner.isolated_server() as (base, accounts, _store):
            with httpx.Client(base_url=base, timeout=30, trust_env=False) as api:
                admin_token = runner.response_json(api.post("/api/login", json={
                    "username": accounts["admin"]["username"], "password": accounts["admin"]["password"]}))["token"]
                alice_token = runner.response_json(api.post("/api/login", json={
                    "username": accounts["alice"]["username"], "password": accounts["alice"]["password"]}))["token"]
                api.headers["Authorization"] = "Bearer " + admin_token
                conversation = runner.response_json(api.post("/api/conversations", json={
                    "title": "石墨主题验收", "member_ids": [accounts["alice"]["user"]["id"],
                    accounts["bob"]["user"]["id"], accounts["dsh"]["user"]["id"]], "is_direct": False}))
                runner.response_json(api.post(f"/api/conversations/{conversation['id']}/messages", json={
                    "text": "设置图标和登录入口使用同一个规则齿轮。", "client_id": "graphite-admin"}))
                with httpx.Client(base_url=base, timeout=30, trust_env=False,
                                  headers={"Authorization": "Bearer " + alice_token}) as other:
                    runner.response_json(other.post(f"/api/conversations/{conversation['id']}/messages", json={
                        "text": "石墨主题下，文字和菜单都应清楚。", "client_id": "graphite-alice"}))

            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(channel="chrome", headless=True)
                try:
                    context = browser.new_context(viewport={"width": 1280, "height": 860},
                                                  timezone_id="Asia/Shanghai", reduced_motion="reduce")
                    page = context.new_page()
                    page.on("pageerror", lambda error: report["page_errors"].append(str(error)))

                    def shot(name):
                        page.screenshot(path=str(directory / name))
                        report["screenshots"].append(name)

                    def viewport_checks(name):
                        check(report, name + " horizontal bounds", page.evaluate("document.documentElement.scrollWidth <= innerWidth"))

                    page.goto(base)
                    expect(page.locator("#login-view")).to_be_visible()
                    login_icon = icon_signature(page, "#connection-settings summary svg")
                    check(report, "Login settings glyph has the shared 24px viewBox", login_icon["viewBox"] == "0 0 24 24")
                    check(report, "Login settings control retains accessible name", page.locator("#connection-settings summary").get_attribute("aria-label") == "连接设置")
                    check(report, "Glyph strokes stay inside the icon grid", all(
                        item["x"] >= 0 and item["y"] >= 0 and item["x"] + item["width"] <= 24 and item["y"] + item["height"] <= 24
                        for item in login_icon["paths"]))
                    check(report, "Shared SVG stroke width remains 1.6px", abs(float(login_icon["strokeWidth"].removesuffix("px")) - 1.6) < 0.01)
                    page.locator("#connection-settings summary").focus()
                    if page.locator("#connection-settings").get_attribute("open") is not None:
                        page.locator("#connection-settings summary").press("Enter")
                    expect(page.locator("#server-url")).to_be_hidden()
                    check(report, "Compact login has no promotional panel", page.locator(".login-panel").count() == 1 and
                          page.locator(".login-aside,.login-slogan,.login-hero").count() == 0)
                    for width, height in SIZES:
                        page.set_viewport_size({"width": width, "height": height})
                        expect(page.locator("#login-submit")).to_be_in_viewport()
                        viewport_checks(f"Login {width}")
                        dark_surfaces(report, page, f"Login {width}")
                        shot(f"login-{width}.png")
                    pair(report, page, "Login primary text", "#login-submit")
                    pair(report, page, "Login label", "label[for='username']")
                    pair(report, page, "Login field edge", ".input-icon", 3, "border-top-color")
                    placeholder = page.locator("#username").evaluate("e=>getComputedStyle(e,'::placeholder').color")
                    ratio = COLORS.contrast(placeholder, effective_background(page, ".input-icon"))
                    report["contrast"].append({"pair": "Login placeholder", "ratio": round(ratio, 3), "minimum": 4.5, "passed": ratio >= 4.5})
                    assert ratio >= 4.5
                    page.locator("#username").fill(accounts["admin"]["username"])
                    page.locator("#password").fill("not-the-random-fixture-password")
                    page.locator("#login-submit").click()
                    expect(page.locator("#login-error")).to_be_visible()
                    pair(report, page, "Login error recovery", "#login-error")
                    dark_surfaces(report, page, "Login error")

                    runner.login(page, base, accounts["admin"])
                    expect(page.locator("#conversation-list .conversation")).to_have_count(1, timeout=15000)
                    unread = page.locator("#conversation-list .unread").first
                    expect(unread).to_be_visible(timeout=15000)
                    pair(report, page, "Unread number", "#conversation-list .unread")
                    nav_icon = icon_signature(page, "#nav-settings svg")
                    check(report, "Login and nav settings share identical paths", nav_icon == login_icon)
                    check(report, "Nav settings preserves title and aria-label", page.locator("#nav-settings").get_attribute("title") == "设置" and
                          page.locator("#nav-settings").get_attribute("aria-label") == "设置")
                    page.locator("#conversation-list .conversation").first.click()
                    expect(page.locator("#chat-title")).to_have_text("石墨主题验收")
                    expect(page.locator("#message-items .message")).to_have_count(2, timeout=15000)
                    expect(page.locator("#details-panel")).to_be_hidden()
                    check(report, "Details stay collapsed initially", not page.locator("#details-panel").is_visible())
                    pair(report, page, "Chat own-message text", ".message.own .bubble")
                    pair(report, page, "Chat incoming-message text", ".message:not(.own) .bubble")
                    pair(report, page, "Message author", ".message-author")
                    pair(report, page, "Conversation secondary", ".conversation-time")
                    pair(report, page, "Composer field edge", "#message-input", 3, "border-top-color")
                    pair(report, page, "Composer primary text/icon", "#send-message", 4.5)
                    page.locator("#nav-chats").focus()
                    page.keyboard.press("Tab")
                    expect(page.locator("#nav-members")).to_be_focused()
                    pair(report, page, "Rail keyboard focus", "#nav-members", 3, "outline-color", ".rail")
                    ring = page.locator("#nav-members").evaluate("e=>{const c=getComputedStyle(e);return {width:parseFloat(c.outlineWidth),style:c.outlineStyle}}")
                    check(report, "Rail keyboard ring is visible", ring["width"] >= 2 and ring["style"] not in ("none", "hidden"), **ring)
                    first_time = page.locator(".message-time").first
                    first_time.focus(); first_time.press("Enter")
                    expect(first_time.locator("..")).to_have_attribute("open", "")
                    first_time.press("Enter")
                    check(report, "Message time remains keyboard-toggleable", first_time.locator("..").get_attribute("open") is None)
                    page.evaluate("document.activeElement.blur()")

                    for width, height in SIZES:
                        page.set_viewport_size({"width": width, "height": height})
                        expect(page.locator("#message-input")).to_be_in_viewport()
                        expect(page.locator("#send-message")).to_be_in_viewport()
                        viewport_checks(f"Chat {width}")
                        dark_surfaces(report, page, f"Chat {width}")
                        shot(f"chat-{width}.png")
                        page.locator("#attachment-toggle").click()
                        expect(page.locator("#attach-file")).to_be_visible()
                        pair(report, page, f"Attachment menu {width}", "#attach-file")
                        dark_surfaces(report, page, f"Attachment menu {width}")
                        shot(f"attachment-menu-{width}.png")
                        page.locator("#attachment-toggle").press("Escape")
                        expect(page.locator("#attach-file")).to_be_hidden()
                        page.locator("#nav-members").click()
                        expect(page.locator("#modal h2")).to_have_text("成员")
                        pair(report, page, f"Member name {width}", ".directory-item-copy strong")
                        pair(report, page, f"Member secondary {width}", ".directory-item-copy small")
                        pair(report, page, f"Member primary action {width}", "#modal .primary")
                        dark_surfaces(report, page, f"Members {width}")
                        shot(f"members-{width}.png")
                        page.get_by_role("button", name="关闭", exact=True).click()
                        page.locator("#nav-settings").click()
                        expect(page.locator("#modal h2")).to_have_text("设置")
                        pair(report, page, f"Settings heading {width}", "#modal h2")
                        pair(report, page, f"Settings metadata {width}", ".settings-row span")
                        pair(report, page, f"Settings action {width}", ".settings-action")
                        pair(report, page, f"Settings primary action {width}", "#modal .primary")
                        dark_surfaces(report, page, f"Settings {width}")
                        shot(f"settings-{width}.png")
                        page.get_by_role("button", name="完成", exact=True).click()
                    check(report, "No browser page errors", not report["page_errors"])
                finally:
                    browser.close()
        check(report, "Owned isolated server and temporary database closed", True)
        report["status"] = "passed"
    except Exception as error:
        report["status"] = "failed"
        report["failure_type"] = type(error).__name__
        report["failure"] = str(error)
        raise
    finally:
        (directory / "theme-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "screenshots": len(report["screenshots"]),
                          "checks": len(report["checks"]), "contrast_pairs": len(report["contrast"]),
                          "failure": report.get("failure"), "report": str(directory / "theme-report.json")}, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--round", choices=("initial", "confirm"), default="initial")
    arguments = parser.parse_args()
    run(arguments.output_dir.resolve(), arguments.round)
