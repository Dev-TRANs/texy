import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const MIN_TEXT_LENGTH = 400; // 自動判定時、これ未満ならReadabilityの結果を信用しない
const EXAMPLE_URL = "https://kumamoto.jyrac.stki.org";

const REMOVE_SELECTORS = [
  "script", "style", "noscript", "img", "picture",
  "video", "audio", "iframe", "svg", "link[rel='stylesheet']",
  "canvas", "object", "embed",
];

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // モードのプレフィックス判定: /readability/<url> or /raw-strip/<url> or /<url>(自動)
    let pathname = url.pathname;
    let forcedMode = null; // null = 自動(推奨)
    if (pathname.startsWith("/readability/")) {
      forcedMode = "readability";
      pathname = pathname.slice("/readability".length);
    } else if (pathname.startsWith("/raw-strip/")) {
      forcedMode = "raw-strip";
      pathname = pathname.slice("/raw-strip".length);
    }

    let raw = pathname.slice(1) + url.search;
    if (!raw) {
      return new Response(
        [
          "使い方:",
          "  https://proxy.stki.org/<対象URL>              … 自動判定(推奨)",
          "  https://proxy.stki.org/readability/<対象URL>  … 常にReadability(記事型ページ向け)",
          "  https://proxy.stki.org/raw-strip/<対象URL>    … 常に素ストリップ(ポータル/リンク集向け)",
          "",
          `例: https://proxy.stki.org/${EXAMPLE_URL}`,
        ].join("\n"),
        { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } }
      );
    }

    let target = raw;
    try {
      if (/^https?%3A/i.test(target)) target = decodeURIComponent(target);
    } catch (_) {}
    if (!/^https?:\/\//i.test(target)) target = "https://" + target;

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
      return new Response(`元サイトがエラーを返しました (status: ${res.status})`, {
        status: 502,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) {
      return new Response(res.body, { headers: { "Content-Type": contentType } });
    }

    const html = await res.text();

    // Readabilityを試す（forcedModeがraw-stripのときはスキップ）
    let article = null;
    if (forcedMode !== "raw-strip") {
      try {
        const { document: readerDoc } = parseHTML(html);
        const reader = new Readability(readerDoc);
        article = reader.parse();
      } catch (_) {
        article = null;
      }
    }

    const readabilityText = article && article.textContent ? article.textContent.trim() : "";
    const readabilityAvailable = !!(article && article.content && readabilityText.length > 0);
    const readabilityLength = readabilityText.length;

    let mode;
    if (forcedMode === "readability") {
      mode = readabilityAvailable ? "readability" : "raw-strip";
    } else if (forcedMode === "raw-strip") {
      mode = "raw-strip";
    } else {
      mode = readabilityAvailable && readabilityLength >= MIN_TEXT_LENGTH ? "readability" : "raw-strip";
    }

    // 内部リンクをプロキシ経由に書き換える際に使うプレフィックス
    // forcedModeがあれば同じモードを維持、無ければ自動判定(ルート)に流す
    const linkModePrefix =
      forcedMode === "readability" ? "readability/" : forcedMode === "raw-strip" ? "raw-strip/" : "";

    let bodyHtml, title;

    if (mode === "readability") {
      title = article.title || "text proxy";
      const { document: artDoc } = parseHTML(article.content);
      bodyHtml = finalizeFragment(artDoc, target, url.origin, linkModePrefix);
    } else {
      const { document: rawDoc } = parseHTML(html);
      title = rawDoc.title || "text proxy";
      bodyHtml = finalizeFragment(rawDoc, target, url.origin, linkModePrefix);
    }

    title = escapeHtml(title);

    // モード切り替えリンク（今見ているURL自体を別モードで開き直す）
    const linkFor = (prefix) => `${url.origin}${prefix}${raw}`;
    const nav = [
      { key: null, label: "自動(推奨)", href: linkFor("/") },
      { key: "readability", label: "readability", href: linkFor("/readability/") },
      { key: "raw-strip", label: "raw-strip", href: linkFor("/raw-strip/") },
    ]
      .map((item) =>
        item.key === forcedMode
          ? `<b>${item.label}</b>`
          : `<a href="${escapeHtml(item.href)}">${item.label}</a>`
      )
      .join(" | ");

    const outHtml = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 680px; margin: 0 auto; padding: 16px; line-height: 1.8; color: #222; word-wrap: break-word; }
  h1 { font-size: 1.3em; }
  a { color: #06c; }
  img, video, iframe { display: none; }
  .meta { color: #888; font-size: 0.8em; margin-bottom: 0.4em; }
  .nav { font-size: 0.85em; margin-bottom: 1em; }
</style>
</head>
<body>
<h1>${title}</h1>
<p class="meta">元URL: <a href="${escapeHtml(target)}">${escapeHtml(target)}</a>　/　表示モード: ${mode}</p>
<p class="nav">${nav}</p>
<hr>
${bodyHtml}
</body>
</html>`;

    return new Response(outHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

// フラグメント/ドキュメントから 画像等を除去 + リンクをプロキシ経由の絶対URLに書き換えて body.innerHTML を返す
function finalizeFragment(doc, baseUrl, origin, modePrefix) {
  REMOVE_SELECTORS.forEach((sel) => {
    doc.querySelectorAll(sel).forEach((el) => el.remove());
  });

  doc.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("style");
    [...(el.attributes || [])].forEach((attr) => {
      if (attr.name.toLowerCase().startsWith("on")) el.removeAttribute(attr.name);
    });
  });

  doc.querySelectorAll("a[href]").forEach((a) => {
    const href = a.getAttribute("href");
    if (!href) return;
    if (/^(#|mailto:|tel:|javascript:)/i.test(href)) return; // ページ内リンク・メール・電話はそのまま
    try {
      const abs = new URL(href, baseUrl).href;
      a.setAttribute("href", `${origin}/${modePrefix}${abs}`);
    } catch (_) {
      // 不正なURLはそのまま放置
    }
  });

  return doc.body ? doc.body.innerHTML : "";
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
