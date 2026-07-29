import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // "/https://example.com/page" or "/https%3A%2F%2Fexample.com%2Fpage" どちらにも対応
    let raw = url.pathname.slice(1) + url.search;
    if (!raw) {
      return new Response(
        "使い方: https://proxy.stki.org/<対象URL>\n例: https://proxy.stki.org/https://www.yahoo.co.jp/xxx/yyy",
        { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    let target = raw;
    try {
      // encodeURIComponentされたURLだった場合はデコードしておく
      if (/^https?%3A/i.test(target)) target = decodeURIComponent(target);
    } catch (_) {}

    if (!/^https?:\/\//i.test(target)) {
      target = "https://" + target;
    }

    let res;
    try {
      res = await fetch(target, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (compatible; TextProxy/1.0; +https://proxy.stki.org)",
        },
        redirect: "follow",
      });
    } catch (e) {
      return new Response("元サイトへの取得に失敗しました: " + e.message, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (!res.ok) {
      return new Response(
        `元サイトがエラーを返しました (status: ${res.status})`,
        { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) {
      // 画像やPDFなど、HTML以外はそのまま素通しする
      return new Response(res.body, {
        headers: { "Content-Type": contentType },
      });
    }

    const html = await res.text();
    const { document } = parseHTML(html);

    let article = null;
    try {
      const reader = new Readability(document);
      article = reader.parse();
    } catch (_) {
      article = null;
    }

    if (!article || !article.content) {
      return new Response(
        "本文の抽出に失敗しました。JavaScriptで描画されるサイト(SPA)の可能性があります。\n\n元URL: " +
          target,
        { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    const stripped = article.content
      .replace(/<img[^>]*>/gi, "")
      .replace(/<picture[\s\S]*?<\/picture>/gi, "")
      .replace(/<video[\s\S]*?<\/video>/gi, "")
      .replace(/<audio[\s\S]*?<\/audio>/gi, "")
      .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
      .replace(/<svg[\s\S]*?<\/svg>/gi, "");

    const title = escapeHtml(article.title || "text proxy");
    const outHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 640px; margin: 0 auto; padding: 16px; line-height: 1.8; color: #222; word-wrap: break-word; }
  h1 { font-size: 1.3em; }
  a { color: #06c; }
  img, video, iframe { display: none; }
  .meta { color: #888; font-size: 0.8em; margin-bottom: 1em; }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="meta">元URL: <a href="${target}">${escapeHtml(target)}</a></p>
<hr>
${stripped}
</body>
</html>`;

    return new Response(outHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  },
};

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
