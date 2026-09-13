# Frontend visual verification

Produced by `dshcli verify-frontend` against the DeepSeek Harness browser UI, and independently
confirmed by inspecting the captured raster directly.

## Command

```sh
dsh web --port 0 --no-open
# dsh web: http://127.0.0.1:52907/?token=<redacted>

dshcli verify-frontend "http://127.0.0.1:52907/?token=<redacted>" --shot artifacts/dsh-web-ui.png
```

`dshcli` harvested the session cookie from the printed token URL before navigating, so the
authenticated application was reviewed rather than the authentication notice.

## Capture facts

| Field | Value |
|---|---|
| Target | `http://127.0.0.1:52907/` |
| Document title | `DeepSeek Harness` |
| Raster | `dsh-web-ui.png`, 1280x800, 50,893 bytes |
| Browser console errors | none |
| Vision route | `deepseek-official/deepseek-v4-flash-vision-exp` |
| Turn outcome | `completed` (9.7 s) |

## Model report

**1. VERDICT — RENDERS.** The page paints fully with a left workspace sidebar and a centered
empty-session composer in the main pane; a console error list of "none" and complete chrome support
a healthy initial render, not a broken or blank page.

**2. WHAT IS VISIBLE**

- Left sidebar (~280px, light grey, full height): a "deepseek HARNESS" wordmark with logo and a
  sidebar-collapse icon at top-right of the header; a bordered "新会话" (new session) button; a "工作区"
  (workspace) section label with three right-aligned icons (search, list/queue, refresh). Below it a
  vertical file/folder tree: dshcli, 机顶盒 (with a nested, highlighted 新会话 entry and a subtitle line
  华为悦盒Ubuntu刷机方案… 21分钟), then c, metric3d v2, 代码, cloudflared, word_lib, packs, 1.33寸TFT单屏和模块,
  智能单词记忆系统, 魔方 2, autoglm-rs, Desktop, and a partially visible next row. A pinned 设置 (Settings)
  row with a gear icon sits at the very bottom.
- Main pane (white, otherwise empty): a centered brand block — DeepSeek whale logo plus 探索未至之境
  with a small blue 预览版 (preview) badge. Under it a control row: 机顶盒 project selector with a folder
  icon and chevron, and 标准模式 mode selector with an icon. Then a large rounded input card containing
  the placeholder line 描述你想要构建的内容。/ 调用指令，@ 文件或对话, and a footer row inside the card: + button,
  a paperclip/context icon, 完全权限 (full permissions) dropdown, and on the right DeepSeek-V4-Flash High
  with a chevron plus a circular blue send/arrow button (appears disabled/dimmed).
- Navigation: only the sidebar list and the two dropdown controls are present; there is no top
  bar, tab strip, or breadcrumb.

**3. VISIBLE DEFECTS**

- Clipping: the workspace list is cut off at the bottom — the row after Desktop is only half-painted
  (a truncated fragment of its icon/label is visible above the pinned 设置 row), so the scroll
  container clips a list item mid-row rather than ending on a clean boundary.
- Placeholder/empty-state content: the composer text is placeholder copy and the main pane is almost
  entirely blank white — expected for a new session, but it is placeholder text rather than real data.
- No overlap of elements, no unreadable contrast, no missing image icons (the brand logo and all
  sidebar icons render), no error banner.

**4. UNVERIFIABLE** — interaction, dropdown contents, composer behaviour, sidebar interactivity,
loading states, and any conversation data. A static screenshot cannot show these.

---

## Second target: a local fixture page

`fixtures/sample-dashboard.html` was verified by the same command to confirm the generic path
(local file, no authentication, no server):

| Field | Value |
|---|---|
| Document title | `dshcli fixture — sample dashboard` |
| Raster | `fixture-dashboard.png`, 1280x800, 31,513 bytes |
| Browser console errors | none |
| Verdict | **RENDERS** — header, three metric cards, and the services table present, aligned, legible |
| Defects | none structural; two presentation notes about inconsistent delta formatting and an
  uncoloured status column, reported as deliberate fixture styling rather than rendering faults |
