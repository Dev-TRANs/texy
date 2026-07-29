import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";

const MIN_TEXT_LENGTH = 400; // 自動判定時、これ未満ならReadabilityの結果を信用しない
const EXAMPLE_URL = "https://kumamoto.jyrac.stki.org";
const HTML_SIZE_LIMIT = 500_000; // これを超える巨大ページ(重いSVG図解等)ではReadability自体をスキップする

export default {
  async fetch(request) {
    const url = new URL(request.url);

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
    const tooLarge = html.length > HTML_SIZE_LIMIT;

    // 内部リンクをプロキシ経由に書き換える際に使うプレフィックス
    const linkModePrefix =
      forcedMode === "readability" ? "readability/" : forcedMode === "raw-strip" ? "raw-strip/" : "";

    // --- Readabilityを試す（重いページ・raw-strip強制時はスキップしてCPUを節約） ---
    let article = null;
    if (forcedMode !== "raw-strip" && !tooLarge) {
      try {
        const { document: readerDoc } = parseHTML(html);
        const reader = new Readability(readerDoc);
        article = reader.parse();
      } catch (_) {
        article = null;
      }
    }

    // article.content を正規表現ベースで軽量に処理(DOM再構築しない)
    let readabilityBodyHtml = null;
    let readabilityFinalLength = 0;
    if (article && article.content) {
      const candidateHtml = stripAndRewriteLinks(article.content, target, url.origin, linkModePrefix);
      const candidateText = candidateHtml.replace(/<[^>]+>/g, "").trim();
      readabilityFinalLength = candidateText.length;
      if (readabilityFinalLength > 0) {
        readabilityBodyHtml = candidateHtml;
      }
    }

    let mode;
    if (tooLarge) {
      mode = "raw-strip";
    } else if (forcedMode === "readability") {
      mode = readabilityBodyHtml ? "readability" : "raw-strip";
    } else if (forcedMode === "raw-strip") {
      mode = "raw-strip";
    } else {
      mode = readabilityBodyHtml && readabilityFinalLength >= MIN_TEXT_LENGTH ? "readability" : "raw-strip";
    }

    let bodyHtml, title;

    if (mode === "readability") {
      title = article.title || "text proxy";
      bodyHtml = readabilityBodyHtml;
    } else {
      // raw-strip: DOMを組まず、正規表現でbody部分だけ抜き出して軽量処理
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? decodeEntities(titleMatch[1].trim()) : "text proxy";

      const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const bodySrc = bodyMatch ? bodyMatch[1] : html;
      bodyHtml = stripAndRewriteLinks(bodySrc, target, url.origin, linkModePrefix);
    }

    title = escapeHtml(title);

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

    const sizeNote = tooLarge
      ? `<p class="meta">※元ページが大きすぎたため(${Math.round(html.length / 1000)}KB)、Readability解析をスキップしています</p>`
      : "";

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
${sizeNote}
<hr>
${bodyHtml}
</body>
</html>`;

    return new Response(outHtml, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
};

// HTML断片を文字列のまま軽量処理: 重い/不要なタグを除去し、<a href>をプロキシ経由の絶対URLに書き換える
// (linkedomでDOMを組まないので、巨大なSVG等が含まれていてもCPUコストを低く抑えられる)
function stripAndRewriteLinks(htmlFragment, baseUrl, origin, modePrefix) {
  let out = htmlFragment
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    .replace(/<svg[\s\S]*?<\/svg>/gi, "")
    .replace(/<canvas[\s\S]*?<\/canvas>/gi, "")
    .replace(/<video[\s\S]*?<\/video>/gi, "")
    .replace(/<audio[\s\S]*?<\/audio>/gi, "")
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, "")
    .replace(/<picture[\s\S]*?<\/picture>/gi, "")
    .replace(/<object[\s\S]*?<\/object>/gi, "")
    .replace(/<embed[^>]*>/gi, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/<link[^>]*rel=["']?stylesheet["']?[^>]*>/gi, "")
    .replace(/\s(style|on\w+)="[^"]*"/gi, "")
    .replace(/\s(style|on\w+)='[^']*'/gi, "");

  out = out.replace(/(<a\b[^>]*\bhref=)(["'])(.*?)\2/gi, (m, pre, quote, href) => {
    if (!href || /^(#|mailto:|tel:|javascript:)/i.test(href)) return m;
    try {
      const abs = new URL(href, baseUrl).href;
      return `${pre}${quote}${origin}/${modePrefix}${abs}${quote}`;
    } catch (_) {
      return m;
    }
  });

  return out;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function escapeHtml(s) {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
